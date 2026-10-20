import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { setTimeout as delay } from "node:timers/promises";

const pending = (error) => ({ kind: "pending", error });
const failed = (httpStatus, error) => ({ kind: "failed", httpStatus, error });
const lookup = (hostname, options, callback) =>
  dns.lookup(hostname, { ...options, verbatim: false }, callback);

export function createBankClient({
  bankUrl = "http://localhost:4002",
  mode = "resilient",
} = {}) {
  const base = new URL(bankUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error(
      "BANK_URL must be an HTTP(S) origin without credentials, path or query",
    );
  if (!["baseline", "resilient"].includes(mode))
    throw new Error("CLIENT_MODE must be baseline or resilient");
  const transport = base.protocol === "https:" ? https : http;
  const agent = new transport.Agent({
    keepAlive: mode === "resilient",
    maxSockets: 10,
    maxFreeSockets: 10,
    lookup,
  });
  const target = new URL("/charges", base);
  const active = new Set();
  let closed = false;

  function attempt(payment, remainingMs) {
    return new Promise((resolve) => {
      let settled = false;
      let connected = false;
      let connectTimer;
      let deadlineTimer;
      let req;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(deadlineTimer);
        active.delete(req);
        resolve(result);
      };
      const body = JSON.stringify({
        reference: payment.reference,
        amount: payment.amount,
      });
      req = transport.request(
        target,
        {
          method: "POST",
          agent,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "Idempotency-Key": payment.idempotencyKey,
          },
        },
        (res) => {
          let body = "";
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 16_384) {
              finish({
                type: "uncertain",
                error: "Bank response is too large",
              });
              req.destroy();
            } else body += chunk;
          });
          res.on("end", () => {
            if (settled) return;
            let data;
            try {
              data = JSON.parse(body);
            } catch {
              data = null;
            }
            if (
              res.statusCode === 201 &&
              typeof data?.chargeId === "string" &&
              data.chargeId.length > 0 &&
              data.chargeId.length <= 128
            )
              return finish({ type: "paid", chargeId: data.chargeId });
            if (res.statusCode >= 400 && res.statusCode < 500)
              return finish({
                type: "refused",
                httpStatus: res.statusCode,
                error:
                  typeof data?.error === "string"
                    ? data.error.slice(0, 256)
                    : "Bank rejected payment",
              });
            if (res.statusCode === 500)
              return finish({
                type: "temporary",
                error: "Temporary bank failure before charge",
              });
            finish({ type: "uncertain", error: "Unrecognized bank response" });
          });
          res.on("error", () =>
            finish({
              type: "uncertain",
              error: "Bank disconnected before completing its response",
            }),
          );
          res.on("aborted", () =>
            finish({
              type: "uncertain",
              error: "Bank disconnected before completing its response",
            }),
          );
        },
      );
      active.add(req);
      req.on("socket", (socket) => {
        if (settled) return;
        if (!socket.connecting) {
          connected = true;
          return;
        }
        connectTimer = setTimeout(
          () => {
            finish({ type: "unavailable", error: "Cannot connect to bank" });
            req.destroy();
          },
          Math.min(700, remainingMs),
        );
        socket.once("connect", () => {
          connected = true;
          clearTimeout(connectTimer);
        });
      });
      req.on("error", () =>
        finish({
          type: connected ? "uncertain" : "unavailable",
          error: connected
            ? "Bank connection lost; charge outcome unknown"
            : "Cannot connect to bank",
        }),
      );
      // An explicit wall-clock timer covers DNS, pool queue and the entire response.
      deadlineTimer = setTimeout(
        () => {
          finish({
            type: "timeout",
            error: "Bank deadline exceeded; charge outcome unknown",
          });
          req.destroy();
        },
        Math.max(1, remainingMs),
      );
      req.end(body);
    });
  }
  return {
    async charge(payment) {
      if (closed) return failed(503, "Bank client is closed");
      const deadline = performance.now() + 4000;
      let uncertain = false;
      let lastError = "Bank unavailable";
      const attempts = mode === "baseline" ? 1 : 3;
      for (let i = 0; i < attempts; i++) {
        if (closed)
          return uncertain
            ? pending("Bank client closed before outcome was confirmed")
            : failed(503, "Bank client is closed");
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          return pending("Bank deadline exceeded; charge outcome unknown");
        const result = await attempt(payment, remaining);
        if (result.type === "paid")
          return { kind: "paid", chargeId: result.chargeId };
        lastError = result.error;
        if (result.type === "timeout") return pending(lastError);
        if (result.type === "uncertain") uncertain = true;
        if (result.type === "refused")
          return uncertain
            ? pending(lastError)
            : failed(result.httpStatus, lastError);
        // New requests recover on their own once the bank comes back; no startup connection is required.
        if (result.type === "unavailable")
          return uncertain ? pending(lastError) : failed(503, lastError);
        if (i + 1 < attempts) {
          const waitMs = (i + 1) * 100;
          if (deadline - performance.now() <= waitMs)
            return uncertain ? pending(lastError) : failed(503, lastError);
          await delay(waitMs);
        }
      }
      return uncertain ? pending(lastError) : failed(503, lastError);
    },
    close() {
      closed = true;
      for (const req of active) req.destroy();
      agent.destroy();
    },
  };
}
