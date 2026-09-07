import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{handleTextMessage} from '../src/index.js';
import {reportFixture} from './support/report-fixture.mjs';
import {frequentRecordItems,ALL_RECORDS} from '../src/frequent-records.js';
import {shortcutProfileKey} from '../src/record-shortcut-profile.js';
import {taipeiToday} from '../src/util.js';
import {replyOrPushFlex,replyMessages} from '../src/line.js';
import {withLineEvent,LINE_EVENT} from '../src/line-event.js';
async function setup(run,actor='single'){
 const DB=await reportFixture(),env={DB,LINE_CHANNEL_ACCESS_TOKEN:'test',LINE_CHANNEL_SECRET:'test-secret',LIFF_ID:'test-liff',ASSETS:{fetch:async()=>new Response('png')}},sent=[],old=fetch;
 globalThis.fetch=async(url,options={})=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{"richMenuId":"test-menu"}');};
 const event=()=>({source:{type:'user',userId:actor},replyToken:'test'});
 const say=async(text)=>{const id='frequent-'+crypto.randomUUID();await handleTextMessage({...event(),message:{id,text}},env,'https://local.test');return id;};
 const click=async(data,eventId=crypto.randomUUID())=>{
  const body=JSON.stringify({events:[{...event(),type:'postback',webhookEventId:eventId,postback:{data}}]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
  const res=await worker.fetch(new Request('https://local.test/webhook',{method:'POST',headers:{'x-line-signature':sig},body}),env,{});assert.equal(res.status,200);
 };
 const logs=()=>DB.prepare("SELECT * FROM logs WHERE sourceMessageId LIKE 'frequent-%' AND isDeleted=0").all().results;
 const last=()=>sent.at(-1).messages.at(-1);
 try{await run({DB,env,sent,say,click,logs,last});}finally{globalThis.fetch=old;}
}
test('摘要選單使用專用 postback 直接選貓，不需要文字指令',()=>setup(async({click,last})=>{
 await click('action=reportStart');assert.match(JSON.stringify(last()),/需要分享哪隻貓的摘要/);assert.doesNotMatch(JSON.stringify(last()),/"type":"uri"/);
}));
test('新舊摘要文字入口都先回選貓卡，不開後台',()=>setup(async({say,last})=>{
 for(const text of ['出摘要','出報告','給醫生看','就醫使用','照護使用','給照護者']){
  await say(text);assert.match(JSON.stringify(last()),/需要分享哪隻貓的摘要/);assert.match(JSON.stringify(last()),/action=reportPet/);assert.doesNotMatch(JSON.stringify(last()),/"type":"uri"|liff.line.me/);
 }
}));
test('更多紀錄事件重送與不同事件同時到達，只回一次；稍後可再次開啟且不擋紀錄',()=>setup(async({click,sent,DB,say,logs,last})=>{
 await Promise.all([click('action=recmore','repeat'),click('action=recmore','repeat'),click('action=recmore','other'),click('action=recmore','third')]);
 assert.equal(sent.length,1);assert.equal(last().text,'選一個類別，接著填數字或情況 👇');assert.deepEqual(last().quickReply.items.map(i=>i.action.label),ALL_RECORDS.map(([label])=>label));
 await say('水5');assert.equal(logs().length,1);
 DB.prepare("UPDATE app_kv SET v='0' WHERE k='msg:menu:recmore:single'").run();
 await click('action=recmore');assert.equal(sent.filter(p=>p.messages[0].text==='選一個類別，接著填數字或情況 👇').length,2);
}));
test('更多紀錄 reply 明確失敗時只 push 一次，連續事件不再補送',()=>setup(async({click})=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('/message/')){calls.push(String(url));return new Response('{}',{status:String(url).endsWith('/reply')?400:200});}
  return original(url,options);
 };
 try{await click('action=recmore');await click('action=recmore');assert.equal(calls.filter(u=>u.endsWith('/reply')).length,1);assert.equal(calls.filter(u=>u.endsWith('/push')).length,1);}finally{globalThis.fetch=original;}
}));
test('自然語言主食31、水5與多筆照常，完成回讀包含貓與數字並再附八快捷',()=>setup(async({say,logs,last})=>{
 await say('主食31');assert.equal(logs()[0].foodType,'主食罐');assert.equal(logs()[0].amount,31);assert.match(JSON.stringify(last()),/小花/);assert.match(JSON.stringify(last()),/31/);assert.equal(last().quickReply.items.length,8);
 await say('水5');assert.equal(logs().at(-1).amount,5);assert.equal(logs().at(-1).category,'water');
 await say('主食31 水5');assert.equal(logs().length,4);assert.equal(last().quickReply.items.length,8);
}));
test('主食快捷帶入原生輸入框；點擊不送訊息不等待數字，補31送出才記錄',()=>setup(async({say,click,logs,last,sent,DB})=>{
 await say('記一筆');const items=last().quickReply.items;assert.deepEqual(items.map(i=>i.action.label),['主食','乾乾','零食','水','藥','尿尿','便便','更多紀錄']);assert.equal(items.length,8);assert.doesNotMatch(JSON.stringify(last()),/"type":"uri"/);assert.match(JSON.stringify(last()),/action=recmore/);
 const count=sent.length;assert.equal(items[0].action.fillInText,'主食');assert.equal(items[0].action.inputOption,'openKeyboard');assert.equal(items[0].action.displayText,undefined);
 await click(items[0].action.data);assert.equal(logs().length,0);assert.equal(sent.length,count);assert.equal(DB.prepare("SELECT pendingAction FROM users WHERE lineUserId='single'").first().pendingAction,'');
 await say(items[0].action.fillInText+'31');assert.equal(logs().length,1);assert.equal(logs()[0].amount,31);assert.equal(logs()[0].petId,'s1');assert.equal(last().quickReply.items.length,8);
 const water=last().quickReply.items.find(i=>i.action.label==='水').action;assert.equal(water.fillInText,'水');await click(water.data);await say(water.fillInText+'5');assert.equal(logs().at(-1).amount,5);
}));
test('所有常用關鍵字填入輸入框，乾乾乾糧同類、零食與藥補完才寫入',()=>setup(async({say,click,logs,sent,DB})=>{
 for(const [label,suffix,expected] of [['主食','31','主食罐'],['乾乾','3.1','乾糧'],['乾糧','4','乾糧'],['零食','2','零食'],['水','5','water'],['藥',' 晚 已吃','med']]){
  const action=(label==='乾糧'?frequentRecordItems('','',[['乾糧','dry']]):frequentRecordItems()).find(i=>i.action.label===label).action;
  assert.equal(action.fillInText,label);assert.equal(action.inputOption,'openKeyboard');assert.equal(action.displayText,undefined);
  DB.prepare("UPDATE users SET pendingAction='amount|水|s1|1' WHERE lineUserId='single'").run();
  const before=logs().length,count=sent.length;await click(action.data);assert.equal(logs().length,before);assert.equal(sent.length,count);
  assert.equal(DB.prepare("SELECT pendingAction FROM users WHERE lineUserId='single'").first().pendingAction,'');
  await say(action.fillInText+suffix);assert.equal(logs().length,before+1);assert.equal(logs().at(-1).foodType||logs().at(-1).category,expected);
 }
 assert.equal(frequentRecordItems('p1','蚵仔')[0].action.fillInText,'蚵仔 主食');
}));
test('多貓未選對象：先填數字仍不寫入，沿用既有選貓後只記指定貓',()=>setup(async({say,click,logs,last,DB})=>{
 await say('記一筆');assert.doesNotMatch(last().quickReply.items[0].action.data,/petId/);
 await click(last().quickReply.items[0].action.data);await say('主食31');assert.equal(logs().length,0);assert.match(last().text,/這筆要記給哪隻貓/);
 await say('麵線');assert.equal(logs().length,1);assert.equal(logs()[0].petId,'p2');assert.equal(logs()[0].amount,31);assert.match(JSON.stringify(last()),/麵線/);
 await click(last().quickReply.items.find(i=>i.action.label==='水').action.data);await say('水5');assert.equal(logs().at(-1).petId,'p2');
},'owner'));
test('多貓已選對象：免重選；外家petId拒絕，切換貓會取消舊數量輸入',()=>setup(async({say,click,logs,last,DB})=>{
 await say('蚵仔');await say('記一筆');await click(last().quickReply.items[0].action.data);await say('主食31');assert.equal(logs()[0].petId,'p1');
 await click('action=frequent&kind=water&petId=x1');assert.match(last().text,/找不到這隻貓/);assert.equal(logs().length,1);
 await click('action=frequent&kind=water&petId=p1');await say('麵線');assert.equal(DB.prepare("SELECT pendingAction FROM users WHERE lineUserId='owner'").first().pendingAction,'');await say('5');assert.equal(logs().length,1);
},'owner'));
test('藥、尿尿、便便先問情況；只在使用者選定後沿用parser寫入',()=>setup(async({say,click,logs,last})=>{
 for(const [kind,label,category] of [['med','未餵','med'],['urine','只記有尿尿','urine'],['stool','只記有便便','stool']]){
  const count=logs().length;await click(`action=frequent&kind=${kind}&petId=s1`);assert.equal(logs().length,count);
  const choice=last().quickReply.items.find(i=>i.action.label===label);await say(choice.action.text);assert.equal(logs().at(-1).category,category);assert.equal(last().quickReply.items.length,8);
 }
 assert.equal(logs()[0].medStatus,'漏餵'); // existing parser's normalized storage value for 未餵
}));
test('取消、逾時及自然語言插入不誤記；小數不四捨五入',()=>setup(async({DB,say,click,logs,last})=>{
 await click('action=frequent&kind=water');await say('取消');await say('5');assert.equal(logs().length,0);
 DB.prepare("UPDATE users SET pendingAction=? WHERE lineUserId='single'").bind('amount|主食|s1|1').run();await say('31');assert.match(last().text,/逾時/);assert.equal(logs().length,0);
 await click('action=frequent&kind=wet');await say('水5');assert.equal(logs().length,1);assert.equal(logs()[0].category,'water');
 await click('action=frequent&kind=dry');await say('3.1');assert.equal(logs().at(-1).amount,3.1);
}));
test('Flex無法顯示時文字備援也保留八快捷',async()=>{
 const old=fetch,sent=[];let failed=false;globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);if(!failed){failed=true;return new Response('no flex',{status:400});}return new Response('{}');};
 try{await replyOrPushFlex({LINE_CHANNEL_ACCESS_TOKEN:'test'},{source:{userId:'single'},replyToken:'test'},{type:'flex',altText:'確認',contents:{},quickReply:{items:frequentRecordItems('s1')}},'已記錄 小花 水5');assert.equal(sent[1].messages[0].type,'text');assert.equal(sent[1].messages[0].quickReply.items.length,8);}finally{globalThis.fetch=old;}
});
test('近七天、照護月曆、LIFF與共照API仍可使用；後台入口保留',()=>setup(async({DB,env,say,last})=>{
 await say('近七天記錄');assert.equal(last().type,'flex');assert.match(JSON.stringify(last()),/小花/);
 await say('照護月曆');assert.equal(last().type,'flex');assert.match(JSON.stringify(last()),/小花/);
 const cfg=await worker.fetch(new Request('https://local.test/api/liff-config'),env,{});assert.equal((await cfg.json()).liffId,'test-liff');
 const me=await worker.fetch(new Request('https://local.test/api/me',{headers:{authorization:'Bearer testhelper'}}),env,{});assert.equal(me.status,200);assert.match(await me.text(),/蚵仔/);
 await say('管家後台');assert.match(JSON.stringify(last()),/https:\/\/liff.line.me\/test-liff/);
}));
test('從照護摘要補填切換到藥物快捷，不會把用藥文字存成餵食範本',()=>setup(async({DB,say,click,logs})=>{
 DB.prepare('INSERT INTO app_kv(k,v,updatedAt) VALUES (?,?,?)').bind('lineReportFlow:single',JSON.stringify({id:'test',owner:'single',petId:'s1',stage:'feeding',expiresAt:Date.now()+60000}),new Date().toISOString()).run();
 await click('action=frequent&kind=med&petId=s1');await say('小花 藥 晚 已吃');assert.equal(logs().length,1);assert.equal(logs()[0].category,'med');assert.equal(DB.prepare("SELECT v FROM app_kv WHERE k='careTemplate:single:s1'").first(),null);
}));

test('快捷列收起後仍可重用卡片內主食與水按鈕，點擊不增加問答或誤記',()=>setup(async({say,click,last,sent,logs})=>{
 await say('記一筆');
 const grid=last().contents.body.contents.at(-1);
 const actions=grid.contents.slice(1).flatMap(row=>row.contents.map(cell=>cell.action));
 assert.deepEqual(actions.map(a=>a.label),last().quickReply.items.map(item=>item.action.label));
 assert.equal(actions[0].fillInText,'小花 主食');
 const food=actions.find(a=>a.label==='主食'),water=actions.find(a=>a.label==='水');
 let count=sent.length;await click(food.data);assert.equal(sent.length,count);assert.equal(logs().length,0);
 await say(food.fillInText+'12');assert.equal(logs().at(-1).amount,12);
 count=sent.length;await click(water.data);assert.equal(sent.length,count);assert.equal(logs().length,1);
 await say(water.fillInText+'2');assert.equal(logs().at(-1).amount,2);assert.equal(logs().at(-1).category,'water');
 assert.equal(last().contents.body.contents.at(-1).contents.slice(1).flatMap(r=>r.contents).length,8);
}));

test('查看今日、近七天、月曆、後台後最後回覆都有常用快捷，不需要重新開記一筆',()=>setup(async({say,last,logs})=>{
 for(const command of ['今天','近七天記錄','照護月曆','管家後台','最近吃什麼']){
  await say(command);assert.deepEqual(last().quickReply.items.map(i=>i.action.label),['主食','乾乾','零食','水','藥','尿尿','便便','更多紀錄']);
 }
 assert.equal(logs().length,0);
}));

test('多則回覆保留原本的情境選項到最後一則，不用常用快捷蓋掉選貓或確認',()=>setup(async({env,sent})=>{
 const custom={items:[{type:'action',action:{type:'message',label:'麵線',text:'麵線'}}]};
 const messages=[{type:'text',text:'選貓',quickReply:custom},{type:'text',text:'請選這筆的對象'}];
 await withLineEvent(env,{source:{userId:'single'}},async scoped=>{
  scoped[LINE_EVENT].defaultQuickReply={items:frequentRecordItems()};
  await replyMessages(scoped,'test',messages);
 });
 assert.deepEqual(sent.at(-1).messages.at(-1).quickReply,custom);
 assert.equal(messages.at(-1).quickReply,undefined);
}));

test('個人常用排序在記一筆及完成卡一致；更多可取回被收起類別，點擊不會自行儲存',()=>setup(async({DB,say,click,last,logs,sent})=>{
 const entries=[['水','water'],['保健','supplement'],['藥','med'],['主食','wet'],['乾糧','dry'],['更多紀錄','more']];
 DB.prepare('INSERT INTO app_kv(k,v,updatedAt) VALUES(?,?,?)').bind(shortcutProfileKey('single'),JSON.stringify({version:1,owner:'single',at:Date.now(),day:taipeiToday(),entries}),new Date().toISOString()).run();
 await say('記一筆');assert.deepEqual(last().quickReply.items.map(i=>i.action.label),entries.map(([label])=>label));
 const supplement=last().quickReply.items.find(i=>i.action.label==='保健').action,count=sent.length;
 await click(supplement.data);assert.equal(sent.length,count);assert.equal(logs().length,0);
 await say(supplement.fillInText+' 益生菌');assert.equal(logs().at(-1).category,'supplement');assert.deepEqual(last().quickReply.items.map(i=>i.action.label),entries.map(([label])=>label));
 await click(last().quickReply.items.at(-1).action.data);assert.deepEqual(last().quickReply.items.map(i=>i.action.label),ALL_RECORDS.map(([label])=>label));
 const stool=last().quickReply.items.find(i=>i.action.label==='便便').action,before=logs().length;
 await click(stool.data);assert.equal(logs().length,before);await say(last().quickReply.items.find(i=>i.action.label==='正常').action.text);assert.equal(logs().at(-1).category,'stool');
}));

test('切換貓後重用舊卡片，帶入卡片上的貓名，不會默默寫到另一隻',()=>setup(async({say,click,last,logs})=>{
 await say('蚵仔');await say('水2');
 const actions=last().contents.body.contents.at(-1).contents.slice(1).flatMap(r=>r.contents.map(c=>c.action));
 const water=actions.find(a=>a.label==='水');assert.equal(water.fillInText,'蚵仔 水');
 await say('麵線');await click(water.data);await say(water.fillInText+'3');
 assert.equal(logs().at(-1).petId,'p1');assert.equal(logs().at(-1).amount,3);
},'owner'));
