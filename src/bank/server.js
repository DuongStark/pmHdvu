import express from "express";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createBankStore } from "./store.js";

export function readBankConfig(env = process.env) {
  const number = (name, fallback, max, integer = false) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > max ||
      (integer && !Number.isSafeInteger(value)) ||
      env[name] === ""
    )
      throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    delayMs: number("DELAY_MS", 0, 2_147_483_647, true),
    failRate: number("FAIL_RATE", 0, 1),
    dropRate: number("DROP_RATE", 0, 1),
  };
}
export function createBankServer({
  delayMs = 0,
  failRate = 0,
  dropRate = 0,
  random = Math.random,
  logger = console.log,
} = {}) {
  const store = createBankStore();
  const app = express();
  app.disable("x-powered-by");
  app.use("/charges", (req, res, next) => {
    if (req.method === "POST") store.request();
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/stats", (req, res) => res.json(store.stats()));
  app.post("/charges", (req, res) => {
    const { reference, amount } = req.body ?? {};
    const key = req.get("Idempotency-Key");
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      typeof reference !== "string" ||
      !reference.trim() ||
      reference.length > 128 ||
      !key ||
      key.length > 128
    )
      return res
        .status(400)
        .json({
          error:
            "Positive integer amount, reference and Idempotency-Key are required",
        });
    const payload = { reference, amount };
    const send = (result) => res.status(result.httpStatus).json(result.body);
    const cached = store.lookup(key, payload);
    if (cached) return send(cached);
    if (amount > 20_000_000)
      return res.status(402).json({ error: "Bank limit is 20000000 VND" });
    const processCharge = () => {
      // Another request may have completed while this request was delayed.
      const replay = store.lookup(key, payload);
      if (replay) return send(replay);
      if (random() < failRate)
        return res
          .status(500)
          .json({ error: "Temporary bank failure before charge" });
      const result = store.charge(key, payload);
      if (random() < dropRate) return res.socket.destroy();
      send(result);
    };
    if (!delayMs) return processCharge();
    const timer = setTimeout(processCharge, delayMs);
    // No background processing/reconciliation is promised by this simulator.
    res.once("close", () => clearTimeout(timer));
  });
  app.use((err, req, res, next) =>
    res
      .status(err.type === "entity.too.large" ? 413 : 400)
      .json({ error: "Invalid JSON request" }),
  );
  const server = http.createServer(app);
  server.keepAliveTimeout = 5000;
  if ("keepAliveTimeoutBuffer" in server) server.keepAliveTimeoutBuffer = 0;
  server.on("connection", (socket) => {
    store.connection();
    logger(
      `[bank] TCP connection ${socket.remoteAddress}:${socket.remotePort}`,
    );
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createBankServer(readBankConfig());
  server.listen(
    Number(process.env.PORT ?? 4002),
    process.env.HOST ?? "127.0.0.1",
    () => {
      console.log("[bank] ready", server.address());
      process.send?.({ type: "ready", port: server.address().port });
    },
  );
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
