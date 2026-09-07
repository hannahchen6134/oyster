import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {reportFixture} from './support/report-fixture.mjs';
import {classifyLines,purgeReports} from '../src/report-sharing.js';
import {appKvGet,appKvSet} from '../src/db.js';
import qrcode from '../public/qrcode.mjs';
import jsQR from 'jsqr';
const snapshot={petId:'p1',purpose:'care',dateRangeLabel:'這週',notice:'爸媽確認',rangeDays:7,sections:[{title:'餵食',items:['<script>alert(1)</script> 4.27 g']}],secret:'NEVER_STORE',petName:'偽造名字'};
async function setup(ai){const DB=await reportFixture(),env={DB,AI:ai};return {DB,call:async(path,method='GET',body,token='testowner',key=crypto.randomUUID())=>worker.fetch(new Request('https://care.example'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil(){}})};}
test('範本依貓與爸媽隔離，保留整理狀態；共照者不得發布',async()=>{
 const {call}=await setup();assert.equal((await call('/api/care-template','PUT',{petId:'p1',draft:{feeding:'蚵仔',rawApplied:true}})).status,200);
 assert.equal((await (await call('/api/care-template?petId=p1')).json()).template.draft.feeding,'蚵仔');
 assert.equal((await (await call('/api/care-template?petId=p1')).json()).template.draft.rawApplied,true);
 assert.equal((await (await call('/api/care-template?petId=p2')).json()).template,null);
 for(const token of ['teststranger','testhelper'])assert.equal((await call('/api/care-template?petId=p1','GET',undefined,token)).status,403);
 assert.equal((await call('/api/care-template?petId=p1','GET',undefined,'')).status,401);
 assert.equal((await call('/api/care-template','PUT',{petId:'p1',draft:{feeding:'x'.repeat(6001)}})).status,400);
});
test('公開摘要固定當下內容，白名單去除內部欄位，HTML轉義，訪客不能寫',async()=>{
 const {call,DB}=await setup();const created=await (await call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true})).json();assert.match(created.url,/^\/r\/[a-f0-9]{32}$/);
 const page=await call(created.url,'GET',undefined,'');assert.equal(page.status,200);const html=await page.text();assert.match(html,/蚵仔/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|NEVER_STORE|偽造名字|ownerLineUserId|testowner/);assert.match(page.headers.get('cache-control'),/no-store/);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 assert.doesNotMatch(await appKvGet(DB,'reportShare:'+created.id),/NEVER_STORE/);
 await call('/api/care-template','PUT',{petId:'p1',draft:{feeding:'新的安排'}});assert.doesNotMatch(await (await call(created.url)).text(),/新的安排/);
 assert.equal((await call(created.url,'POST',{})).status,405);
});
test('分享需確認與正確家庭、正確petId；醫生/照護用途獨立',async()=>{
 const {call}=await setup();assert.equal((await call('/api/report-shares','POST',{petId:'p1',snapshot})).status,400);
 assert.equal((await call('/api/report-shares','POST',{petId:'p2',snapshot,confirmed:true})).status,400);
 assert.equal((await call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true},'teststranger')).status,403);
 const doctor=await (await call('/api/report-shares','POST',{petId:'p1',snapshot:{...snapshot,purpose:'doctor'},confirmed:true})).json();assert.match(await (await call(doctor.url)).text(),/就醫摘要/);
});
test('重試與平行重送回同一份不可变摘要',async()=>{
 const {call}=await setup();const key=crypto.randomUUID();const results=await Promise.all(Array.from({length:5},()=>call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true},'testowner',key).then(r=>r.json())));assert.equal(new Set(results.map(r=>r.id)).size,1);
 const retried=await (await call('/api/report-shares','POST',{petId:'p1',snapshot:{...snapshot,sections:[]},confirmed:true},'testowner',key)).json();assert.equal(retried.id,results[0].id);assert.match(await (await call(retried.url)).text(),/4.27/);
});
test('爸媽可停用，陌生人無法停用或列出，過期不再提供內容',async()=>{
 const {call,DB}=await setup();const made=await (await call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true})).json();assert.equal((await call('/api/report-shares/'+made.id,'DELETE',undefined,'teststranger')).status,404);
 assert.equal((await call('/api/report-shares?petId=p1','GET',undefined,'teststranger')).status,403);
 assert.equal((await call('/api/report-shares/'+made.id,'DELETE')).status,200);assert.equal((await call(made.url)).status,410);assert.equal(JSON.parse(await appKvGet(DB,'reportShare:'+made.id)).snapshot,null);
 const next=await (await call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true})).json();const row=JSON.parse(await appKvGet(DB,'reportShare:'+next.id));row.expiresAt='2020-01-01';await appKvSet(DB,'reportShare:'+next.id,JSON.stringify(row));assert.equal((await call(next.url)).status,410);await purgeReports(DB);assert.equal(await appKvGet(DB,'reportShare:'+next.id),null);
});
test('刪除貓咪後，舊連結不能繼續讀取',async()=>{const {call,DB}=await setup();const made=await (await call('/api/report-shares','POST',{petId:'p1',snapshot,confirmed:true})).json();DB.prepare('UPDATE pets SET isDeleted=1 WHERE petId=?').bind('p1').run();assert.equal((await call(made.url)).status,410);});
test('AI僅回傳分類ID，不可新增數字或遺漏原文；故障走明確規則備案',async()=>{
 const raw='早上餵 4.27g。\n藥放抽屜。\n不需餵藥。';const {call}=await setup({run:async()=>({response:JSON.stringify({feeding:[0,999],medicine:[2],supplies:[1],notes:['改成10顆']})})});
 const r=await (await call('/api/care-organize','POST',{petId:'p1',rawNotes:raw})).json();assert.equal(r.via,'ai');assert.equal(r.draft.feeding,'早上餵 4.27g。');assert.equal(r.draft.medicine,'不需餵藥。');assert.doesNotMatch(JSON.stringify(r),/10顆/);
 const fallback=await setup({run:async()=>{throw Error('offline');}});const f=await (await fallback.call('/api/care-organize','POST',{petId:'p1',rawNotes:raw})).json();assert.equal(f.via,'rules');for(const line of raw.split('\n').filter(Boolean))assert.ok(Object.values(f.draft).includes(line));
 const classified=classifyLines('甲。乙。丙。',{feeding:[0,0],medicine:[0],notes:[2]});assert.equal(classified.notes,'甲。\n乙。\n丙。');
});
test('AI每天限次、空白或過大輸入拒絕',async()=>{const {call}=await setup();assert.equal((await call('/api/care-organize','POST',{petId:'p1',rawNotes:''})).status,400);for(let i=0;i<10;i++)assert.equal((await call('/api/care-organize','POST',{petId:'p1',rawNotes:'餵食'})).status,200);assert.equal((await call('/api/care-organize','POST',{petId:'p1',rawNotes:'餵食'})).status,429);});
test('QR矩陣含足夠留白，獨立解碼器可還原精確摘要連結',()=>{
 const url='https://cat-care-beta.hannahchen6134.workers.dev/r/0123456789abcdef0123456789abcdef';
 const qr=qrcode(0,'M');qr.addData(url,'Byte');qr.make();const count=qr.getModuleCount(),scale=8,pad=4,size=(count+pad*2)*scale,data=new Uint8ClampedArray(size*size*4).fill(255);
 for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const i=(((y+pad)*scale+dy)*size+(x+pad)*scale+dx)*4;data[i]=data[i+1]=data[i+2]=0;}
 assert.equal(jsQR(data,size,size)?.data,url);
});
