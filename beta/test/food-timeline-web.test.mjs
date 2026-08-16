// 「吃過的食物」網站時間軸 API（GET /api/food-timeline，純讀取）：
//  - 資料來自實際 logs（category=food、未刪、pet scoped、依時間倒序、limit）；food_items 只補顯示名。
//  - generic 紀錄（foodId=''）誠實顯示類型，不猜品牌；即使家庭有 defaultFood 也不回推舊紀錄。
//  - 有 foodId → 顯示品項 displayName；served/leftover 完整回傳（實吃＝amount，不把剩餘量當實吃）。
//  - 30 天邊界、類型過濾、家庭權限（跨家庭 petId 拒絕）。owner 由 server resolve，不接受前端自報。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleApi } from '../src/api.js';
import { insertLog, createFoodItem, setDefaultFood, createSession } from '../src/db.js';
import { taipeiToday, addDays } from '../src/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// app_kv 由 0012 migration 建立（setDefaultFood 需要）；schema.sql 沒有它。
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
  const token = await createSession(db, 'u1');
  return { db, token };
}
const addFood = (db, { petId = 'p1', itemName = '', foodType, foodId = '', amount, daysAgo = 0, hm = '18:00', served = null, leftover = null }) => {
  const log = insertLog(db, {
    lineUserId: 'u1', petId, eventDateTime: `${addDays(taipeiToday(), -daysAgo)} ${hm}`, category: 'food',
    foodType, itemName, foodId, amount, unit: 'g', kcal: 0, recordedBy: 'u1', source: 'line', updatedBy: 'u1'
  });
  return log.then((l) => {
    if (served != null || leftover != null) db.prepare('UPDATE logs SET servedAmount=?, leftoverAmount=? WHERE logId=?').bind(served, leftover, l.logId).run();
    return l;
  });
};
async function timeline(db, token, qs) {
  const url = `https://x/api/food-timeline?${qs}`;
  const res = await handleApi(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), { DB: db }, new URL(url));
  return { status: res.status, json: await res.json() };
}

test('A 基本時間軸：多品項近 30 天依實際時間倒序，名稱正確', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0, hm: '09:20' });
  await addFood(db, { foodId: royal.foodId, foodType: '乾糧', amount: 8, daysAgo: 1, hm: '19:10' });
  await addFood(db, { itemName: '巔峰羊', foodType: '罐頭', amount: 35, daysAgo: 2, hm: '18:30' });
  const r = await timeline(db, token, 'petId=p1&days=30');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rows.map((x) => x.name), ['希爾斯乾糧', '皇家乾糧', '巔峰羊'], '倒序、名稱正確');
  assert.equal(r.json.rows[0].amount, 5);
});

test('B generic log（foodId=空）→ 顯示「乾糧」，不顯示希爾斯／皇家', async () => {
  const { db, token } = await setup();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await addFood(db, { foodType: '乾糧', foodId: '', itemName: '', amount: 5, daysAgo: 0 });
  const r = await timeline(db, token, 'petId=p1&days=30');
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].name, '乾糧', 'generic 只顯示類型');
  assert.equal(r.json.rows[0].foodType, '乾糧');
  const j = JSON.stringify(r.json.rows);
  assert.ok(!j.includes('希爾斯') && !j.includes('皇家'), '不得猜品牌');
});

test('C defaultFood 不回推歷史：家庭設 default=希爾斯，舊 generic 乾糧 log 仍顯示「乾糧」', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);       // 現在的家庭預設
  await addFood(db, { foodType: '乾糧', foodId: '', itemName: '', amount: 5, daysAgo: 3 }); // 當時記的是 generic
  const r = await timeline(db, token, 'petId=p1&days=30');
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].name, '乾糧', 'defaultFood 不得回推舊 generic → 仍是乾糧，不是希爾斯');
});

test('D 有 foodId → 顯示品項 displayName（H served/leftover 完整回傳、實吃＝amount）', async () => {
  const { db, token } = await setup();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯 GI', foodType: '乾糧', kcalPerGram: 3.8 });
  await addFood(db, { foodId: hill.foodId, foodType: '乾糧', amount: 30, served: 40, leftover: 10, daysAgo: 0 });
  const r = await timeline(db, token, 'petId=p1&days=30');
  assert.equal(r.json.rows[0].name, '希爾斯 GI');
  assert.equal(r.json.rows[0].amount, 30, '實吃＝30');
  assert.equal(r.json.rows[0].servedAmount, 40);
  assert.equal(r.json.rows[0].leftoverAmount, 10);
});

test('G 類型過濾（API）：foodType=乾糧 → 不含罐頭／主食罐', async () => {
  const { db, token } = await setup();
  await addFood(db, { foodType: '乾糧', amount: 5, daysAgo: 0 });
  await addFood(db, { foodType: '罐頭', amount: 35, daysAgo: 0 });
  await addFood(db, { foodType: '主食罐', amount: 30, daysAgo: 0 });
  const r = await timeline(db, token, 'petId=p1&days=30&foodType=' + encodeURIComponent('乾糧'));
  assert.equal(r.json.rows.length, 1);
  assert.ok(r.json.rows.every((x) => x.foodType === '乾糧'));
});

test('J 30 天邊界：40 天前的紀錄不進 days=30；days=all 才出現', async () => {
  const { db, token } = await setup();
  await addFood(db, { foodType: '乾糧', amount: 5, daysAgo: 5 });
  await addFood(db, { foodType: '乾糧', amount: 9, daysAgo: 40 });
  const recent = await timeline(db, token, 'petId=p1&days=30');
  assert.equal(recent.json.rows.length, 1, '只含近 30 天那筆');
  assert.equal(recent.json.rows[0].amount, 5);
  const all = await timeline(db, token, 'petId=p1&days=all');
  assert.equal(all.json.rows.length, 2, 'days=all 含 40 天前那筆');
});

test('K 家庭權限：另一家庭的 petId → 403，不回資料（owner 由 server resolve）', async () => {
  const { db, token } = await setup();
  // 另一個家庭 u2/p2，各記一筆
  db.prepare("INSERT INTO users (lineUserId, createdAt, updatedAt) VALUES ('u2','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p2','u2','別家貓','t','t')").bind().run();
  await addFood(db, { petId: 'p2', foodType: '乾糧', amount: 99, daysAgo: 0 });
  const r = await timeline(db, token, 'petId=p2&days=30');   // u1 的 token 查 p2
  assert.equal(r.status, 403, '跨家庭必須拒絕');
  assert.notEqual(r.json.ok, true);
});
