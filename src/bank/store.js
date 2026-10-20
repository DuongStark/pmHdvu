export function createBankStore() {
  const byKey = new Map();
  const byReference = new Map();
  const transactions = [];
  let connections = 0;
  let requests = 0;
  const same = (a, b) => a.reference === b.reference && a.amount === b.amount;
  return {
    connection() {
      connections++;
    },
    request() {
      requests++;
    },
    lookup(key, payload) {
      const entry = byKey.get(key) ?? byReference.get(payload.reference);
      if (!entry) return null;
      if (!same(entry, payload))
        return {
          httpStatus: 409,
          body: {
            error:
              "Idempotency key or reference conflicts with an existing charge",
          },
        };
      byKey.set(key, entry);
      return { httpStatus: 201, body: { chargeId: entry.chargeId } };
    },
    charge(key, payload) {
      const cached = this.lookup(key, payload);
      if (cached) return cached;
      const entry = { ...payload, chargeId: `C${transactions.length + 1}` };
      byKey.set(key, entry);
      byReference.set(payload.reference, entry);
      transactions.push(entry);
      return { httpStatus: 201, body: { chargeId: entry.chargeId } };
    },
    stats() {
      const unique = new Set(transactions.map((t) => t.reference));
      return {
        connections,
        requests,
        charges: transactions.length,
        duplicates: transactions.length - unique.size,
      };
    },
  };
}
