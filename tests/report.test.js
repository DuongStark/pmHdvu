import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderReport} from '../scripts/report.js';
test('report preserves measured outcomes including baseline failure', () => {
  const records=[{scenario:'3',mode:'baseline',at:'2026-10-20T00:00:00Z',node:'v18.20.8',platform:'linux',arch:'x64',pass:false,runs:[{pass:false,summary:{paid:200,total:200,failed:0,pending:0,maxMs:32},loadMs:450,totalMs:6500,loadBankConnections:200,bankConnections:205,statsDelta:{requests:205,charges:205,duplicates:0},outstandingBefore:50_000_000,outstandingAfter:49_795_000,afterIdle:Array.from({length:5},()=>({code:201})),results:[]}]}];
  const report=renderReport(records);
  assert.ok(report.includes('200/200'));
  assert.ok(report.includes('FAIL'));
  assert.ok(report.includes('450.0'));
  assert.ok(report.includes('baseline'));
  assert.ok(report.includes('v18.20.8'));
  assert.ok(report.includes('PENDING'));
});
test('report counts scenario 1 outcomes instead of assuming recovery success', () => {
  const records=[{scenario:'1',mode:'resilient',at:'2026-10-20T00:00:00Z',node:'v18',platform:'linux',arch:'x64',pass:false,runs:[{bankUrl:'http://localhost:4002',pass:false,offline:{code:503,body:{status:'FAILED'},durationMs:1},recovered:{code:503,body:{status:'FAILED'},durationMs:2},read:{durationMs:1},statsAfter:{connections:1,requests:0,charges:0,duplicates:0},outstandingBefore:50_000_000,outstandingAfter:50_000_000}]}];
  assert.ok(renderReport(records).includes('| resilient | 0/2 | 2 / 0 |'));
});
