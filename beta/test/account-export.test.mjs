import test from 'node:test';
import assert from 'node:assert/strict';
import {reportFixture} from './support/report-fixture.mjs';
import {buildAccountExport} from '../src/account-export.js';
import {handleApi} from '../src/api.js';
test('account export contains all owned cats and excludes credentials and other households', async()=>{
 const db=await reportFixture();
 db.batch=async statements=>statements.map(s=>s.all());
 const result=await buildAccountExport(db,'owner');
 assert.equal(result.counts.pets,2); assert.equal(result.counts.logs,10);
 assert.equal(result.counts.meds,2);
 assert.deepEqual(result.data.pets.map(p=>p.petId),['p1','p2']);
 assert.ok(!JSON.stringify(result).includes('sourceMessageId'));
 assert.ok(!JSON.stringify(result).includes('ownerLineUserId'));
 assert.equal(result.data.logs.find(l=>l.category==='weight').amount,4.27);
});
test('whole account export rejects caregiver and unauthenticated sessions',async()=>{
 const db=await reportFixture();
 for(const [token,status] of [['testhelper',403],['bad',401]]) {
  const req=new Request('https://example.com/api/account-export',{method:'POST',headers:{Authorization:'Bearer '+token}});
  const response=await handleApi(req,{DB:db},new URL(req.url));
  assert.equal(response.status,status);
 }
});
