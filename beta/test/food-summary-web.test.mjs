// 「吃過的食物」兩層 API：第一層 /api/food-history（品項摘要，聚合、lastAt DESC）＋
// 第二層 /api/food-timeline（某 foodId 或 generic=1 類型的逐餐）。純讀取、owner scope、誠實不回推品牌。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleApi } from '../src/api.js';
import { createFoodItem, setDefaultFood, insertLog, createSession, getFoodTimeline } from '../src/db.js';
import { taipeiToday, addDays } from '../src/util.js';

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

async function setup() {
  const db = new D1();
  db.prepare("INSERT INTO users (lineUserId, createdAt, updatedAt) VALUES ('u1','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  return { db, token: await createSession(db, 'u1') };
}
const addFood = (db, { itemName = '', foodType, foodId = '', amount, daysAgo = 0, hm = '18:00', served = null, leftover = null }) =>
  insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: `${addDays(taipeiToday(), -daysAgo)} ${hm}`, category: 'food', foodType, itemName, foodId, amount, unit: 'g', kcal: 0, recordedBy: 'u1', source: 'line', updatedBy: 'u1' })
    .then((l) => { if (served != null || leftover != null) db.prepare('UPDATE logs SET servedAmount=?, leftoverAmount=? WHERE logId=?').bind(served, leftover, l.logId).run(); return l; });
async function apiCall(db, token, path) {
  const url = `https://x/api/${path}`;
  const res = await handleApi(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), { DB: db }, new URL(url));
  return { status: res.status, json: await res.json() };
}

test('1 同一 foodId 多筆 → 第一層聚合成一項，times/lastAt 正確', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0, hm: '09:20' });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 8, daysAgo: 1 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 10, daysAgo: 3 });
  const r = await apiCall(db, token, 'food-history?petId=p1&days=30');
  assert.equal(r.json.rows.length, 1, '聚合成一項');
  assert.equal(r.json.rows[0].name, '希爾斯乾糧');
  assert.equal(Number(r.json.rows[0].times), 3, '3 次');
  assert.equal(r.json.rows[0].lastAt.slice(0, 10), addDays(taipeiToday(), 0), 'lastAt＝最近一次');
});

test('2 兩個不同 foodId → 兩個品項', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  await addFood(db, { foodId: royal.foodId, foodType: '乾糧', amount: 8, daysAgo: 1 });
  const r = await apiCall(db, token, 'food-history?petId=p1&days=30');
  assert.equal(r.json.rows.length, 2);
  assert.deepEqual(r.json.rows.map((x) => x.name).sort(), ['希爾斯乾糧', '皇家乾糧']);
});

test('3 generic 乾糧多筆 → 聚合為「乾糧」，即使有 defaultFood 也不顯示品牌', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);   // 現在的預設
  await addFood(db, { foodId: '', itemName: '', foodType: '乾糧', amount: 5, daysAgo: 0 });
  await addFood(db, { foodId: '', itemName: '', foodType: '乾糧', amount: 6, daysAgo: 2 });
  const r = await apiCall(db, token, 'food-history?petId=p1&days=30');
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].name, '乾糧', 'generic 聚合為乾糧，不回推希爾斯');
  assert.equal(r.json.rows[0].foodId, '', 'generic 無 foodId');
  assert.equal(Number(r.json.rows[0].times), 2);
});

test('9 排序：依 lastAt DESC（最近吃的在前）', async () => {
  const { db, token } = await setup();
  const a = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '罐頭', kcalPerGram: 1.5 });
  const b = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await addFood(db, { foodId: b.foodId, foodType: '乾糧', amount: 8, daysAgo: 5 });   // 較舊
  await addFood(db, { foodId: a.foodId, foodType: '罐頭', amount: 35, daysAgo: 1 });  // 較近
  const r = await apiCall(db, token, 'food-history?petId=p1&days=30');
  assert.deepEqual(r.json.rows.map((x) => x.name), ['巔峰羊', '皇家乾糧'], '最近吃的在前');
});

test('6/7 第二層 foodId → 該品項逐餐（含 served/leftover）；generic=1 只回 generic', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 30, served: 40, leftover: 10, daysAgo: 0, hm: '10:39' });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 8, daysAgo: 1 });
  await addFood(db, { foodId: '', itemName: '', foodType: '乾糧', amount: 11, daysAgo: 0 }); // generic 乾糧
  // 品牌逐餐
  const branded = await apiCall(db, token, `food-timeline?petId=p1&days=30&foodId=${hill.foodId}`);
  assert.equal(branded.json.rows.length, 2, '只回希爾斯的兩餐');
  assert.equal(branded.json.rows[0].servedAmount, 40); assert.equal(branded.json.rows[0].leftoverAmount, 10);
  // generic 逐餐（只回 foodId 空的）
  const gen = await apiCall(db, token, 'food-timeline?petId=p1&days=30&generic=1&foodType=' + encodeURIComponent('乾糧'));
  assert.equal(gen.json.rows.length, 1, 'generic=1 只回未綁品牌那筆');
  assert.equal(gen.json.rows[0].amount, 11);
});

test('13 getFoodTimeline genericOnly 只回 foodId 空；不加時等同原行為（含品牌）', async () => {
  const { db } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  await addFood(db, { foodId: '', foodType: '乾糧', amount: 11, daysAgo: 0 });
  const all = await getFoodTimeline(db, 'p1', { sinceDays: 30, foodType: '乾糧' });
  assert.equal(all.length, 2, '預設（無 genericOnly）＝含品牌，行為不變');
  const gen = await getFoodTimeline(db, 'p1', { sinceDays: 30, foodType: '乾糧', genericOnly: true });
  assert.equal(gen.length, 1, 'genericOnly 只回 generic');
  assert.equal(gen[0].amount, 11);
});

test('11 跨家庭：食物摘要 API 對別家 petId → 403', async () => {
  const { db, token } = await setup();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p2','u2','別家貓','t','t')").bind().run();
  assert.equal((await apiCall(db, token, 'food-history?petId=p2&days=30')).status, 403);
});
