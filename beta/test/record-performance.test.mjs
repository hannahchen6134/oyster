import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { reportFixture } from './support/report-fixture.mjs';
import { computeDailySummary } from '../src/summary.js';
import { getLogsForDay, ensureTaskSchema } from '../src/db.js';
import { taipeiToday } from '../src/util.js';
import { recordFlex } from '../src/flex.js';
import { withLineEvent } from '../src/line-event.js';
import { startRecordLoading, replyMessages } from '../src/line.js';

function gate() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }

async function fixture(run, hooks = {}) {
  const DB = await reportFixture();
  await ensureTaskSchema(DB);
  DB.sdb.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,lineUserId TEXT,event TEXT,meta TEXT,createdAt TEXT)");
  for (const actor of ['single','owner','helper']) {
    DB.prepare('INSERT INTO app_kv(k,v,updatedAt) VALUES(?,?,?)').bind(`menu:${actor}`, JSON.stringify({ v:10, menuId:'fake', token:`test${actor}` }), new Date().toISOString()).run();
  }
  DB.prepare("UPDATE users SET defaultPetId='p1' WHERE lineUserId IN ('owner','helper')").run();
  DB.prepare('UPDATE pets SET goalWaterMl=200,goalKcal=220').run();
  const env = { DB, LINE_CHANNEL_ACCESS_TOKEN:'fake-secret', LINE_CHANNEL_SECRET:'fake-secret', LIFF_ID:'fake', ASSETS:{ fetch:async()=>new Response('png') } };
  const calls = [], sql = [], timings = [], warnings = [], originalPrepare = DB.prepare.bind(DB);
  DB.prepare = query => {
    const s = originalPrepare(query), bind = s.bind.bind(s); let args = [];
    s.bind = (...values) => { args = values; bind(...values); return s; };
    for (const method of ['run','first','all']) {
      const original = s[method].bind(s);
      s[method] = async () => {
        sql.push({ query, args });
        await hooks.sql?.(query, args);
        return original();
      };
    }
    return s;
  };
  const oldFetch = globalThis.fetch, oldLog = console.log, oldWarn = console.warn, oldError = console.error;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const call = { path, body, signal: options.signal }; calls.push(call);
    return await hooks.line?.(call) || new Response('{"richMenuId":"fake-new"}');
  };
  console.log = value => { if (typeof value === 'string' && value.startsWith('{')) { const m=JSON.parse(value); if(m.type==='line_record_timing')timings.push(m); } };
  console.warn = (...values) => warnings.push(values);
  console.error = (...values) => warnings.push(values);
  const send = async (text, { actor = 'single', id = crypto.randomUUID(), invalid = false } = {}) => {
    const event = { type:'message', webhookEventId:id, replyToken:'fake-reply', source:{ type:'user', userId:actor }, message:{ type:'text', id, text } };
    const body = JSON.stringify({ events:[event] });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('fake-secret'), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64');
    const jobs = [];
    const response = await worker.fetch(new Request('https://test.invalid/webhook', { method:'POST', headers:{ 'x-line-signature':invalid ? 'wrong' : sig }, body }), env, { waitUntil:p => jobs.push(p) });
    return { response, done:Promise.all(jobs), id };
  };
  try { await run({ DB, env, calls, sql, timings, warnings, send, read:q => originalPrepare(q).all().results, originalPrepare }); }
  finally { globalThis.fetch=oldFetch; console.log=oldLog; console.warn=oldWarn; console.error=oldError; DB.sdb.close(); }
}

test('喝水完成回覆前降為6讀3寫，保留總計、目標、差額與快捷；每次只查一次選單', () => fixture(async ({send,calls,timings,sql,DB}) => {
  await (await send('喝水20ml')).done;
  const metric=timings.at(-1), entries=Object.entries(metric.queries);
  const count=op=>entries.filter(([k])=>k.startsWith(`before_reply:${op}:`)).reduce((n,[,v])=>n+v.count,0);
  assert.equal(count('select'),6); assert.equal(count('insert'),3);
  assert.equal(sql.filter(s=>s.args[0]==='menu:single').length,1);
  assert.equal(sql.filter(s=>s.args[0]==='testsingle').length,1);
  assert.equal(sql.filter(s=>s.query.startsWith('INSERT INTO events')).length,1);
  assert.equal(metric.queries['after_reply:insert:text_inputs'].count,1);
  const card=calls.find(c=>c.path.endsWith('/message/reply')).body.messages[0];
  assert.match(JSON.stringify(card),/今日累積|今日目標/);
  assert.match(JSON.stringify(card),/還差/); assert.equal(card.quickReply.items.length,8);
  assert.equal((await getLogsForDay(DB,'s1',taipeiToday())).length,6);
  assert.equal(metric.records,1); assert.ok(metric.server_ms<=metric.line_accepted_ms);
  assert.doesNotMatch(JSON.stringify(metric),/fake-secret|fake-reply|testsingle|喝水20ml|小花/);
}));

test('共照者先收到確認卡；很慢的選單、analytics與通知都不能卡住回覆', async () => {
  const blocked=gate(), notification=gate(); let replied=false;
  await fixture(async ({send,calls,read})=>{
    const request=await send('蚵仔 水20',{actor:'helper'});
    try {
      await notification.promise;
      assert.equal(replied,true);
      assert.equal(calls.filter(c=>c.path.endsWith('/message/reply')).length,1);
      const logs=read("SELECT * FROM logs WHERE sourceMessageId='"+request.id+"'");
      assert.equal(logs.length,1); assert.equal(logs[0].lineUserId,'owner'); assert.equal(logs[0].recordedBy,'helper');
    } finally { blocked.release(); await request.done; }
  },{
    sql:async(q,args)=>{if(args[0]==='menu:helper'||q.startsWith('INSERT INTO events')){assert.equal(replied,true);await blocked.promise;}},
    line:async c=>{if(c.path.endsWith('/message/reply'))replied=true;if(c.path.endsWith('/message/push')){assert.equal(replied,true);notification.release();await blocked.promise;}}
  });
});

test('loading懸掛時取消請求，完成卡不等待；不會在回覆後再開始loading', () => {
  let aborted=false;
  return fixture(async ({send,calls})=>{
    await (await send('水5')).done;
    assert.equal(aborted,true);
    assert.equal(calls.filter(c=>c.path.endsWith('/message/reply')).length,1);
  },{line:async c=>{
    if(c.path.endsWith('/loading/start')) return new Promise((resolve,reject)=>c.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));},{once:true}));
    if(c.path.endsWith('/message/reply'))assert.equal(aborted,true);
  }});
});

test('token讀取慢時共用同一結果，已準備回覆就不再送出過期loading', () => fixture(async ({env,calls,sql,originalPrepare})=>{
  env.LINE_CHANNEL_ID='fake-channel';
  originalPrepare('INSERT INTO app_kv(k,v,updatedAt) VALUES(?,?,?)').bind('line_access_token',JSON.stringify({token:'fake-token',expiresAt:Date.now()+30*86400000}),new Date().toISOString()).run();
  await withLineEvent(env,{source:{userId:'single'}},async scoped=>{
    startRecordLoading(scoped,'single');
    await replyMessages(scoped,'fake-reply',[{type:'text',text:'確認'}]);
  });
  assert.equal(sql.filter(s=>s.args[0]==='line_access_token').length,1);
  assert.equal(calls.filter(c=>c.path.endsWith('/loading/start')).length,0);
  assert.equal(calls.filter(c=>c.path.endsWith('/message/reply')).length,1);
}));

test('選單更新失敗不把已儲存紀錄回報成失敗，也不重複回覆', () => fixture(async ({send,originalPrepare,calls,warnings})=>{
  originalPrepare("UPDATE app_kv SET v='{}' WHERE k='menu:single'").run();
  const request=await send('水5');await request.done;
  assert.equal(originalPrepare('SELECT COUNT(*) n FROM logs WHERE sourceMessageId=?').bind(request.id).first().n,1);
  assert.equal(calls.filter(c=>c.path.endsWith('/message/reply')).length,1);
  assert.ok(warnings.some(w=>w[0]==='line_background_failed'));
},{line:async c=>{if(c.path.endsWith('/richmenu'))throw Error('offline');}}));

test('共照推送失敗仍保留記錄者回覆，爸媽通知沿用文字備援', () => fixture(async ({send,calls})=>{
  await (await send('蚵仔 水5',{actor:'helper'})).done;
  const deliveries=calls.filter(c=>c.path.includes('/message/'));
  assert.deepEqual(deliveries.map(c=>c.path.split('/').at(-1)),['reply','push','push']);
  assert.equal(deliveries[2].body.messages[0].type,'text');
},{line:async c=>{if(c.path.endsWith('/push')&&c.body.messages[0].type==='flex')return new Response('{}',{status:400});}}));

test('多筆只回一張、事件重送只記一次；summary仍等於正式logs重算', () => fixture(async ({send,calls,DB,originalPrepare,timings})=>{
  const first=await send('主食31 水5');await first.done;
  await (await send('主食31 水5',{id:first.id})).done;
  assert.equal(calls.filter(c=>c.path.endsWith('/message/reply')).length,1);
  assert.equal(originalPrepare('SELECT COUNT(*) n FROM logs WHERE sourceMessageId=?').bind(first.id).first().n,2);
  assert.equal(originalPrepare("SELECT COUNT(*) n FROM events WHERE event='record'").first().n,2);
  const total=computeDailySummary(await getLogsForDay(DB,'s1',taipeiToday()));
  const row=originalPrepare('SELECT * FROM daily_summary WHERE petId=? AND date=?').bind('s1',taipeiToday()).first();
  assert.equal(row.totalWaterMl,total.totalWaterMl);assert.equal(row.kcal,total.kcal);
  assert.equal(timings.at(-1).records,2);
}));

test('無效webhook簽章不觸碰D1、不啟動loading', () => fixture(async ({send,calls,sql})=>{
  const req=await send('水5',{invalid:true});await req.done;
  assert.equal(req.response.status,401);assert.equal(sql.length,0);assert.equal(calls.length,0);
}));

test('145/200顯示73%及還差55ml；達標後不顯示負差額',()=>{
  const args={pet:{petName:'測試',goalWaterMl:200},categoryKey:'water',mainText:'水20',summary:{totalWaterMl:145},date:taipeiToday()};
  const card=JSON.stringify(recordFlex(args));assert.match(card,/73%/);assert.match(card,/還差 55 ml/);assert.match(card,/145 \/ 200 ml/);
  assert.match(JSON.stringify(recordFlex({...args,summary:{totalWaterMl:220}})),/已達目標/);
});
