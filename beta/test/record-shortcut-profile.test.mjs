import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFixture } from './support/report-fixture.mjs';
import { insertLog, getUser } from '../src/db.js';
import { withLineEvent, LINE_EVENT } from '../src/line-event.js';
import { taipeiToday, addDays } from '../src/util.js';
import { rankRecordShortcuts, readShortcutProfile, prepareShortcutProfile, shortcutProfileKey } from '../src/record-shortcut-profile.js';
import { FREQUENT_RECORDS, withFrequentRecords, personalizeFrequentMessage } from '../src/frequent-records.js';
const repeated=(category,n,extra={})=>Array.from({length:n},()=>({category,...extra}));

test('依實際頻率排序、合併乾糧同義詞、增減到5至7項並永遠保留更多',()=>{
  assert.deepEqual(rankRecordShortcuts(repeated('water',2)),FREQUENT_RECORDS);
  const rows=[...repeated('water',18),...repeated('supplement',9),...repeated('med',8),...repeated('food',7,{foodType:'乾糧'})];
  const ranked=rankRecordShortcuts(rows,[],'乾糧');
  assert.deepEqual(ranked.slice(0,4),[['水','water'],['保健','supplement'],['藥','med'],['乾糧','dry']]);
  assert.equal(ranked.filter(([,kind])=>kind==='dry').length,1);
  assert.equal(ranked.length,6);assert.deepEqual(ranked.at(-1),['更多紀錄','more']);
  const full=rankRecordShortcuts([...rows,...repeated('stool',4),...repeated('urine',4),...repeated('weight',4),...repeated('mood',4)]);
  assert.equal(full.length,8);assert.deepEqual(full.at(-1),['更多紀錄','more']);
  const tied=rankRecordShortcuts([...repeated('water',10),...repeated('med',10)],[['藥','med'],['水','water']]);
  assert.deepEqual(tied.slice(0,2),[['藥','med'],['水','water']]);
});

test('快取只接受本人目前家庭與受支援關鍵字；壞值、過期與任意文字安全退回',()=>{
  const at=Date.now(),p={version:1,owner:'one',at,day:taipeiToday(),entries:rankRecordShortcuts(repeated('water',20))};
  assert.ok(readShortcutProfile(JSON.stringify(p),'one',at));
  for(const raw of ['invalid',{...p,owner:'other'},{...p,at:at-31*86400000},{...p,entries:[['custom secret','water'],...p.entries.slice(1)]}])assert.equal(readShortcutProfile(raw,'one',at),null);
});

test('只統計近30天本人有效紀錄；共照者、外家、刪除、未來、食物連動加水不混入',async()=>{
  const DB=await reportFixture(),today=taipeiToday();
  DB.prepare("UPDATE logs SET isDeleted=1 WHERE sourceMessageId LIKE 'fixture%'").run();
  const put=async(category,n,extra={})=>{for(let i=0;i<n;i++)await insertLog(DB,{lineUserId:'owner',recordedBy:'owner',petId:'p1',eventDateTime:today+' 12:00',category,source:'line',...extra});};
  await put('water',20);
  await put('mood',35,{recordedBy:'helper'});
  await put('vomit',35,{petId:'x1',lineUserId:'stranger',recordedBy:'stranger'});
  await put('supplement',35,{eventDateTime:addDays(today,-31)+' 12:00'});
  await put('weight',35,{eventDateTime:addDays(today,2)+' 12:00'});
  await put('stool',35);DB.prepare("UPDATE logs SET isDeleted=1 WHERE category='stool'").run();
  await put('water',30,{note:'罐頭加水',recordedBy:'helper'});
  const user=await getUser(DB,'owner',{shortcuts:true}),pets=DB.prepare("SELECT * FROM pets WHERE ownerLineUserId='owner'").all().results;
  const prepare=async(actor,user)=>withLineEvent({DB},{source:{userId:actor}},async env=>{
    await prepareShortcutProfile(env,user,'owner',pets,{source:{userId:actor}});
    assert.equal(DB.prepare('SELECT v FROM app_kv WHERE k=?').bind(shortcutProfileKey(actor)).first(),null,'refresh must wait until handler completion');
    env[LINE_EVENT].phase='after_reply';
  });
  try{
    await prepare('owner',user);
    const owner=JSON.parse(DB.prepare('SELECT v FROM app_kv WHERE k=?').bind(shortcutProfileKey('owner')).first().v);
    assert.equal(owner.entries[0][1],'water');assert.equal(owner.entries.some(([,kind])=>['mood','vomit','supplement','weight','stool'].includes(kind)),false);
    await prepare('helper',await getUser(DB,'helper',{shortcuts:true}));
    const helper=JSON.parse(DB.prepare('SELECT v FROM app_kv WHERE k=?').bind(shortcutProfileKey('helper')).first().v);
    assert.equal(helper.entries[0][1],'mood');
    assert.doesNotMatch(JSON.stringify(owner),/amount|rawText|sourceMessageId|recordedBy/);
    assert.equal(DB.prepare("SELECT v FROM app_kv WHERE k='recordShortcuts:stranger'").first(),null);
    await withLineEvent({DB},{source:{userId:'owner'}},async env=>{
      await prepareShortcutProfile(env,await getUser(DB,'owner',{shortcuts:true}),'owner',pets,{source:{userId:'owner'}});
      assert.equal(env[LINE_EVENT].effects.size,0);assert.deepEqual(env[LINE_EVENT].shortcutEntries,owner.entries);
    });
  }finally{DB.sdb.close();}
});

test('個人化卡片保留指定貓、同寬三欄與摘要補填選項，不改情境選擇或原物件',()=>{
  const entries=rankRecordShortcuts([...repeated('water',20),...repeated('supplement',10)]);
  const original=withFrequentRecords({type:'flex',altText:'test',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[]}}},'p1',{petName:'蚵仔'});
  original.quickReply.items.push({type:'action',action:{type:'postback',label:'補充照護說明',data:'action=reportEdit'}});
  const before=JSON.stringify(original),message=personalizeFrequentMessage(original,entries);
  assert.equal(message.quickReply.items[0].action.label,'水');assert.equal(message.quickReply.items.at(-1).action.label,'補充照護說明');
  const rows=message.contents.body.contents.at(-1).contents.slice(1);
  assert.ok(rows.every(row=>row.contents.length===3));
  for(const cell of rows.flatMap(r=>r.contents).filter(c=>c.action)){assert.equal(cell.height,undefined);assert.equal(cell.minHeight,undefined);assert.equal(cell.paddingTop,'14px');assert.equal(cell.contents[0].wrap,true);}
  const actions=rows.flatMap(row=>row.contents.map(cell=>cell.action).filter(Boolean));
  assert.equal(actions[0].fillInText,'蚵仔 水');assert.match(actions[0].data,/petId=p1/);
  assert.equal(actions[1].fillInText,'蚵仔 保健');assert.equal(actions[1].displayText,undefined);
  assert.equal(actions.at(-1).label,'更多紀錄');assert.equal(JSON.stringify(original),before);
  const choice={type:'text',text:'選貓',quickReply:{items:[{type:'action',action:{type:'message',label:'麵線',text:'麵線'}}]}};
  assert.deepEqual(personalizeFrequentMessage(choice,entries),choice);
});
