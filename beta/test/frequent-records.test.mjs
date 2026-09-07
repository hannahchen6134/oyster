import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{handleTextMessage} from '../src/index.js';
import {reportFixture} from './support/report-fixture.mjs';
import {frequentRecordItems} from '../src/frequent-records.js';
import {replyOrPushFlex} from '../src/line.js';
async function setup(run,actor='single'){
 const DB=await reportFixture(),env={DB,LINE_CHANNEL_ACCESS_TOKEN:'test',LINE_CHANNEL_SECRET:'test-secret',LIFF_ID:'test-liff',ASSETS:{fetch:async()=>new Response('png')}},sent=[],old=fetch;
 globalThis.fetch=async(url,options={})=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{"richMenuId":"test-menu"}');};
 const event=()=>({source:{type:'user',userId:actor},replyToken:'test'});
 const say=async(text)=>{const id='frequent-'+crypto.randomUUID();await handleTextMessage({...event(),message:{id,text}},env,'https://local.test');return id;};
 const click=async(data)=>{
  const body=JSON.stringify({events:[{...event(),type:'postback',webhookEventId:crypto.randomUUID(),postback:{data}}]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
  const res=await worker.fetch(new Request('https://local.test/webhook',{method:'POST',headers:{'x-line-signature':sig},body}),env,{});assert.equal(res.status,200);
 };
 const logs=()=>DB.prepare("SELECT * FROM logs WHERE sourceMessageId LIKE 'frequent-%' AND isDeleted=0").all().results;
 const last=()=>sent.at(-1).messages.at(-1);
 try{await run({DB,env,sent,say,click,logs,last});}finally{globalThis.fetch=old;}
}
test('自然語言主食31、水5與多筆照常，完成回讀包含貓與數字並再附六快捷',()=>setup(async({say,logs,last})=>{
 await say('主食31');assert.equal(logs()[0].foodType,'主食罐');assert.equal(logs()[0].amount,31);assert.match(JSON.stringify(last()),/小花/);assert.match(JSON.stringify(last()),/31/);assert.equal(last().quickReply.items.length,6);
 await say('水5');assert.equal(logs().at(-1).amount,5);assert.equal(logs().at(-1).category,'water');
 await say('主食31 水5');assert.equal(logs().length,4);assert.equal(last().quickReply.items.length,6);
}));
test('記一筆→六類型→主食→31；單貓無選貓、不猜份量、不必進LIFF',()=>setup(async({say,click,logs,last})=>{
 await say('記一筆');const items=last().quickReply.items;assert.deepEqual(items.map(i=>i.action.label),['主食','乾乾','水','藥','尿尿','便便']);assert.equal(items.length,6);assert.doesNotMatch(JSON.stringify(last()),/"type":"uri"/);assert.match(JSON.stringify(last()),/action=recmore/);
 await click(items[0].action.data);assert.equal(logs().length,0);assert.match(last().text,/主食，要記多少/);assert.doesNotMatch(last().text,/選.*貓/);
 await say('31');assert.equal(logs().length,1);assert.equal(logs()[0].amount,31);assert.equal(logs()[0].petId,'s1');assert.equal(last().quickReply.items.length,6);
 await click(last().quickReply.items[2].action.data);await say('5');assert.equal(logs().at(-1).amount,5);
}));
test('多貓未選對象：先填數字仍不寫入，沿用既有選貓後只記指定貓',()=>setup(async({say,click,logs,last,DB})=>{
 await say('記一筆');assert.doesNotMatch(last().quickReply.items[0].action.data,/petId/);
 await click(last().quickReply.items[0].action.data);await say('31');assert.equal(logs().length,0);assert.match(last().text,/這筆要記給哪隻貓/);
 await say('麵線');assert.equal(logs().length,1);assert.equal(logs()[0].petId,'p2');assert.equal(logs()[0].amount,31);assert.match(JSON.stringify(last()),/麵線/);
 await click(last().quickReply.items[2].action.data);await say('5');assert.equal(logs().at(-1).petId,'p2');
},'owner'));
test('多貓已選對象：免重選；外家petId拒絕，切換貓會取消舊數量輸入',()=>setup(async({say,click,logs,last,DB})=>{
 await say('蚵仔');await say('記一筆');await click(last().quickReply.items[0].action.data);await say('31');assert.equal(logs()[0].petId,'p1');
 await click('action=frequent&kind=water&petId=x1');assert.match(last().text,/找不到這隻貓/);assert.equal(logs().length,1);
 await click('action=frequent&kind=water&petId=p1');await say('麵線');assert.equal(DB.prepare("SELECT pendingAction FROM users WHERE lineUserId='owner'").first().pendingAction,'');await say('5');assert.equal(logs().length,1);
},'owner'));
test('藥、尿尿、便便先問情況；只在使用者選定後沿用parser寫入',()=>setup(async({say,click,logs,last})=>{
 for(const [kind,label,category] of [['med','未餵','med'],['urine','只記有尿尿','urine'],['stool','只記有便便','stool']]){
  const count=logs().length;await click(`action=frequent&kind=${kind}&petId=s1`);assert.equal(logs().length,count);
  const choice=last().quickReply.items.find(i=>i.action.label===label);await say(choice.action.text);assert.equal(logs().at(-1).category,category);assert.equal(last().quickReply.items.length,6);
 }
 assert.equal(logs()[0].medStatus,'漏餵'); // existing parser's normalized storage value for 未餵
}));
test('取消、逾時及自然語言插入不誤記；小數不四捨五入',()=>setup(async({DB,say,click,logs,last})=>{
 await click('action=frequent&kind=water');await say('取消');await say('5');assert.equal(logs().length,0);
 DB.prepare("UPDATE users SET pendingAction=? WHERE lineUserId='single'").bind('amount|主食|s1|1').run();await say('31');assert.match(last().text,/逾時/);assert.equal(logs().length,0);
 await click('action=frequent&kind=wet');await say('水5');assert.equal(logs().length,1);assert.equal(logs()[0].category,'water');
 await click('action=frequent&kind=dry');await say('3.1');assert.equal(logs().at(-1).amount,3.1);
}));
test('Flex無法顯示時文字備援也保留六快捷',async()=>{
 const old=fetch,sent=[];let failed=false;globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);if(!failed){failed=true;return new Response('no flex',{status:400});}return new Response('{}');};
 try{await replyOrPushFlex({LINE_CHANNEL_ACCESS_TOKEN:'test'},{source:{userId:'single'},replyToken:'test'},{type:'flex',altText:'確認',contents:{},quickReply:{items:frequentRecordItems('s1')}},'已記錄 小花 水5');assert.equal(sent[1].messages[0].type,'text');assert.equal(sent[1].messages[0].quickReply.items.length,6);}finally{globalThis.fetch=old;}
});
test('近七天、照護月曆、LIFF與共照API仍可使用；後台入口保留',()=>setup(async({DB,env,say,last})=>{
 await say('近七天記錄');assert.equal(last().type,'flex');assert.match(JSON.stringify(last()),/小花/);
 await say('照護月曆');assert.equal(last().type,'flex');assert.match(JSON.stringify(last()),/小花/);
 const cfg=await worker.fetch(new Request('https://local.test/api/liff-config'),env,{});assert.equal((await cfg.json()).liffId,'test-liff');
 const me=await worker.fetch(new Request('https://local.test/api/me',{headers:{authorization:'Bearer testhelper'}}),env,{});assert.equal(me.status,200);assert.match(await me.text(),/蚵仔/);
 await say('管家後台');assert.match(JSON.stringify(last()),/https:\/\/liff.line.me\/test-liff/);
}));
test('從照護報告補填切換到藥物快捷，不會把用藥文字存成餵食範本',()=>setup(async({DB,say,click,logs})=>{
 DB.prepare('INSERT INTO app_kv(k,v,updatedAt) VALUES (?,?,?)').bind('lineReportFlow:single',JSON.stringify({id:'test',owner:'single',petId:'s1',stage:'feeding',expiresAt:Date.now()+60000}),new Date().toISOString()).run();
 await click('action=frequent&kind=med&petId=s1');await say('小花 藥 晚 已吃');assert.equal(logs().length,1);assert.equal(logs()[0].category,'med');assert.equal(DB.prepare("SELECT v FROM app_kv WHERE k='careTemplate:single:s1'").first(),null);
}));
