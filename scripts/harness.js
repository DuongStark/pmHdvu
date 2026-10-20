import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
const root = fileURLToPath(new URL("../", import.meta.url));
export const children = new Set();
export async function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
export function startService(service, env) {
  return new Promise((resolve, reject) => {
    const child = fork(`${root}src/${service}/server.js`, [], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        DELAY_MS: "0",
        FAIL_RATE: "0",
        DROP_RATE: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    let logs = "";
    let done = false;
    const timer = setTimeout(
      () => fail(new Error(`${service} startup timed out: ${logs}`)),
      5000,
    );
    const fail = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void stopService(child);
      reject(error);
    };
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        logs = (logs + chunk).slice(-8000);
      });
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      fail(new Error(`${service} exited (${code ?? signal}): ${logs}`)),
    );
    child.on("message", (message) => {
      if (message.type === "ready" && !done) {
        done = true;
        clearTimeout(timer);
        resolve({
          child,
          url: `http://127.0.0.1:${message.port}`,
          port: message.port,
        });
      }
    });
  });
}
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export function createRequester(maxSockets = 20) {
  // Fee's server may close idle sockets around the six-second boundary.
  // Retire our monitoring/load sockets earlier, without retrying POSTs.
  const agent = new http.Agent({ keepAlive: true, maxSockets, timeout: 4500 });
  let connections = 0;
  return {
    get connections() {
      return connections;
    },
    close() {
      agent.destroy();
    },
    request(url, body) {
      const start = performance.now();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(
          url,
          {
            method: payload ? "POST" : "GET",
            agent,
            headers: payload
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }
              : {},
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("error", reject);
            res.on("end", () => {
              clearTimeout(timer);
              try {
                resolve({
                  code: res.statusCode,
                  body: JSON.parse(data),
                  durationMs: performance.now() - start,
                });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on("socket", (socket) => {
          if (socket.connecting) socket.once("connect", () => connections++);
        });
        const timer = setTimeout(
          () => req.destroy(new Error("Benchmark request timed out")),
          10000,
        );
        req.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        req.end(payload);
      });
    },
  };
}
