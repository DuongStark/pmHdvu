import express from "express";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createFeeStore } from "./store.js";
import { createBankClient } from "./bank-client.js";

export function createFeeServer({
  store = createFeeStore(),
  bankClient = createBankClient(),
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/students/:id/fees", (req, res) => {
    try {
      res.json(store.getFees(req.params.id));
    } catch (e) {
      res
        .status(e.httpStatus ?? 500)
        .json({ error: e.httpStatus ? e.message : "Internal error" });
    }
  });
  app.post("/students/:id/payments", async (req, res) => {
    let payment;
    try {
      payment = store.createPayment(req.params.id, req.body?.amount);
    } catch (e) {
      return res
        .status(e.httpStatus ?? 400)
        .json({
          error: e.message,
          paymentId: e.paymentId ?? store.nextPaymentId(),
          status: "FAILED",
        });
    }
    let result;
    try {
      result = await bankClient.charge({
        reference: payment.paymentId,
        amount: payment.amount,
        idempotencyKey: payment.idempotencyKey,
      });
    } catch {
      result = {
        kind: "pending",
        error: "Bank outcome could not be confirmed",
      };
    }
    if (result.kind === "paid") {
      store.markPaid(payment.paymentId, result.chargeId);
      return res
        .status(201)
        .json({
          paymentId: payment.paymentId,
          status: "PAID",
          chargeId: result.chargeId,
        });
    }
    if (result.kind === "failed") {
      store.markFailed(payment.paymentId);
      return res
        .status(result.httpStatus)
        .json({
          error: result.error,
          paymentId: payment.paymentId,
          status: "FAILED",
        });
    }
    store.markPending(payment.paymentId);
    res
      .status(504)
      .json({
        error: result.error,
        paymentId: payment.paymentId,
        status: "PENDING",
      });
  });
  app.use((req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((err, req, res, next) =>
    res
      .status(err.type === "entity.too.large" ? 413 : 400)
      .json({
        error: "Invalid JSON request",
        paymentId: store.nextPaymentId(),
        status: "FAILED",
      }),
  );
  return http.createServer(app);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const bankClient = createBankClient({
    bankUrl: process.env.BANK_URL ?? "http://localhost:4002",
    mode: process.env.CLIENT_MODE ?? "resilient",
  });
  const server = createFeeServer({ bankClient });
  server.listen(
    Number(process.env.PORT ?? 4001),
    process.env.HOST ?? "127.0.0.1",
    () => {
      console.log("[fee] ready", server.address());
      process.send?.({ type: "ready", port: server.address().port });
    },
  );
  const shutdown = () => {
    bankClient.close();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
