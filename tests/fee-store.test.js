import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFeeStore} from '../src/fee/store.js';
test('initial debts and payment validation with a payment id', () => {
  const s = createFeeStore();
  assert.deepEqual([1,2,3].map(id=>s.getFees(String(id)).outstanding), [50_000_000,0,3_200_000]);
  for (const amount of [0,-1,1.5,'1000',null,Number.MAX_SAFE_INTEGER + 1]) assert.throws(()=>s.createPayment('1', amount), e => e.httpStatus === 400 && /^P\d+$/.test(e.paymentId));
  assert.throws(()=>s.createPayment('2', 1000), e=>e.httpStatus===400);
  assert.throws(()=>s.createPayment('unknown', 1000), e=>e.httpStatus===404);
});
test('reserves synchronously, paid only once and failed releases reservation', () => {
  const s = createFeeStore();
  const a = s.createPayment('3', 2_000_000);
  assert.throws(()=>s.createPayment('3', 2_000_000));
  assert.equal(s.getFees('3').outstanding, 3_200_000);
  s.markPaid(a.paymentId, 'C1');
  s.markPaid(a.paymentId, 'C1');
  s.markFailed(a.paymentId);
  assert.equal(s.getFees('3').outstanding, 1_200_000);
  const b = s.createPayment('3', 1_000_000);
  s.markFailed(b.paymentId);
  assert.ok(s.createPayment('3', 1_000_000));
});
test('pending remains unresolved and reserves money without reducing debt', () => {
  const s = createFeeStore();
  const p = s.createPayment('3', 3_200_000);
  s.markPending(p.paymentId);
  s.markPaid(p.paymentId, 'late');
  s.markFailed(p.paymentId);
  assert.equal(p.status, 'PENDING');
  assert.equal(s.getFees('3').outstanding, 3_200_000);
  assert.throws(()=>s.createPayment('3', 1));
});
test('distinct payment ids and idempotency keys', () => {
  const s = createFeeStore();
  const a = s.createPayment('1', 1000);
  const b = s.createPayment('1', 1000);
  assert.equal(a.paymentId, 'P1');
  assert.equal(b.paymentId, 'P2');
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});
