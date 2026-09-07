import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTextMessage} from '../src/index.js';
import {reportFixture} from './support/report-fixture.mjs';
import {parseMessage} from '../src/parser.js';
import {HELP_EXAMPLES,recordExamplesFlex,quickRecordCarousel} from '../src/flex.js';
test('新手例句全部可以記錄；填入例句不直接送出',()=>{
 for(const [,examples] of HELP_EXAMPLES) for(const example of examples) assert.equal(parseMessage(example).type,'record',example);
 const actions=[];const walk=o=>{if(!o||typeof o!=='object')return;if(o.action)actions.push(o.action);Object.values(o).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));};walk(recordExamplesFlex());
 for(const a of actions.filter(a=>a.type==='postback')){assert.equal(a.data,'action=fill');assert.equal(a.inputOption,'openKeyboard');assert.ok(a.fillInText);assert.equal(a.displayText,undefined);}
});
test('新手說明所有文字入口通往現有功能，閱讀不新增紀錄',async()=>{
 const DB=await reportFixture(),old=fetch,sent=[];
 const env={DB,LINE_CHANNEL_ACCESS_TOKEN:'test',LINE_CHANNEL_SECRET:'test',LIFF_ID:'test-liff',ASSETS:{fetch:async()=>new Response('png')}};
 globalThis.fetch=async(url,options={})=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{"richMenuId":"test-menu"}');};
 try{
  const before=DB.prepare('SELECT COUNT(*) n FROM logs').first().n;
  for(const [command,expected] of [['怎麼記','喵喵管家怎麼用'],['記一筆','主食'],['摘要','需要分享哪隻貓'],['出報告','需要分享哪隻貓'],['更多紀錄範例','更多紀錄範例'],['近七天記錄','近 7 天'],['管家後台','https://liff.line.me/test-liff']]){
   sent.length=0;await handleTextMessage({source:{type:'user',userId:'single'},replyToken:'test',message:{id:'help-'+crypto.randomUUID(),text:command}},env,'https://local.test');
   assert.ok(JSON.stringify(sent).includes(expected),command+': '+JSON.stringify(sent));
  }
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM logs').first().n,before);
 }finally{globalThis.fetch=old;}
});


