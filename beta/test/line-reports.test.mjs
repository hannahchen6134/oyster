import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFixture } from './support/report-fixture.mjs';
import { startLineReport, handleLineReportPostback, handleLineReportText, buildLineReport } from '../src/line-reports.js';
import { appKvGet, appKvSet } from '../src/db.js';
import { publicReport, handleReportApi } from '../src/report-sharing.js';
import worker from '../src/index.js';
import { imageDocument } from '../src/report-renderer.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6AAAAABJRU5ErkJggg==';
async function setup(run) {
 const db=await reportFixture(),env={DB:db,LINE_CHANNEL_ACCESS_TOKEN:'test'},sent=[],old=fetch;
 globalThis.fetch=async(url,options)=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{}');};
 const event={source:{type:'user',userId:'owner'},replyToken:'test',__reportBaseUrl:'https://local.test'};
 const flow=async()=>JSON.parse(await appKvGet(db,'lineReportFlow:owner'));
 const post=async(action,extra={},render=async()=>[png,png])=>handleLineReportPostback(env,event,'owner',new URLSearchParams({action,flow:(await flow()).id,...extra}),render);
 try{await startLineReport(env,event,'owner');await run({db,env,sent,event,flow,post});}finally{globalThis.fetch=old;}
}
test('LINE 選貓→選用途→報告圖與QR；不建立登入連結，QR與圖同一份快照',()=>setup(async({db,env,sent,post,flow})=>{
 await post('reportPet',{petId:'p2'});assert.match(JSON.stringify(sent.at(-1)),/麵線的報告要給誰/);assert.doesNotMatch(JSON.stringify(sent.at(-1)),/"type":"uri"/);
 let snap,url;await post('reportPurpose',{purpose:'doctor'},async(e,s,u)=>{snap=s;url=u;return [png,png];});
 assert.equal(snap.petName,'麵線');assert.doesNotMatch(JSON.stringify(snap),/測試藥p1/);assert.match(JSON.stringify(snap),/4.27/);assert.equal((await flow()).stage,'done');
 const messages=sent.at(-1).messages;assert.equal(messages.filter(m=>m.type==='image').length,2);assert.equal(messages[0].originalContentUrl,url+'/image/0');assert.match(messages.at(-1).text,/QR Code/);
 const page=await publicReport(new Request(url),env,new URL(url));assert.match(await page.text(),/麵線/);
 const imageUrl=messages[0].originalContentUrl;assert.equal((await publicReport(new Request(imageUrl),env,new URL(imageUrl))).headers.get('content-type'),'image/png');
 const id=url.split('/').at(-1),del=new Request('https://local.test/api/report-shares/'+id,{method:'DELETE'});await handleReportApi(del,env,new URL(del.url),'owner','owner');
 assert.equal((await publicReport(new Request(imageUrl),env,new URL(imageUrl))).status,410);
}));
test('照護缺少餵食安排在 LINE 補填，確認後存該貓範本才出圖',()=>setup(async({db,env,sent,event,post,flow})=>{
 await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'care'});assert.equal((await flow()).stage,'feeding');
 assert.doesNotMatch(JSON.stringify(sent.at(-1)),/先出已有資料/);
 await handleLineReportText(env,event,'owner','早晚餵主食罐40g，水補滿。藥拌罐頭。喜歡摸下巴，不能摸肚子。');assert.equal((await flow()).stage,'confirm');assert.equal(await appKvGet(db,'careTemplate:owner:p1'),null);
 await post('reportConfirm');assert.equal((await flow()).stage,'done');assert.match(await appKvGet(db,'careTemplate:owner:p1'),/早晚餵主食罐40g/);assert.equal(await appKvGet(db,'careTemplate:owner:p2'),null);
 assert.equal(sent.at(-1).messages.filter(m=>m.type==='image').length,2);
}));
test('現有照護範本直接出圖；多頁全數分批傳回，重點擊不重跑',()=>setup(async({db,event,env,sent,post,flow})=>{
 await appKvSet(db,'careTemplate:owner:p1',JSON.stringify({draft:{feeding:'依已確認安排餵食',medicine:'藥拌罐頭',notes:'喜歡摸下巴'},updatedAt:new Date().toISOString()}));
 await post('reportPet',{petId:'p1'});let calls=0;await post('reportPurpose',{purpose:'care'},async()=>{calls++;return Array(7).fill(png);});
 assert.equal(calls,1);assert.equal((await flow()).stage,'done');assert.equal(sent.flatMap(s=>s.messages).filter(m=>m.type==='image').length,7);assert.ok(sent.every(s=>s.messages.length<=5));
 await post('reportPurpose',{purpose:'care'},async()=>{calls++;return [png,png];});assert.equal(calls,1);
}));
test('照護只補缺項；已填餵食保留，後台填完重讀，不用輸入出已有資料',()=>setup(async({db,env,event,sent,post,flow})=>{
 env.LIFF_ID='test-liff';
 await appKvSet(db,'careTemplate:owner:p1',JSON.stringify({draft:{feeding:'早晚主食40g',medicine:'藥拌罐頭'}}));
 await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'care'});
 assert.equal((await flow()).stage,'feeding');const prompt=JSON.stringify(sent.at(-1));assert.match(prompt,/還缺：摸摸喜好/);assert.match(prompt,/到後台補照護資料/);assert.doesNotMatch(prompt,/先出已有資料/);
 await post('reportRecheck');assert.equal((await flow()).stage,'feeding');
 await handleLineReportText(env,event,'owner','喜歡摸下巴，不能碰肚子。');await post('reportConfirm');assert.equal((await flow()).stage,'done');
 const d=JSON.parse(await appKvGet(db,'careTemplate:owner:p1')).draft;assert.equal(d.feeding,'早晚主食40g');assert.match(d.medicine,/藥拌罐頭/);assert.match(d.notes,/不能碰肚子/);
 const bundle=await buildLineReport(db,'owner','p1','care');assert.equal(bundle.snapshot.sections[0].title,'怎麼餵食與補水');assert.ok(bundle.snapshot.sections.findIndex(s=>s.kind==='history')>3);
}));
test('醫生圖片與QR公開頁沿用A4趨勢、組成和明細，不只文字摘要',()=>setup(async({db,env,post})=>{
 await post('reportPet',{petId:'p1'});let snapshot,url;await post('reportPurpose',{purpose:'doctor'},async(e,s,u)=>{snapshot=s;url=u;return [png,png];});
 assert.ok(snapshot.doctorSource.rows.length);const html=imageDocument(snapshot,url);assert.match(html,/a4-spark/);assert.match(html,/每日照護明細/);assert.match(html,/4.27/);
 const page=await publicReport(new Request(url),env,new URL(url));assert.match(await page.text(),/a4-spark/);
}));
test('外家貓、共照者、過期流程不得生成分享報告',()=>setup(async({db,env,event,sent,post,flow})=>{
 await post('reportPet',{petId:'x1'});assert.equal((await flow()).stage,'pet');assert.match(JSON.stringify(sent.at(-1)),/無法存取/);
 await startLineReport(env,{...event,source:{type:'user',userId:'helper'}},'owner');assert.match(JSON.stringify(sent.at(-1)),/爸媽/);
 const f=await flow();f.expiresAt=0;await appKvSet(db,'lineReportFlow:owner',JSON.stringify(f));await post('reportPet',{petId:'p1'});assert.match(JSON.stringify(sent.at(-1)),/已過期/);
 await assert.rejects(buildLineReport(db,'owner','x1','doctor'),/forbidden/);
}));
test('產圖失敗可在 LINE 重試，不假稱已成功；快照沿用',()=>setup(async({db,sent,post,flow})=>{
 await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'doctor'},async()=>{throw Error('browser unavailable');});
 assert.equal((await flow()).stage,'ready');assert.match(JSON.stringify(sent.at(-1)),/重新產生/);
 assert.equal(sent.flatMap(s=>s.messages).filter(m=>m.type==='image').length,0);
 await post('reportGenerate');assert.equal((await flow()).stage,'done');
 const rows=db.prepare("SELECT k FROM app_kv WHERE k LIKE 'reportShare:%'").all().results;assert.equal(rows.length,1);
}));
test('真實驗簽 webhook 的選貓 postback 路由接到 LINE 用途卡',()=>setup(async({env,event,sent,flow})=>{
 const body=JSON.stringify({events:[{...event,type:'postback',webhookEventId:'report-route-test',postback:{data:`action=reportPet&flow=${(await flow()).id}&petId=p1`}}]});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
 const res=await worker.fetch(new Request('https://local.test/webhook',{method:'POST',headers:{'x-line-signature':sig},body}),{...env,LINE_CHANNEL_SECRET:'test-secret'},{});
 assert.equal(res.status,200);assert.match(JSON.stringify(sent.at(-1)),/蚵仔的報告要給誰/);assert.match(JSON.stringify(sent.at(-1)),/reportPurpose/);assert.doesNotMatch(JSON.stringify(sent.at(-1)),/"type":"uri"/);
}));
test('產圖期間連點只產生一次；新流程不被舊流程完成覆寫',()=>setup(async({env,event,sent,post,flow})=>{
 await post('reportPet',{petId:'p1'});
 let unblock,started;const waiting=new Promise(r=>started=r);const first=post('reportPurpose',{purpose:'doctor'},async()=>{started();await new Promise(r=>unblock=r);return [png,png];});
 await waiting;let duplicate=0;await post('reportGenerate',{},async()=>{duplicate++;return [png,png];});assert.equal(duplicate,0);
 await startLineReport(env,event,'owner');const newId=(await flow()).id;unblock();await first;assert.equal((await flow()).id,newId);assert.equal((await flow()).stage,'pet');
}));
