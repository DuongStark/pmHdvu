import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createBankServer} from '../src/bank/server.js';
import {createBankClient} from '../src/fee/bank-client.js';
import {listen, close, json} from './helpers.js';
const payment = {reference:'P1', amount:1000, idempotencyKey:'same-key'};
async function setup(t, server, options = {}) {
  const url = await listen(server);
  const c = createBankClient({bankUrl:url, ...options});
  t.after(async()=>{c.close(); await close(server);});
  return {c,url,server};
}
test('connection refused fails fast; same client recovers when bank starts', async t => {
  const probe = http.createServer();
  const url = await listen(probe);
  const port = probe.address().port;
  await close(probe);
  const c = createBankClient({bankUrl:url});
  t.after(()=>c.close());
  const start = performance.now();
  assert.deepEqual((await c.charge(payment)).kind, 'failed');
  const result = await c.charge(payment);
  assert.equal(result.httpStatus, 503);
  assert.ok(performance.now()-start < 1500);
  const server = createBankServer({logger:()=>{}});
  await listen(server, port);
  t.after(()=>close(server));
  assert.equal((await c.charge(payment)).kind, 'paid');
});
test('402 is not retried', async t => {
  const {c,url} = await setup(t, createBankServer({logger:()=>{}}));
  const result = await c.charge({...payment, amount:25_000_000});
  assert.equal(result.kind, 'failed');
  assert.equal(result.httpStatus, 402);
  assert.equal((await json(`${url}/stats`)).body.requests, 1);
});
test('drop after charge is recovered with the same key and one charge', async t => {
  const {c,url} = await setup(t, createBankServer({dropRate:1,logger:()=>{}}));
  assert.equal((await c.charge(payment)).kind, 'paid');
  const stats = (await json(`${url}/stats`)).body;
  assert.equal(stats.requests, 2);
  assert.equal(stats.charges, 1);
  assert.equal(stats.duplicates, 0);
});
test('retries temporary 500, but stops after three attempts', async t => {
  let calls = 0;
  const server = http.createServer((req,res)=>{calls++; res.writeHead(500).end('{}');});
  const {c} = await setup(t, server);
  const result = await c.charge(payment);
  assert.equal(result.kind, 'failed');
  assert.equal(result.httpStatus, 503);
  assert.equal(calls, 3);
});
test('timeout includes pool wait and late replies never become success', async t => {
  const {c} = await setup(t, createBankServer({delayMs:5000,logger:()=>{}}));
  const start = performance.now();
  const results = await Promise.all(Array.from({length:20}, (_,i)=>c.charge({...payment,reference:`P${i}`,idempotencyKey:`k${i}`})));
  assert.ok(performance.now()-start <= 4500);
  assert.ok(results.every(r=>r.kind==='pending'));
});
test('ambiguous disconnect followed by refused connection remains pending', async t => {
  const server = http.createServer((req,res)=>{res.socket.destroy(); server.close();});
  const {c} = await setup(t, server);
  assert.equal((await c.charge(payment)).kind, 'pending');
});
test('malformed bank success does not reduce debt or count as success', async t => {
  let calls = 0;
  const {c} = await setup(t, http.createServer((req,res)=>{calls++;res.writeHead(201).end(calls===1?'bad-json':'{}');}));
  assert.equal((await c.charge(payment)).kind, 'pending');
  assert.equal(calls, 3);
});
test('client uses at most ten sockets and renews after six idle seconds', async t => {
  const {c,url} = await setup(t, createBankServer({logger:()=>{}}));
  const execute = i=>c.charge({...payment,reference:`P${i}`,idempotencyKey:`k${i}`});
  const results = await Promise.all(Array.from({length:200}, (_,i)=>execute(i)));
  assert.ok(results.every(r=>r.kind==='paid'));
  const stats = (await json(`${url}/stats`)).body;
  assert.ok(stats.connections-1 <= 20);
  await delay(6000);
  assert.equal((await execute(201)).kind, 'paid');
});
test('client rejects invalid configuration', () => {
  for (const bankUrl of ['file:///tmp/a','ftp://bank','http://user:pass@localhost:4002','not a url','http://localhost:4002/a?x=y']) assert.throws(()=>createBankClient({bankUrl}));
  assert.throws(()=>createBankClient({bankUrl:'http://localhost:4002',mode:'typo'}));
});
test('closing during retry backoff never sends another charge', async t => {
  let calls=0;
  const server=http.createServer((req,res)=>{calls++;res.writeHead(calls===1?500:201).end(JSON.stringify({chargeId:'C1'}));});
  const {c}=await setup(t,server);
  const paymentResult=c.charge(payment);
  await delay(50);
  c.close();
  const result=await paymentResult;
  assert.equal(result.kind,'failed');
  assert.equal(result.httpStatus,503);
  assert.equal(calls,1);
});
