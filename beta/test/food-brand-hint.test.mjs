// 「多品項但未設預設」時，品牌選擇卡的輕量引導（設預設免選＋系統粗估值＋照護站入口），
// 以及記錄完成卡的粗估／未設定說明。不改 parser、不改優先序；只在 bareType（只輸入類型/別名）時提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { handleRecord } from '../src/index.js';
import { recordTutorial } from '../src/replies.js';
import { createPet, createFoodItem, setDefaultFood, getFood } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8') + '\n' + readFileSync(join(ROOT, 'migrations', '0012_app_kv.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'X', text: '' } });
function capture() {
  const msgs = [];
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => msgs.push(m)); } catch {}
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { all: () => JSON.stringify(msgs) };
}
async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}
function foodCount(db) { return db.prepare("SELECT COUNT(*) AS n FROM logs WHERE category='food' AND isDeleted=0").bind().first().n; }
async function rec(db, pet, text) {
  const intent = parseMessage(text);
  assert.equal(intent.type, 'record', `「${text}」應為 record`);
  return handleRecord({ DB: db }, mkEvent(), pet, intent.record, 'u1', { actorId: 'u1' });
}

test('1) 兩個乾糧、無預設：乾乾5 → 品牌選擇卡含「設成預設／乾乾5／系統粗估值／照護站」，且不寫入', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  const j = cap.all();
  assert.ok(res && res.disambiguated, '應出品牌選擇卡');
  assert.equal(foodCount(db), 0, '選之前不寫入');
  assert.ok(j.includes('預設食物'), '含「設成預設」引導');
  assert.ok(j.includes('乾乾5'), '含乾糧例句「乾乾5」');
  assert.ok(j.includes('系統粗估值'), '含系統粗估值說明');
  assert.ok(j.includes('到照護站設定品牌／熱量'), '含照護站入口');
});

test('2) 兩個主食罐、無預設：主食3 → 卡片例句用「主食3」', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '主食罐', kcalPerGram: 1.2 });
  await createFoodItem(db, 'u1', { displayName: '喜倍', foodType: '主食罐', kcalPerGram: 1.0 });
  const cap = capture();
  await rec(db, pet, '主食3');
  assert.ok(cap.all().includes('主食3'), '主食罐例句應為「主食3」');
});

test('3) 已設有效預設（含品牌 kcal）：乾乾5 → 不出品牌卡、不出粗估提示，直接記預設 foodId', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  assert.ok(!(res && res.disambiguated), '有預設 → 不出品牌卡');
  assert.equal(res.savedLog.foodId, hill.foodId);
  assert.equal(res.savedLog.kcal, 19, '5×3.8=19（品牌精準）');
  const j = cap.all();
  assert.ok(!j.includes('系統粗估值') && !j.includes('預設食物'), '不顯示粗估／設預設提示');
});

test('4) 明確品牌：皇家乾糧5（預設是希爾斯）→ 用皇家、不受提示影響', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  const res = await rec(db, pet, '皇家乾糧5');
  assert.equal(res.savedLog.foodId, royal.foodId);
  assert.equal(res.savedLog.kcal, 18, '5×3.6=18');
});

test('5) 單一品項：乾乾5 → 自動套那個品項，不出品牌卡', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const res = await rec(db, pet, '乾乾5');
  assert.ok(!(res && res.disambiguated));
  assert.equal(res.savedLog.foodId, hill.foodId);
});

test('6) 沒有任何乾糧品項：乾乾5 → 系統粗估 3.7、完成卡顯示粗估＋照護站', async () => {
  const { db, pet } = await seed();
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  assert.equal(res.savedLog.foodId, '', '無品項 → 不綁 foodId');
  assert.equal(res.savedLog.kcal, 18.5, '5×3.7=18.5 粗估');
  const j = cap.all();
  assert.ok(j.includes('系統粗估值'), '完成卡標示系統粗估值');
  assert.ok(j.includes('照護站'), '完成卡引導照護站');
});

test('7) 零食無品牌熱量：零食1 → 完成卡「熱量未設定」＋照護站，不顯示 0 kcal 為精準', async () => {
  const { db, pet } = await seed();
  const cap = capture();
  const res = await rec(db, pet, '零食1');
  assert.equal(res.savedLog.kcal, 0);
  const j = cap.all();
  assert.ok(j.includes('熱量未設定'), '零食顯示熱量未設定');
  assert.ok(j.includes('照護站'), '引導照護站補熱量');
});

test('8) 第二層教學：有「沒設定也可以先記」語意，且不暗示必須先設預設', () => {
  const t = recordTutorial();
  assert.ok(/沒設定也可以先記|沒設定也能/.test(t), '應說沒設定也能先記');
  assert.ok(!t.includes('必須先設'), '不得暗示必須先設定');
});
