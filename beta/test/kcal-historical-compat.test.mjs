// 部署前既有 daily_summary 的 kcalEstimated 相容性：
// 欄位剛加時歷史列為 NULL＝「未知」，讀取（getSummaries）必須由當天底層 logs 安全推導，
// 絕不可把用「類型預設」算的歷史日誤標成精準熱量。LINE 週摘要、A4、網站共用同一份結果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createPet, insertLog, getSummaries, getRecentSummaries, recomputeDay } from '../src/db.js';
import { deriveFoodFields } from '../src/summary.js';
import { weekFlex } from '../src/flex.js';

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

async function seed() {
  const db = new D1();
  const pet = await createPet(db, 'u1', { petName: '蚵仔' });
  db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-brand','u1','巔峰罐頭','罐頭',1.05,0.8,'t','t')").bind().run();
  return { db, pet };
}
async function food(db, pet, { foodId = '', foodType = '罐頭', amount = 40, when }) {
  const derived = deriveFoodFields(amount, foodType, foodId === 'f-brand' ? { kcalPerGram: 1.05 } : null);
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName: foodType, foodId, amount, unit: 'g', kcal: derived.kcal, waterMl: derived.waterMl, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
// 模擬「部署前既有」的歷史 daily_summary：kcal 已有值、但 kcalEstimated 留 NULL（不帶該欄）
function seedHistoricalSummary(db, petId, date, kcal) {
  db.prepare(`INSERT INTO daily_summary (petId, date, waterMl, foodWaterMl, totalWaterMl, dryFoodG, wetFoodG, otherFoodG, kcal, medJson, medTakenCount, medIssueCount, vomitCount, stoolCount, abnormalFlags, entryCount, updatedAt)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, '[]', 0, 0, 0, 0, '[]', 1, 't')`).bind(petId, date, kcal).run();
}

test('前置確認：歷史列 kcalEstimated 真的是 NULL（欄位可為 NULL）', async () => {
  const { db, pet } = await seed();
  seedHistoricalSummary(db, pet.petId, '2026-01-01', 42);
  const raw = db.prepare("SELECT kcalEstimated FROM daily_summary WHERE date='2026-01-01'").bind().first();
  assert.equal(raw.kcalEstimated, null, '既有歷史列為 NULL＝未知');
});

test('歷史 NULL＋底層用類型預設 → getSummaries 推導為估算（不得當精準）', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: '', foodType: '罐頭', amount: 40, when: '2026-01-01 09:00' }); // 無品牌 → 類型預設
  seedHistoricalSummary(db, pet.petId, '2026-01-01', 36);
  const rows = await getSummaries(db, pet.petId, '2026-01-01', '2026-01-01');
  assert.equal(Number(rows[0].kcalEstimated), 1, '底層是類型預設 → 必須推導為估算，不得顯示精準');
});

test('歷史 NULL＋底層全品牌自訂 → getSummaries 推導為精準（可不標粗估）', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: 'f-brand', foodType: '罐頭', amount: 40, when: '2026-01-02 09:00' });
  seedHistoricalSummary(db, pet.petId, '2026-01-02', 42);
  const rows = await getSummaries(db, pet.petId, '2026-01-02', '2026-01-02');
  assert.equal(Number(rows[0].kcalEstimated), 0, '全品牌自訂 → 精準');
});

test('歷史 NULL＋同日「品牌自訂＋類型預設」混合 → 整天標估算', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: 'f-brand', foodType: '罐頭', amount: 40, when: '2026-01-03 08:00' });
  await food(db, pet, { foodId: '', foodType: '乾糧', amount: 10, when: '2026-01-03 18:00' });
  seedHistoricalSummary(db, pet.petId, '2026-01-03', 79);
  const rows = await getSummaries(db, pet.petId, '2026-01-03', '2026-01-03');
  assert.equal(Number(rows[0].kcalEstimated), 1, '混合日 → 只要有一筆估算就標估算');
});

test('歷史 NULL＋當天只有非食物（喝水/用藥/嘔吐/體重） → 不得標估算', async () => {
  const { db, pet } = await seed();
  await insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: '2026-01-04 09:00', category: 'water', amount: 60, waterMl: 60, unit: 'ml', recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
  await insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: '2026-01-04 10:00', category: 'vomit', note: '黃液', recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
  seedHistoricalSummary(db, pet.petId, '2026-01-04', 0); // 無熱量
  const rows = await getSummaries(db, pet.petId, '2026-01-04', '2026-01-04');
  assert.equal(Number(rows[0].kcalEstimated), 0, '非食物紀錄不影響、無熱量 → 非估算');
});

test('LINE 7 日摘要（weekFlex）：歷史 NULL 的類型預設日 → 卡片顯示「粗估」', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: '', foodType: '罐頭', amount: 40, when: '2026-01-05 09:00' });
  seedHistoricalSummary(db, pet.petId, '2026-01-05', 36);
  const rows = await getRecentSummaries(db, pet.petId, '2026-01-05', 7); // 內部走 getSummaries → 已推導
  const s = JSON.stringify(weekFlex('蚵仔', rows));
  assert.ok(s.includes('粗估'), '週摘要不得把歷史類型預設日顯示為精準');
});

test('A4：歷史 NULL 的類型預設日 → 每日明細與熱量卡標為估算（模擬 collectA4Data 對映）', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: '', foodType: '乾糧', amount: 12, when: '2026-01-06 09:00' });
  seedHistoricalSummary(db, pet.petId, '2026-01-06', 44);
  const rows = await getSummaries(db, pet.petId, '2026-01-06', '2026-01-06');
  // collectA4Data 的對映：每日 kcalEstimated: !!Number(r.kcalEstimated)、熱量卡 estimated: trend.some(...)
  const daily = rows.map((r) => ({ date: r.date, kcal: r.kcal, kcalEstimated: !!Number(r.kcalEstimated) }));
  const metricEstimated = rows.some((r) => Number(r.kcalEstimated));
  assert.equal(daily[0].kcalEstimated, true, 'A4 每日明細不得顯示為精準');
  assert.equal(metricEstimated, true, 'A4 熱量卡不得顯示為精準');
});

test('重新 recompute 後仍寫入明確 0／1（新資料不受相容邏輯影響）', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: '', foodType: '罐頭', amount: 40, when: '2026-01-07 09:00' });
  seedHistoricalSummary(db, pet.petId, '2026-01-07', 36);
  await recomputeDay(db, pet.petId, '2026-01-07');
  const raw = db.prepare("SELECT kcalEstimated FROM daily_summary WHERE date='2026-01-07'").bind().first();
  assert.equal(Number(raw.kcalEstimated), 1, 'recompute 後為明確 1（非 NULL）');
});
