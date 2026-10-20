import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../scripts/benchmark.js';

test('benchmark runs real child processes and records recovery and raw counters', async () => {
  const result = await runScenario('1','resilient',{bankPorts:[0],feePort:0});
  assert.equal(result.scenario,'1');
  assert.equal(result.mode,'resilient');
  assert.equal(result.pass,true);
  assert.equal(result.runs[0].offline.code,503);
  assert.equal(result.runs[0].recovered.code,201);
  assert.equal(result.runs[0].statsAfter.charges,1);
  assert.equal(result.runs[0].outstandingBefore-result.runs[0].outstandingAfter,1000);
});
test('benchmark measures GET on its own connection during twenty waiting POSTs', async () => {
  const result=await runScenario('2','resilient',{bankPort:0,feePort:0});
  assert.equal(result.pass,true);
  assert.ok(result.runs[0].reads.every(r=>r.durationMs<300));
});
test('benchmark survives idle socket closure and counts 200 plus five payments', async () => {
  const result=await runScenario('3','resilient',{bankPort:0,feePort:0});
  assert.equal(result.pass,true);
  assert.equal(result.runs[0].statsDelta.charges,205);
  assert.ok(result.runs[0].loadBankConnections<=20);
});
