import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createBankServer} from '../src/bank/server.js';
import {createBankClient} from '../src/fee/bank-client.js';
import {createFeeServer} from '../src/fee/server.js';
import {createFeeStore} from '../src/fee/store.js';
import {listen, close, json} from './helpers.js';
async function system(t, config = {}) {
  const bank = createBankServer({logger:()=>{},...config});
  const bankUrl = await listen(bank);
  const client = createBankClient({bankUrl});
  const fee = createFeeServer({bankClient:client,store:createFeeStore()});
  const feeUrl = await listen(fee);
  t.after(async()=>{client.close();await close(fee);await close(bank);});
  return {pay:(amount=1000,id='1')=>json(`${feeUrl}/students/${id}/payments`,{body:{amount}}), fees:()=>json(`${feeUrl}/students/1/fees`), stats:async()=>(await json(`${bankUrl}/stats`)).body, feeUrl};
}
test('Fee API validates requests and returns complete error envelopes', async t => {
  const s = await system(t);
  assert.equal((await s.fees()).body.outstanding, 50_000_000);
  for (const [amount,id,code] of [[0,'1',400],[1.5,'1',400],['1000','1',400],[1000,'2',400],[1000,'99',404],[4_000_000,'3',400]]) {
    const r = await s.pay(amount,id);
    assert.equal(r.code,code);
    assert.equal(r.body.status,'FAILED');
    assert.ok(r.body.error);
    assert.match(r.body.paymentId,/^P\d+$/);
  }
  const paid = await s.pay();
  assert.equal(paid.code,201);
  assert.equal(paid.body.status,'PAID');
  assert.equal((await s.fees()).body.outstanding,49_999_000);
});
test('malformed and oversized JSON retain the payment error envelope', async t => {
  const s = await system(t);
  for (const payload of ['{', JSON.stringify({amount:1000,padding:'x'.repeat(17000)})]) {
    const result = await new Promise((resolve,reject)=> {
      const req = http.request(`${s.feeUrl}/students/1/payments`,{method:'POST',headers:{'content-type':'application/json'}},res=>{
        let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(data)}));
      });req.on('error',reject);req.end(payload);
    });
    assert.ok([400,413].includes(result.code));
    assert.equal(result.body.status,'FAILED');
    assert.ok(result.body.error);
    assert.match(result.body.paymentId,/^P\d+$/);
  }
  assert.equal((await s.stats()).charges,0);
});
test('scenario 1: no bank, fee survives, then recovers without restart', async t => {
  const probe = http.createServer();
  const bankUrl = await listen(probe);
  const port = probe.address().port;
  await close(probe);
  const client = createBankClient({bankUrl});
  const fee = createFeeServer({bankClient:client});
  const url = await listen(fee);
  t.after(async()=>{client.close();await close(fee);});
  const pay = ()=>json(`${url}/students/1/payments`,{body:{amount:1000}});
  const start = performance.now();
  const offline = await pay();
  assert.equal(offline.code,503);
  assert.equal(offline.body.status,'FAILED');
  assert.ok(performance.now()-start<1500);
  assert.equal((await json(`${url}/students/1/fees`)).code,200);
  const bank = createBankServer({logger:()=>{}});
  await listen(bank,port);
  t.after(()=>close(bank));
  assert.equal((await pay()).code,201);
});
test('scenario 2: twenty slow payments time out while reads stay responsive', async t => {
  const s = await system(t,{delayMs:5000});
  const start = performance.now();
  const payments = Promise.all(Array.from({length:20},()=>s.pay()));
  await delay(100);
  for (let i=0;i<5;i++) {
    const before = performance.now();
    assert.equal((await s.fees()).code,200);
    assert.ok(performance.now()-before<300);
    await delay(50);
  }
  const results = await payments;
  assert.ok(performance.now()-start<=4500);
  assert.ok(results.every(r=>r.code===504&&r.body.status==='PENDING'));
  assert.equal((await s.fees()).body.outstanding,50_000_000);
});
test('concurrent API payments reserve debt before calling bank', async t => {
  const s = await system(t,{delayMs:30});
  const results = await Promise.all([s.pay(2_000_000,'3'),s.pay(2_000_000,'3')]);
  assert.deepEqual(results.map(r=>r.code).sort(),[201,400]);
  assert.equal((await s.stats()).charges,1);
});
test('scenario 4a/b: deterministic fault sequences produce enough PAID without duplicates', async t => {
  for (const fault of ['dropRate','failRate']) {
    let i=0;
    const s = await system(t,{[fault]:0.3, random:()=>[0.1,0.9,0.9,0.9,0.9][i++%5]});
    const results=[];
    for (let k=0;k<60;k++) {
      const start = performance.now();
      results.push(await s.pay());
      assert.ok(performance.now()-start<=4500);
    }
    const paid=results.filter(r=>r.body.status==='PAID').length;
    assert.ok(paid>=54);
    if (fault==='dropRate') assert.ok(results.every(r=>r.code===201 || (r.code===504&&r.body.status==='PENDING')));
    const stats=await s.stats();
    assert.equal(stats.duplicates,0);
    assert.ok(stats.charges>=paid);
    assert.equal((await s.fees()).body.outstanding,50_000_000-paid*1000);
  }
});
test('scenario 4c: bank limit rejected exactly once and debt stays unchanged', async t => {
  const s = await system(t);
  const result=await s.pay(25_000_000);
  assert.equal(result.code,402);
  assert.equal(result.body.status,'FAILED');
  const stats=await s.stats();
  assert.equal(stats.requests,1);
  assert.equal(stats.charges,0);
  assert.equal((await s.fees()).body.outstanding,50_000_000);
});
test('unexpected client rejection is conservatively PENDING and service stays up', async t => {
  const server=createFeeServer({bankClient:{charge:async()=>{throw new Error('internal sensitive details');}}});
  const url=await listen(server);
  t.after(()=>close(server));
  const result=await json(`${url}/students/1/payments`,{body:{amount:1000}});
  assert.equal(result.code,504);
  assert.equal(result.body.status,'PENDING');
  assert.ok(!JSON.stringify(result.body).includes('sensitive'));
  assert.equal((await json(`${url}/students/1/fees`)).body.outstanding,50_000_000);
});
