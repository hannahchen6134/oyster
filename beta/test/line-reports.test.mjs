import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFixture } from './support/report-fixture.mjs';
import { startLineReport, handleLineReportPostback, handleLineReportText, buildLineReport, reportPeriod } from '../src/line-reports.js';
import { appKvGet, appKvSet } from '../src/db.js';
import { publicReport, handleReportApi } from '../src/report-sharing.js';
import worker from '../src/index.js';
import { doctorReportData } from '../public/doctor-report-data.js';
import { imageDocument } from '../src/report-renderer.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6AAAAABJRU5ErkJggg==';
async function setup(run) {
 const db=await reportFixture(),env={DB:db,LINE_CHANNEL_ACCESS_TOKEN:'test'},sent=[],old=fetch;
 globalThis.fetch=async(url,options)=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{}');};
 const event={source:{type:'user',userId:'owner'},replyToken:'test',__reportBaseUrl:'https://local.test'};
 const flow=async()=>JSON.parse(await appKvGet(db,'lineReportFlow:owner'));
 const rawPost=async(action,extra={},render=async()=>[png,png],date)=>handleLineReportPostback(env,{...event,...(date?{postback:{params:{date}}}:{})},'owner',new URLSearchParams({action,flow:(await flow()).id,...extra}),render);
 // Existing delivery tests traverse the new date step with explicit fixture dates.
 const post=async(action,extra={},render=async()=>[png,png])=>{
  const wasPurpose=(await flow()).stage==='purpose';await rawPost(action,extra,render);
  if(action==='reportPurpose'&&wasPurpose){
   return rawPost('reportDays',{days:extra.purpose==='doctor'?'30':'14'},render);
  }
 };

 try{await startLineReport(env,event,'owner');await run({db,env,sent,event,flow,post,rawPost});}finally{globalThis.fetch=old;}
}
test('LINE 選貓→選用途→摘要圖與QR；不建立登入連結，QR與圖同一份快照',()=>setup(async({db,env,sent,post,flow})=>{
 await post('reportPet',{petId:'p2'});assert.match(JSON.stringify(sent.at(-1)),/麵線的摘要要給誰/);assert.doesNotMatch(JSON.stringify(sent.at(-1)),/"type":"uri"/);
 let snap,url;await post('reportPurpose',{purpose:'doctor'},async(e,s,u)=>{snap=s;url=u;return [png,png];});
 assert.equal(snap.petName,'麵線');assert.doesNotMatch(JSON.stringify(snap),/測試藥p1/);assert.match(JSON.stringify(snap),/4.27/);assert.equal((await flow()).stage,'done');
 const messages=sent.at(-1).messages;assert.equal(messages.filter(m=>m.type==='image').length,2);assert.equal(messages[0].originalContentUrl,url+'/image/0');assert.match(messages.at(-1).text,/QR Code/);
 assert.deepEqual(messages.at(-1).quickReply.items.map(i=>i.action.label),['主食','乾乾','零食','水','藥','尿尿','便便','更多紀錄']);
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
 const last=sent.at(-1).messages.at(-1);assert.equal(last.quickReply.items.length,9);assert.equal(last.quickReply.items.at(-1).action.label,'補充照護說明');assert.equal(last.quickReply.items.find(i=>i.action.label==='水').action.fillInText,'水');
 await post('reportPurpose',{purpose:'care'},async()=>{calls++;return [png,png];});assert.equal(calls,1);
}));
test('照護只補缺項；已填餵食保留，後台填完重讀，不用輸入出已有資料',()=>setup(async({db,env,event,sent,post,flow})=>{
 env.LIFF_ID='test-liff';
 await appKvSet(db,'careTemplate:owner:p1',JSON.stringify({draft:{feeding:'早晚主食40g',medicine:'藥拌罐頭'}}));
 await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'care'});
 assert.equal((await flow()).stage,'feeding');const prompt=JSON.stringify(sent.at(-1));assert.match(prompt,/還缺：摸摸喜好/);assert.match(prompt,/也可開啟照護資料填寫/);assert.doesNotMatch(prompt,/先出已有資料|填好後出圖|"style":"secondary"/);
 await post('reportRecheck');assert.equal((await flow()).stage,'feeding');
 await handleLineReportText(env,event,'owner','喜歡摸下巴，不能碰肚子。');await post('reportConfirm');assert.equal((await flow()).stage,'done');
 const d=JSON.parse(await appKvGet(db,'careTemplate:owner:p1')).draft;assert.equal(d.feeding,'早晚主食40g');assert.match(d.medicine,/藥拌罐頭/);assert.match(d.notes,/不能碰肚子/);
 const bundle=await buildLineReport(db,'owner','p1','care');assert.equal(bundle.snapshot.sections[0].title,'怎麼餵食與補水');assert.ok(bundle.snapshot.sections.findIndex(s=>s.kind==='history')>3);
}));
test('缺三項逐題回答，空的帶入文字不算答案，最後確認一次才存範本並送圖QR',()=>setup(async({db,env,event,sent,post,flow})=>{
 env.LIFF_ID='test-liff';db.prepare("UPDATE meds SET instruction='' WHERE petId='p1'").run();
 await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'care'});
 assert.equal((await flow()).careQuestion,'feeding');
 const n=sent.length;await post('reportInput');assert.equal(sent.length,n);
 await handleLineReportText(env,event,'owner','餵食：');assert.equal((await flow()).careQuestion,'feeding');assert.equal((await flow()).careDraft,undefined);
 await handleLineReportText(env,event,'owner','餵食：早晚各40g，水碗補滿');assert.equal((await flow()).careQuestion,'medicine');
 await handleLineReportText(env,event,'owner','餵食：水碗放客廳');assert.equal((await flow()).careQuestion,'medicine');assert.equal((await flow()).careDraft.medicine,'');
 await handleLineReportText(env,event,'owner','餵藥：不用吃藥');assert.equal((await flow()).careQuestion,'notes');
 await handleLineReportText(env,event,'owner','相處方式：不親人，沒有特別禁忌');assert.equal((await flow()).stage,'confirm');
 assert.equal(await appKvGet(db,'careTemplate:owner:p1'),null);assert.match(JSON.stringify(sent.at(-1)),/早晚各40g/);
 await post('reportConfirm');assert.equal((await flow()).stage,'done');assert.equal(sent.at(-1).messages.filter(m=>m.type==='image').length,2);
 const draft=JSON.parse(await appKvGet(db,'careTemplate:owner:p1')).draft;assert.match(draft.feeding,/早晚各40g/);assert.match(draft.medicine,/不用吃藥/);assert.match(draft.notes,/不親人/);
}));

test('重按舊出圖卡轉為補填，之後重讀缺資料只給短提示；網頁存範本後直接出圖',()=>setup(async({db,env,sent,post,flow})=>{
 env.LIFF_ID='test-liff';await post('reportPet',{petId:'p1'});await post('reportPurpose',{purpose:'care'});
 const legacy=await flow();delete legacy.careQuestion;await appKvSet(db,'lineReportFlow:owner',JSON.stringify(legacy));
 await post('reportRecheck');assert.equal((await flow()).careQuestion,'feeding');assert.match(JSON.stringify(sent.at(-1)),/直接在 LINE 回答/);
 await post('reportRecheck');assert.equal(sent.at(-1).messages[0].type,'text');assert.match(sent.at(-1).messages[0].text,/還沒讀到完整資料/);
 const request=new Request('https://local.test/api/care-template?petId=p1',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({draft:{feeding:'早晚40g，水補滿',medicine:'藥拌罐頭',notes:'喜歡摸下巴'}})});
 const saved=await handleReportApi(request,env,new URL(request.url),'owner','owner');assert.equal(saved.status,200);
 await post('reportRecheck');assert.equal((await flow()).stage,'done');assert.equal(sent.at(-1).messages.filter(m=>m.type==='image').length,2);
}));

test('醫生圖片與QR公開頁沿用A4趨勢、組成和明細，不只文字摘要',()=>setup(async({db,env,post})=>{
 await post('reportPet',{petId:'p1'});let snapshot,url;await post('reportPurpose',{purpose:'doctor'},async(e,s,u)=>{snapshot=s;url=u;return [png,png];});
 assert.ok(snapshot.doctorSource.rows.length);const html=imageDocument(snapshot,url);assert.match(html,/a4-spark/);assert.match(html,/每日照護明細/);assert.match(html,/4.27/);
 assert.doesNotMatch(html,/id="(?:source|pages|heading)"/,'doctor must not create the additional text-summary renderer');
 assert.equal((html.match(/id="qr"/g)||[]).length,1);
 const page=await publicReport(new Request(url),env,new URL(url));const publicHtml=await page.text();assert.match(publicHtml,/a4-spark/);assert.doesNotMatch(publicHtml,/class="purpose-section"/);
}));
test('醫生按鈕先回覆正在整理，產圖後push圖片，不重複使用reply token',()=>setup(async({sent,post})=>{
 await post('reportPet',{petId:'p1'});let release,started;
 const began=new Promise(r=>{started=r;});const rendering=new Promise(r=>{release=r;});
 const work=post('reportPurpose',{purpose:'doctor'},async()=>{started();return rendering;});await began;
 assert.match(sent.at(-1).messages[0].text,/正在整理摘要圖片/);assert.equal(sent.at(-1).replyToken,'test');
 release([png,png]);await work;assert.equal(sent.at(-1).to,'owner');assert.equal(sent.at(-1).replyToken,undefined);assert.equal(sent.at(-1).messages[0].type,'image');
}));
test('外家貓、共照者、過期流程不得生成分享摘要',()=>setup(async({db,env,event,sent,post,flow})=>{
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
 assert.equal(res.status,200);assert.match(JSON.stringify(sent.at(-1)),/蚵仔的摘要要給誰/);assert.match(JSON.stringify(sent.at(-1)),/reportPurpose/);assert.doesNotMatch(JSON.stringify(sent.at(-1)),/"type":"uri"/);
}));
test('產圖期間連點只產生一次；新流程不被舊流程完成覆寫',()=>setup(async({env,event,sent,post,flow})=>{
 await post('reportPet',{petId:'p1'});
 let unblock,started;const waiting=new Promise(r=>started=r);const first=post('reportPurpose',{purpose:'doctor'},async()=>{started();await new Promise(r=>unblock=r);return [png,png];});
 await waiting;let duplicate=0;await post('reportGenerate',{},async()=>{duplicate++;return [png,png];});assert.equal(duplicate,0);
 await startLineReport(env,event,'owner');const newId=(await flow()).id;unblock();await first;assert.equal((await flow()).id,newId);assert.equal((await flow()).stage,'pet');
}));

test('醫生與照護者只選14或30天，舊日期按鈕回到簡單選項',()=>setup(async({db,env,event,rawPost,flow,sent})=>{
 for(const purpose of ['doctor','care']){
  await startLineReport(env,event,'owner');await rawPost('reportPet',{petId:'p1'});await rawPost('reportPurpose',{purpose});
  assert.equal((await flow()).stage,'period');const text=JSON.stringify(sent.at(-1));assert.match(text,/往前 14 天/);assert.match(text,/往前一個月/);assert.doesNotMatch(text,/datetimepicker|reportCustom|reportSavedPeriod/);
  await rawPost('reportCustom');assert.equal((await flow()).stage,'period');
  await rawPost('reportDays',{days:'14'});const f=await flow();assert.equal(reportPeriod(f.rangeFrom,f.rangeTo).days,14);
  const bundle=await buildLineReport(db,'owner','p1',purpose,f);assert.equal(bundle.snapshot.rangeDays,14);
 }
 env.LIFF_ID='test-liff';await startLineReport(env,event,'owner');await rawPost('reportPet',{petId:'p1'});await rawPost('reportPurpose',{purpose:'doctor'});await rawPost('reportDays',{days:'30'});
 assert.match(JSON.stringify(sent.at(-1)),/查看詳細資料/);assert.ok(JSON.stringify(sent.at(-1)).includes('https://liff.line.me/test-liff'));
}));

test('A4 自訂長期間不截成31天；未記錄日期不當成零',()=>{
 const rows=Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2026,5,1+i)).toISOString().slice(0,10),entryCount:1,totalWaterMl:i+1}));
 const snapshot={purpose:'doctor',petName:'測試貓',rangeDays:61,doctorSource:{from:'2026-06-01',to:'2026-07-31',rows},sections:[]};
 const data=doctorReportData(snapshot);assert.equal(data.water.points.length,61);assert.equal(data.daily.length,61);assert.equal(data.water.points.at(-1).value,null);assert.equal(data.daily[0].unrecorded,true);assert.equal(data.daily[1].waterMl,60);
 assert.match(imageDocument(snapshot,'https://local.test/r/demo'),/未記錄/);
});
