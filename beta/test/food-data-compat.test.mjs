// 護欄回歸測試：既有罐頭／乾糧品牌資料（food_items）與 logs.foodId 關聯，在 P0 各項修改後
// 必須完整保留、可查詢、可沿用自訂熱量、可被「最近吃過」讀到；且程式碼不得對 food_items 做
// DELETE／DROP／TRUNCATE／批次轉類型。此檔在所有 P0 commit 前先加入，之後每次都要綠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listFoods, getFood, insertLog, getLog } from '../src/db.js';
import { matchFood } from '../src/parser.js';
import { deriveFoodFields } from '../src/summary.js';

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

// 模擬「使用者早已建立」的品牌資料：一筆罐頭（自訂 kcal）＋一筆乾糧（自訂 kcal），以及舊 logs 用 foodId 連過去
function seedExistingFoods() {
  const db = new D1();
  const t = '2026-01-01T00:00:00.000Z';
  // 罐頭品牌（有 brand/productName/displayName、自訂 kcalPerGram=1.05、waterRatio=0.78）
  db.prepare(`INSERT INTO food_items (foodId, ownerLineUserId, brand, productName, displayName, foodType, kcalPerGram, waterRatio, isPrescription, note, isDeleted, createdAt, updatedAt)
    VALUES ('f-can','u1','巔峰','羊肉主食罐','巔峰羊肉','罐頭',1.05,0.78,0,'',0,?,?)`).bind(t, t).run();
  // 乾糧品牌（自訂 kcalPerGram=3.9）
  db.prepare(`INSERT INTO food_items (foodId, ownerLineUserId, brand, productName, displayName, foodType, kcalPerGram, waterRatio, isPrescription, note, isDeleted, createdAt, updatedAt)
    VALUES ('f-dry','u1','皇家','腎臟處方','皇家腎臟乾糧','乾糧',3.9,0,0,'',0,?,?)`).bind(t, t).run();
  return db;
}
async function oldFoodLog(db, foodId, foodType, itemName, grams, kcal) {
  return insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-01-02 09:00', category: 'food', foodType, itemName, foodId, amount: grams, unit: 'g', kcal, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}

test('既有罐頭／乾糧品牌可查詢：listFoods 兩筆都在、欄位完整保留', async () => {
  const db = seedExistingFoods();
  const foods = await listFoods(db, 'u1');
  assert.equal(foods.length, 2);
  const can = foods.find((f) => f.foodId === 'f-can');
  const dry = foods.find((f) => f.foodId === 'f-dry');
  assert.equal(can.brand, '巔峰'); assert.equal(can.productName, '羊肉主食罐'); assert.equal(can.displayName, '巔峰羊肉');
  assert.equal(can.foodType, '罐頭'); assert.equal(can.kcalPerGram, 1.05); assert.equal(can.waterRatio, 0.78);
  assert.equal(dry.foodType, '乾糧'); assert.equal(dry.kcalPerGram, 3.9);
});

test('matchFood 依 displayName/brand/productName 找回既有品牌（沿用 foodId，不重複建立）', async () => {
  const db = seedExistingFoods();
  const foods = await listFoods(db, 'u1');
  assert.equal(matchFood(foods, '巔峰羊肉', '罐頭')?.foodId, 'f-can', 'displayName 命中');
  assert.equal(matchFood(foods, '巔峰', '罐頭')?.foodId, 'f-can', 'brand 命中');
  assert.equal(matchFood(foods, '皇家腎臟乾糧', '乾糧')?.foodId, 'f-dry', '乾糧 命中');
});

test('舊 logs 透過 foodId 連到品牌：getFood(foodId) 正常、log 顯示所需欄位在', async () => {
  const db = seedExistingFoods();
  const log = await oldFoodLog(db, 'f-can', '罐頭', '巔峰羊肉', 40, 42);
  const got = await getLog(db, log.logId);
  assert.equal(got.foodId, 'f-can'); assert.equal(got.foodType, '罐頭'); assert.equal(got.amount, 40);
  const food = await getFood(db, got.foodId);
  assert.equal(food.displayName, '巔峰羊肉'); assert.equal(food.kcalPerGram, 1.05);
});

test('自訂 kcalPerGram 永遠優先於類型預設，且不標粗估；無自訂才用預設並標估算', async () => {
  const db = seedExistingFoods();
  const can = await getFood(db, 'f-can');
  const custom = deriveFoodFields(40, '罐頭', can);
  assert.equal(custom.kcal, 42, '40×1.05＝42（用品牌自訂，非預設 0.9）');
  assert.equal(custom.estimated, false, '自訂熱量不標估算');
  const def = deriveFoodFields(40, '罐頭', null); // 沒有品牌 → 類型預設
  assert.ok(def.estimated === true, '類型預設要標估算');
  assert.notEqual(def.kcal, 42, '預設值不等於品牌值');
});

test('「最近吃過」歷史查詢（quickShortcuts 用的 GROUP BY）仍讀得到既有品牌品項', async () => {
  const db = seedExistingFoods();
  await oldFoodLog(db, 'f-can', '罐頭', '巔峰羊肉', 40, 42);
  await oldFoodLog(db, 'f-can', '罐頭', '巔峰羊肉', 40, 42);
  const { results } = db.prepare(
    `SELECT category, foodType, itemName, CAST(ROUND(amount) AS INTEGER) amt, COUNT(*) c, MAX(eventDateTime) t
     FROM logs WHERE petId='p1' AND isDeleted=0 AND category IN ('water','food','med')
     GROUP BY category, foodType, itemName, amt ORDER BY c DESC, t DESC LIMIT 10`
  ).bind().all();
  const row = results.find((r) => r.itemName === '巔峰羊肉');
  assert.ok(row, '歷史品牌品項可被最近吃過讀到'); assert.equal(row.c, 2);
});

test('原始碼護欄：任何檔案都不得對 food_items 做 DELETE／DROP／TRUNCATE／批次改類型', () => {
  const files = ['src/db.js', 'src/index.js', 'src/api.js', 'src/parser.js', 'src/summary.js'];
  const bad = /(DELETE\s+FROM\s+food_items|DROP\s+TABLE\s+.*food_items|TRUNCATE\s+.*food_items|UPDATE\s+food_items\s+SET\s+foodType)/i;
  for (const f of files) {
    const src = readFileSync(join(__dirname, '..', f), 'utf8');
    assert.ok(!bad.test(src), `${f} 不得對 food_items 做破壞性操作`);
  }
});
