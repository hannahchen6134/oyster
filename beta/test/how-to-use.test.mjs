import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTextMessage} from '../src/index.js';
import {reportFixture} from './support/report-fixture.mjs';
import {parseMessage} from '../src/parser.js';
import {detailedHelpFlex,HELP_EXAMPLES,recordExamplesFlex,quickRecordCarousel,howToUseText} from '../src/flex.js';
test('新手例句全部可以記錄；填入例句不直接送出',()=>{
 for(const [,examples] of HELP_EXAMPLES) for(const example of examples) assert.equal(parseMessage(example.includes('\n')?example.replace('\n','31\n')+'5':example).type,example.includes('\n')?'multiRecord':'record',example);
 const actions=[];const walk=o=>{if(!o||typeof o!=='object')return;if(o.action)actions.push(o.action);Object.values(o).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));};walk(recordExamplesFlex());
 for(const a of actions.filter(a=>a.type==='postback')){assert.equal(a.data,'action=fill');assert.equal(a.inputOption,'openKeyboard');assert.ok(a.fillInText);assert.equal(a.displayText,undefined);}
});
test('新手說明所有文字入口通往現有功能，閱讀不新增紀錄',async()=>{
 const DB=await reportFixture(),old=fetch,sent=[];
 const env={DB,LINE_CHANNEL_ACCESS_TOKEN:'test',LINE_CHANNEL_SECRET:'test',LIFF_ID:'test-liff',ASSETS:{fetch:async()=>new Response('png')}};
 globalThis.fetch=async(url,options={})=>{if(String(url).includes('/message/'))sent.push(JSON.parse(options.body));return new Response('{"richMenuId":"test-menu"}');};
 try{
  const before=DB.prepare('SELECT COUNT(*) n FROM logs').first().n;
  for(const [command,expected] of [['怎麼記','喵喵管家怎麼用'],['完整記法','想看哪一種記法'],['記法：補登・指定時間','昨天 21:30 喝水30'],['記一筆','主食'],['摘要','需要分享哪隻貓'],['出報告','需要分享哪隻貓'],['更多紀錄範例','更多紀錄範例'],['近七天記錄','近 7 天'],['管家後台','https://liff.line.me/test-liff']]){
   sent.length=0;await handleTextMessage({source:{type:'user',userId:'single'},replyToken:'test',message:{id:'help-'+crypto.randomUUID(),text:command}},env,'https://local.test');
   assert.ok(JSON.stringify(sent).includes(expected),command+': '+JSON.stringify(sent));
   const shortcuts=sent.at(-1)?.messages.at(-1)?.quickReply?.items;
   if(['摘要','出報告'].includes(command)) assert.ok(!shortcuts?.some(i=>i.action.data?.includes('action=frequent')),command+' 必須保留選貓流程');
   else assert.ok(shortcuts?.some(i=>i.action.data?.includes('action=frequent')),command+' 回覆後應補回常用快捷');
  }
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM logs').first().n,before);
 }finally{globalThis.fetch=old;}
});



test('完整記法先選分類，每次只顯示該類內容',()=>{const menu=JSON.stringify(detailedHelpFlex());assert.ok(menu.includes('想看哪一種記法'));assert.ok(!menu.includes('主食3'));const card=JSON.stringify(detailedHelpFlex('補登・指定時間'));assert.ok(card.includes('昨天 21:30 喝水30'));assert.ok(!card.includes('藥 心臟藥'));assert.ok(card.includes('其他記法'));});

test('怎麼記與文字備援教兩行補數量，不教0範本',()=>{for(const s of [JSON.stringify(quickRecordCarousel()),howToUseText()]){assert.match(s,/兩行/);assert.match(s,/補數量/);assert.doesNotMatch(s,/主食0水0|把 0/);assert.doesNotMatch(s,/31 5|填兩個數字/);}});
