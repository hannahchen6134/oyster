// 食物「時間軸／足跡」（何時吃哪一款，逐筆）——與 aggregate「吃過什麼」分流。
//  - 一律查 logs（實際吃過），food_items 只補顯示名；設定過但沒吃過的不得出現。
//  - foodType／口語 alias／品牌品項名皆可；多貓只查該貓；soft-deleted 排除；顯示實吃 amount。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { buildFoodTimelineResult, foodNameHit } from '../src/index.js';
import { createPet, createFoodItem, insertLog, softDeleteLog, getFoodTimeline } from '../src/db.js';
import { taipeiToday, addDays } from '../src/util.js';

// ───────────────────────── 分流（parser）─────────────────────────

test('分流：「何時吃什麼」→ foodTimeline；「吃過什麼」→ 維持 foodHistory aggregate（不回歸）', () => {
  const tl = (x) => { const r = parseMessage(x); assert.equal(r.query, 'foodTimeline', `「${x}」應為時間軸`); return r; };
  assert.equal(tl('最近罐頭吃什麼').foodType, '罐頭');
  assert.equal(tl('這陣子主食吃什麼').foodType, '主食罐');
  assert.equal(tl('之前罐頭都吃哪款').scope, 'all');
  assert.equal(tl('希爾斯什麼時候吃').nameQuery, '希爾斯');
  assert.equal(tl('皇家乾糧最近哪天吃').nameQuery, '皇家乾糧');
  // B 乾糧＝乾乾 一致
  assert.deepEqual(
    ['foodType', 'scope', 'sinceDays'].map((k) => parseMessage('最近乾糧吃什麼')[k]),
    ['foodType', 'scope', 'sinceDays'].map((k) => parseMessage('最近乾乾吃什麼')[k])
  );
  // I 舊查詢不回歸
  assert.equal(parseMessage('最近吃什麼').query, 'foodHistory');
  assert.equal(parseMessage('最近吃哪些罐頭').query, 'foodHistory');
});

// ───────────────────────── getFoodTimeline（DB）─────────────────────────

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

async function mkPet(db, name) { await createPet(db, 'u1', { petName: name }); return db.prepare('SELECT * FROM pets WHERE petName=?').bind(name).first(); }
async function addFood(db, pet, { itemName = '', foodType, foodId = '', amount, daysAgo = 0, hm = '18:00', served = null, leftover = null }) {
  const log = await insertLog(db, {
    lineUserId: 'u1', petId: pet.petId, eventDateTime: `${addDays(taipeiToday(), -daysAgo)} ${hm}`, category: 'food',
    foodType, itemName, foodId, amount, unit: 'g', kcal: 0,
    recordedBy: 'u1', source: 'line', updatedBy: 'u1'
  });
  // served/leftover 只有 leftover 調整才會寫（updateLog）；測試需要時直接補上，模擬那個流程
  if (served != null || leftover != null) {
    db.prepare('UPDATE logs SET servedAmount = ?, leftoverAmount = ? WHERE logId = ?').bind(served, leftover, log.logId).run();
  }
  return log;
}

test('A foodType 時間軸：最近罐頭吃什麼 → 只回罐頭逐筆、最近在前、不含乾糧', async () => {
  const db = new D1(); const pet = await mkPet(db, '蚵仔');
  await addFood(db, pet, { itemName: '巔峰羊肉', foodType: '罐頭', amount: 35, daysAgo: 0, hm: '18:30' });
  await addFood(db, pet, { itemName: '巔峰羊肉', foodType: '罐頭', amount: 30, daysAgo: 1, hm: '19:10' });
  await addFood(db, pet, { itemName: '惜時雞肉', foodType: '罐頭', amount: 40, daysAgo: 3, hm: '18:45' });
  await addFood(db, pet, { itemName: '希爾斯乾糧', foodType: '乾糧', amount: 10, daysAgo: 4 });
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30, foodType: '罐頭' });
  assert.equal(rows.length, 3, '只回 3 筆罐頭');
  assert.ok(rows.every((r) => r.foodType === '罐頭'), '不含乾糧');
  assert.equal(rows[0].name, '巔峰羊肉'); assert.equal(rows[0].amount, 35); // 最近在前
});

test('C/§7 品牌 foodId 時間軸＋顯示名優先 displayName；G 沒吃過的品項不出現', async () => {
  const db = new D1(); const pet = await mkPet(db, '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯 GI Biome', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 }); // 從沒吃過
  await addFood(db, pet, { itemName: '', foodType: '乾糧', foodId: hill.foodId, amount: 10, daysAgo: 0, hm: '09:20' });
  await addFood(db, pet, { itemName: '', foodType: '乾糧', foodId: hill.foodId, amount: 8, daysAgo: 1, hm: '20:10' });
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30, foodId: hill.foodId });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.name === '希爾斯 GI Biome'), '顯示名取 food_items.displayName，非 foodId');
  // 皇家從沒吃過 → 依 foodId 查不到任何列
  const royalRows = await getFoodTimeline(db, pet.petId, { sinceDays: 30, nameQuery: '皇家' });
  assert.equal(royalRows.length, 0, 'food_items 有皇家但沒 log → 時間軸不得出現');
});

test('D 多品牌候選：兩個「希爾斯」品項 → foodNameHit 皆命中（handler 會問是哪一款）', async () => {
  const foods = [
    { displayName: '希爾斯 GI Biome', brand: '', productName: '', isDeleted: 0 },
    { displayName: '希爾斯 k/d', brand: '', productName: '', isDeleted: 0 },
    { displayName: '皇家乾糧', brand: '', productName: '', isDeleted: 0 }
  ];
  const hits = foods.filter((f) => foodNameHit(f, '希爾斯'));
  assert.equal(hits.length, 2, '兩款希爾斯都算候選 → 多候選要問，不直接猜');
});

test('E 多貓：只回被查的那隻貓的紀錄', async () => {
  const db = new D1(); const a = await mkPet(db, '蚵仔'); const b = await mkPet(db, '珍珠');
  await addFood(db, a, { foodType: '乾糧', amount: 10, daysAgo: 0 });
  await addFood(db, b, { foodType: '乾糧', amount: 99, daysAgo: 0 });
  const rows = await getFoodTimeline(db, a.petId, { sinceDays: 30, foodType: '乾糧' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 10, '不得混入珍珠的 99g');
});

test('F soft-deleted：isDeleted=1 的 food log 不得出現', async () => {
  const db = new D1(); const pet = await mkPet(db, '蚵仔');
  const del = await addFood(db, pet, { foodType: '罐頭', amount: 40, daysAgo: 0 });
  await addFood(db, pet, { foodType: '罐頭', amount: 35, daysAgo: 1 });
  await softDeleteLog(db, del.logId, 'u1');
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30, foodType: '罐頭' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 35);
});

test('H 顯示實吃 amount，並可附「原 X、剩 Y」；不得把 leftover 當實吃', async () => {
  const db = new D1(); const pet = await mkPet(db, '蚵仔');
  await addFood(db, pet, { itemName: '巔峰羊肉', foodType: '罐頭', amount: 30, served: 40, leftover: 10, daysAgo: 0, hm: '18:30' });
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30, foodType: '罐頭' });
  assert.equal(rows[0].amount, 30, '實吃＝amount 30，非 leftover 10');
  const out = buildFoodTimelineResult(rows, { scope: 'recent', sinceDays: 30, label: '罐頭', petName: '蚵仔' });
  assert.ok(out.includes('巔峰羊肉') && out.includes('30g'));
  assert.ok(out.includes('（原 40g，剩 10g）'), `應附原餵/剩，實得：${out}`);
});

test('回覆：空狀態不顯示空表格', () => {
  const out = buildFoodTimelineResult([], { scope: 'recent', sinceDays: 30, label: '罐頭', petName: '蚵仔' });
  assert.equal(out, '蚵仔 最近 30 天沒有找到罐頭紀錄。');
});
