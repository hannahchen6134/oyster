import test from 'node:test';import assert from 'node:assert/strict';
import {reportFixture} from './support/report-fixture.mjs';import {loadAdminTrends,renderAdminTrends} from '../src/admin-trends.js';
test('trends use Taipei submission day and actual actor, exclude imports, retain deleted successes',async()=>{
 const db=await reportFixture();
 db.prepare("UPDATE logs SET source='import'").run();
 const ids=db.prepare("SELECT logId FROM logs LIMIT 4").all().results.map(r=>r.logId);
 for(let i=0;i<3;i++)db.prepare("UPDATE logs SET source='line',createdAt='2026-09-07T16:30:00.000Z',eventDateTime='2026-08-01 08:00',recordedBy=?,isDeleted=? WHERE logId=?").bind(i===2?'helper':'owner',i===1?1:0,ids[i]).run();
 const result=await loadAdminTrends(db,'2026-09-08');assert.deepEqual({...result.days[0]},{day:'2026-09-08',records:3,active:2});assert.equal(result.first[0].newcomers,2);assert.equal(result.start,'2026-09-08');
 assert.ok(!JSON.stringify(result).includes('owner'));assert.match(renderAdminTrends(result),/近 90 天/);
});
test('no tracked data remains unknown rather than invented zero coverage',async()=>{
 const db=await reportFixture();const data=await loadAdminTrends(db);assert.equal(data.start,null);assert.deepEqual(data.days,[]);
});
