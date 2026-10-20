import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBankServer} from '../src/bank/server.js';
import {listen, close, json} from './helpers.js';

async function bank(t, config = {}) {
  const server = createBankServer({...config, logger:()=>{}});
  const url = await listen(server);
  t.after(()=>close(server));
  const charge = (key, amount = 1000, reference = 'P1') => json(`${url}/charges`, {body:{reference, amount}, headers:{'Idempotency-Key':key}});
  const stats = async () => (await json(`${url}/stats`)).body;
  return {charge, stats, url, server};
}
test('bank validates money, key, reference and limit without charging', async t => {
  const b = await bank(t);
  for (const amount of [0, -1, 0.5, '1000', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await b.charge('key', amount)).code, 400);
  assert.equal((await b.charge('key', 25_000_000)).code, 402);
  assert.equal((await b.charge('', 1000)).code, 400);
  assert.equal((await b.charge('key', 1000, '')).code, 400);
  assert.equal((await b.stats()).charges, 0);
});
test('same key concurrently returns the original charge, conflicting payload is rejected', async t => {
  const b = await bank(t, {delayMs:20});
  const replies = await Promise.all(Array.from({length:10}, ()=>b.charge('key')));
  assert.ok(replies.every(r => r.code === 201 && r.body.chargeId === replies[0].body.chargeId));
  assert.equal((await b.charge('key', 2000)).code, 409);
  assert.equal((await b.charge('key', 1000, 'P2')).code, 409);
  const stats = await b.stats();
  assert.equal(stats.charges, 1);
  assert.equal(stats.requests, 12);
  assert.equal(stats.duplicates, 0);
  assert.ok(stats.connections >= 1);
});
test('same reference with another key cannot charge a second time', async t => {
  const b = await bank(t);
  const first = await b.charge('a');
  const again = await b.charge('b');
  assert.equal(again.body.chargeId, first.body.chargeId);
  assert.equal((await b.charge('c', 2000)).code, 409);
  assert.equal((await b.stats()).charges, 1);
  assert.equal((await b.stats()).duplicates, 0);
});
test('500 happens before charging and is not cached', async t => {
  let n = 0;
  const b = await bank(t, {failRate:0.5, random:()=>n++ === 0 ? 0 : 0.9});
  assert.equal((await b.charge('key')).code, 500);
  assert.equal((await b.stats()).charges, 0);
  assert.equal((await b.charge('key')).code, 201);
  assert.equal((await b.stats()).charges, 1);
});
test('drop happens after charging; replay bypasses fault injection', async t => {
  const b = await bank(t, {dropRate:1});
  await assert.rejects(b.charge('key'));
  assert.equal((await b.stats()).charges, 1);
  assert.equal((await b.charge('key')).code, 201);
  assert.equal((await b.stats()).charges, 1);
  assert.equal((await b.stats()).duplicates, 0);
});
test('server uses a five second idle timeout', async t => {
  const b = await bank(t);
  assert.equal(b.server.keepAliveTimeout, 5000);
  if ('keepAliveTimeoutBuffer' in b.server) assert.equal(b.server.keepAliveTimeoutBuffer, 0);
});
test('environment configuration rejects out-of-range and invalid values', async () => {
  const {readBankConfig} = await import('../src/bank/server.js');
  for (const env of [{FAIL_RATE:'2'}, {DROP_RATE:'-1'}, {DELAY_MS:'abc'}, {DELAY_MS:'1.2'}, {FAIL_RATE:''}]) assert.throws(()=>readBankConfig(env));
  assert.deepEqual(readBankConfig({DELAY_MS:'5000', FAIL_RATE:'.3'}), {delayMs:5000, failRate:0.3, dropRate:0});
});
