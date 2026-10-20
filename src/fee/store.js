import { randomUUID } from "node:crypto";
export function createFeeStore() {
  const debts = new Map([
    ["1", 50_000_000],
    ["2", 0],
    ["3", 3_200_000],
  ]);
  const reserved = new Map();
  const payments = new Map();
  let sequence = 0;
  function finish(id, status, chargeId) {
    const p = payments.get(id);
    if (!p || p.status !== "PROCESSING") return;
    p.status = status;
    if (status !== "PENDING")
      reserved.set(p.studentId, reserved.get(p.studentId) - p.amount);
    if (status === "PAID") {
      debts.set(p.studentId, debts.get(p.studentId) - p.amount);
      p.chargeId = chargeId;
    }
  }
  return {
    getFees(studentId) {
      if (!debts.has(studentId))
        throw Object.assign(new Error("Student not found"), {
          httpStatus: 404,
        });
      return { studentId, outstanding: debts.get(studentId) };
    },
    createPayment(studentId, amount) {
      const paymentId = `P${++sequence}`;
      const reject = (message, httpStatus = 400) => {
        throw Object.assign(new Error(message), { paymentId, httpStatus });
      };
      if (!debts.has(studentId)) reject("Student not found", 404);
      if (!Number.isSafeInteger(amount) || amount <= 0)
        reject("Amount must be a positive safe integer in VND");
      if (amount > debts.get(studentId) - (reserved.get(studentId) ?? 0))
        reject("Amount exceeds available outstanding fees");
      const payment = {
        paymentId,
        studentId,
        amount,
        idempotencyKey: randomUUID(),
        status: "PROCESSING",
      };
      reserved.set(studentId, (reserved.get(studentId) ?? 0) + amount);
      payments.set(paymentId, payment);
      return payment;
    },
    // Parser errors still need an identifiable payment response.
    nextPaymentId() {
      return `P${++sequence}`;
    },
    markPaid(id, chargeId) {
      finish(id, "PAID", chargeId);
    },
    markFailed(id) {
      finish(id, "FAILED");
    },
    markPending(id) {
      finish(id, "PENDING");
    },
  };
}
