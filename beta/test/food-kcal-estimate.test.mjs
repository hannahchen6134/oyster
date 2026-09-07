// P0-3 護欄：用「類型預設」估算的熱量，畫面一律標「粗估／約」；有品牌自訂每克熱量的則精確、不標。
//  - isKcalEstimated 純判斷：品牌自訂→精確；無自訂＋可估類型→估算；零食/其他/0大卡→不算。
//  - computeDailySummary.kcalEstimated：當日含任一估算食物筆 → true。
//  - getLogsForDay 帶出 foodKcalPerGram；recomputeDay 落地 kcalEstimated；getSummaries 讀得到。
//  - flex 卡片：估算時熱量單位標「kcal・粗估」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createPet, insertLog, getLogsForDay, recomputeDay, getSummaries } from '../src/db.js';
import { isKcalEstimated, computeDailySummary, deriveFoodFields } from '../src/summary.js';
import { todayFlex } from '../src/flex.js';

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
  // 品牌罐頭（有自訂每克熱量 1.05）＋ 無品牌只填類型的罐頭
  db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-brand','u1','巔峰罐頭','罐頭',1.05,0.8,'t','t')").bind().run();
  return { db, pet };
}
async function food(db, pet, { foodId = '', foodType = '罐頭', amount = 40, kcal, when = '2026-08-10 09:00' }) {
  const derived = deriveFoodFields(amount, foodType, foodId === 'f-brand' ? { kcalPerGram: 1.05 } : null);
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName: foodType, foodId, amount, unit: 'g', kcal: kcal ?? derived.kcal, waterMl: derived.waterMl, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}

test('isKcalEstimated：品牌自訂→false；無自訂＋可估類型→true；0大卡/零食→false', () => {
  assert.equal(isKcalEstimated({ kcal: 42, foodType: '罐頭' }, { kcalPerGram: 1.05 }), false, '品牌自訂＝精確');
  assert.equal(isKcalEstimated({ kcal: 42, foodType: '罐頭', foodKcalPerGram: 1.05 }), false, 'log 帶自訂＝精確');
  assert.equal(isKcalEstimated({ kcal: 36, foodType: '罐頭' }), true, '無自訂＋罐頭＝估算');
  assert.equal(isKcalEstimated({ kcal: 0, foodType: '罐頭' }), false, '沒熱量不算估算');
  assert.equal(isKcalEstimated({ kcal: 10, foodType: '零食' }), false, '零食沒預設＝不算估算');
});

test('computeDailySummary.kcalEstimated：含任一估算食物筆 → true；全品牌自訂 → false', () => {
  const estDay = computeDailySummary([{ category: 'food', foodType: '罐頭', amount: 40, kcal: 36, waterMl: 32 }]);
  assert.equal(estDay.kcalEstimated, true);
  const exactDay = computeDailySummary([{ category: 'food', foodType: '罐頭', amount: 40, kcal: 42, waterMl: 32, foodKcalPerGram: 1.05 }]);
  assert.equal(exactDay.kcalEstimated, false);
  const mixed = computeDailySummary([
    { category: 'food', foodType: '罐頭', amount: 40, kcal: 42, waterMl: 32, foodKcalPerGram: 1.05 },
    { category: 'food', foodType: '乾糧', amount: 10, kcal: 37 }
  ]);
  assert.equal(mixed.kcalEstimated, true, '有一筆估算就標含估算');
});

test('getLogsForDay 帶出 foodKcalPerGram；品牌筆不算估算、純類型筆算估算', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: 'f-brand', amount: 40, when: '2026-08-10 09:00' });
  await food(db, pet, { foodId: '', foodType: '乾糧', amount: 10, when: '2026-08-10 10:00' });
  const logs = await getLogsForDay(db, pet.petId, '2026-08-10');
  const brand = logs.find((l) => l.foodId === 'f-brand');
  assert.equal(Number(brand.foodKcalPerGram), 1.05, 'LEFT JOIN 帶出品牌每克熱量');
  const s = computeDailySummary(logs);
  assert.equal(s.kcalEstimated, true, '有乾糧純類型筆 → 含估算');
});

test('recomputeDay 落地 kcalEstimated、getSummaries 讀得到（週/月/摘要可用）', async () => {
  const { db, pet } = await seed();
  await food(db, pet, { foodId: '', foodType: '罐頭', amount: 40, when: '2026-08-10 09:00' });
  await recomputeDay(db, pet.petId, '2026-08-10');
  const rows = await getSummaries(db, pet.petId, '2026-08-10', '2026-08-10');
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].kcalEstimated), 1, '當日含估算 → 存 1');
  // 改為只有品牌自訂那筆 → 重算後不含估算
  const db2 = (await seed());
  await food(db2.db, db2.pet, { foodId: 'f-brand', amount: 40, when: '2026-08-11 09:00' });
  await recomputeDay(db2.db, db2.pet.petId, '2026-08-11');
  const rows2 = await getSummaries(db2.db, db2.pet.petId, '2026-08-11', '2026-08-11');
  assert.equal(Number(rows2[0].kcalEstimated), 0, '全品牌自訂 → 存 0');
});

test('todayFlex：估算日熱量單位標「粗估」，精確日不標', () => {
  const est = todayFlex({ pet: { petName: '蚵仔' }, date: '2026-08-10', dateLabel: '8/10', summary: { totalWaterMl: 50, dryFoodG: 0, wetFoodG: 40, otherFoodG: 0, kcal: 36, kcalEstimated: true, meds: [], vomitCount: 0 } });
  const s = JSON.stringify(est);
  assert.ok(s.includes('粗估'), '估算日要出現「粗估」');
  const exact = todayFlex({ pet: { petName: '蚵仔' }, date: '2026-08-10', dateLabel: '8/10', summary: { totalWaterMl: 50, dryFoodG: 0, wetFoodG: 40, otherFoodG: 0, kcal: 42, kcalEstimated: false, meds: [], vomitCount: 0 } });
  const s2 = JSON.stringify(exact);
  assert.ok(!s2.includes('粗估'), '精確日不得出現「粗估」');
});
