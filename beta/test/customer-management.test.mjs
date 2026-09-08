import test from 'node:test';
import assert from 'node:assert/strict';
import {reportFixture} from './support/report-fixture.mjs';
import {touchCustomer,auditExport,markDownload,retentionStatus,buildJourney,customerPanel} from '../src/customer-management.js';
test('activity is monotonic and export download checks owner',async()=>{
 const db=await reportFixture();
 await touchCustomer(db,'owner','web','2026-09-09T00:00:00Z');
 await touchCustomer(db,'owner','line','2026-09-08T00:00:00Z');
 assert.match(db.prepare('SELECT v FROM app_kv WHERE k=?').bind('customerActivity:owner').first().v,/09-09/);
 await auditExport(db,'owner','one','JSON',10,'all');
 assert.equal(await markDownload(db,'stranger','one'),false);
 assert.equal(await markDownload(db,'owner','one'),true);
 const html=await customerPanel(db);
 assert.ok(html.includes('使用路徑')); assert.ok(html.includes('資料下載歷程'));
});
test('retention never infers old untracked usage and handles leap anniversary',()=>{
 assert.equal(retentionStatus(null).key,'unknown');
 assert.equal(retentionStatus('2024-02-29T00:00:00Z',Date.parse('2025-02-28T00:00:00Z')).key,'due');
});
test('journeys exclude unknown events and do not join separate sessions',()=>{
 const result=buildJourney([{event:'record',createdAt:'2026-09-08T03:00:00Z'},{event:'record',createdAt:'2026-09-08T01:02:00Z'},{event:'menu_record',createdAt:'2026-09-08T01:00:00Z'}]);
 assert.equal(result.common.length,1); assert.equal(result.common[0].path,'開啟記一筆 → 完成紀錄');
});
