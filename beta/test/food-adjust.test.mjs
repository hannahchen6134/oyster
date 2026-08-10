// P0-2 護欄：食物調整要對到「正確的那一餐」，並保留原餵量。
//  - 剩 N：實吃＝原餵量−N，保留 servedAmount／leftoverAmount；amount＝實吃（統計語意不變）。
//  - 扣 N：實吃＝目前−N（相對）。改成 N：實吃＝N。
//  - 以「貓」為範圍找最近一餐食物（不用 getLastLogByUser）；找不到 → 「找不到可以調整的食物紀錄」。
//  - 實量算成負的 → 不寫、請使用者確認。多筆同品名 → 出確認卡、不亂猜。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createPet, insertLog, getLog, ensureTaskSchema } from '../src/db.js';
import { computeAdjust, handleFixLast, handleFixMatch } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const sent = [];
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });

async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' }); // p 由 createPet 給
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-can','u1','皇家罐頭','罐頭',1.0,0.8,'t','t')").bind().run();
  return { db, pet };
}
async function addFood(db, pet, { itemName = '罐頭', foodType = '罐頭', foodId = '', amount = 40, when = '2026-08-10 09:00' } = {}) {
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName, foodId, amount, unit: 'g', kcal: Math.round(amount * 0.9), recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
const env = { DB: null };

test('computeAdjust：剩 N＝原餵量−剩，保留 served/leftover；扣 N＝相對；改成 N＝設定', () => {
  const target = { amount: 40, servedAmount: null };
  const lo = computeAdjust(target, { mode: 'leftover', amount: 10 });
  assert.equal(lo.consumed, 30); assert.equal(lo.served, 40); assert.equal(lo.leftover, 10);
  const sub = computeAdjust(target, { mode: 'subtract', amount: 15 });
  assert.equal(sub.consumed, 25); assert.equal(sub.served, null);
  const set = computeAdjust(target, { mode: 'set', amount: 22 });
  assert.equal(set.consumed, 22);
  // 已調整過（有 servedAmount）再剩一次：以「原餵量 40」為基準重算，不是用目前 amount
  const again = computeAdjust({ amount: 30, servedAmount: 40 }, { mode: 'leftover', amount: 5 });
  assert.equal(again.consumed, 35); assert.equal(again.served, 40); assert.equal(again.alreadyAdjusted, true);
});

test('剩 10：對到最近一餐、實吃＝原餵−剩，保留 servedAmount/leftoverAmount、amount＝實吃', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { foodId: 'f-can', itemName: '皇家罐頭', amount: 40 });
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'leftover', amount: 10, target: 'food' }, 'u1');
  const got = await getLog(db, log.logId);
  assert.equal(got.amount, 30, 'amount＝實吃 30（統計語意不變）');
  assert.equal(got.servedAmount, 40, '保留原餵量 40');
  assert.equal(got.leftoverAmount, 10, '保留剩餘 10');
  assert.equal(got.kcal, 30, '30×1.0 重算熱量');
});

test('扣 5：從實吃量再扣（40→35），不寫 servedAmount', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { amount: 40 });
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'subtract', amount: 5 }, 'u1');
  const got = await getLog(db, log.logId);
  assert.equal(got.amount, 35);
  assert.ok(got.servedAmount === null || got.servedAmount === undefined, '扣不記原餵量');
});

test('改成 22：把最近一餐設為實吃 22', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { amount: 40 });
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'set', amount: 22 }, 'u1');
  assert.equal((await getLog(db, log.logId)).amount, 22);
});

test('對到最近「食物」那餐、而非最後動作（中間插入喝水不受影響）', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const food = await addFood(db, pet, { amount: 40, when: '2026-08-10 09:00' });
  // 之後又記了一筆喝水（時間較晚）
  await insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: '2026-08-10 10:00', category: 'water', itemName: '', amount: 60, waterMl: 60, unit: 'ml', recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'leftover', amount: 10, target: 'food' }, 'u1');
  const got = await getLog(db, food.logId);
  assert.equal(got.amount, 30, '調整的是食物那餐，不是後來的喝水');
});

test('負的不寫：原餵 40、剩 50 → 不更新、保留原值', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { amount: 40 });
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'leftover', amount: 50, target: 'food' }, 'u1');
  const got = await getLog(db, log.logId);
  assert.equal(got.amount, 40, '算出負值 → 不寫、保留原量');
  assert.ok(got.servedAmount === null || got.servedAmount === undefined);
});

test('沒有任何食物紀錄 → 回「找不到可以調整的食物紀錄」（不亂改別的）', async () => {
  const { db, pet } = await seed(); env.DB = db;
  let msg = '';
  const badFetch = globalThis.fetch;
  // 攔 reply 內容
  globalThis.fetch = async (url, opts) => { try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => { if (m.text) msg += m.text; }); } catch {} return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
  await handleFixLast(env, mkEvent(), pet, { type: 'fixLast', mode: 'set', amount: 10 }, 'u1');
  globalThis.fetch = badFetch;
  assert.ok(msg.includes('找不到可以調整的食物紀錄'), `應提示找不到，實得：${msg}`);
});

test('handleFixMatch 多餐同品名 → 出確認卡（不亂猜），單筆才直接改', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const a = await addFood(db, pet, { itemName: '皇家罐頭', foodId: 'f-can', amount: 40, when: '2026-08-10 08:00' });
  const b = await addFood(db, pet, { itemName: '皇家罐頭', foodId: 'f-can', amount: 35, when: '2026-08-10 18:00' });
  let payloads = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { try { payloads.push(JSON.parse(opts?.body || '{}')); } catch {} return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
  await handleFixMatch(env, mkEvent(), pet, { type: 'fixMatch', query: '皇家罐頭', amount: 24 }, 'u1');
  globalThis.fetch = orig;
  // 兩餐都沒被直接改（still 40 / 35）
  assert.equal((await getLog(db, a.logId)).amount, 40);
  assert.equal((await getLog(db, b.logId)).amount, 35);
  const text = JSON.stringify(payloads);
  assert.ok(/都對得上|要改哪一餐|哪一餐/.test(text), '應出「選哪一餐」確認卡');
});
