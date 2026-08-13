// 「熱量不完整」語意（部署前小補強）：有食物熱量無法計算（零食／其他無品牌熱量）時，
// 當日總熱量不得被呈現成完整精準值。純衍生（不改 schema、不改 logs、不改 food_items）。
//  - computeDailySummary 產生 unknownKcalCount / kcalIncomplete。
//  - getSummaries 讀時衍生（週/月/網站/A4 共用）。
//  - buildHandoff.totals、replies.kcalText / weekReply / handoffReply 不把不完整當完整。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { computeDailySummary, isKcalUnknown, buildHandoff } from '../src/summary.js';
import { kcalText, weekReply, handoffReply, summaryBlock } from '../src/replies.js';
import { createPet, insertLog, recomputeDay, getSummaries } from '../src/db.js';
import { taipeiToday } from '../src/util.js';

const food = (o) => ({ category: 'food', isDeleted: 0, amount: o.a, foodType: o.ft, kcal: o.k || 0, waterMl: o.w || 0, foodKcalPerGram: o.fk || 0 });

// ───────────────────────── computeDailySummary 三態（§7.1-7.7）─────────────────────────

test('1) 品牌精準主食 + 未知零食 → incomplete=true、unknownKcalCount>0（不得只顯示精準總熱量）', () => {
  const s = computeDailySummary([food({ a: 30, ft: '主食罐', k: 36, fk: 1.2 }), food({ a: 3, ft: '零食', k: 0 })]);
  assert.equal(s.kcal, 36);
  assert.equal(s.kcalEstimated, false);
  assert.equal(s.kcalIncomplete, true);
  assert.equal(s.unknownKcalCount, 1);
});

test('2) 類型粗估主食 + 未知零食 → 同時 estimated=true 且 incomplete=true（不假裝完整）', () => {
  const s = computeDailySummary([food({ a: 100, ft: '主食罐', k: 100 }), food({ a: 3, ft: '零食', k: 0 })]);
  assert.equal(s.kcalEstimated, true);
  assert.equal(s.kcalIncomplete, true);
  assert.equal(s.unknownKcalCount, 1);
});

test('3) 全部品牌精準 → estimated=false、incomplete=false', () => {
  const s = computeDailySummary([food({ a: 30, ft: '主食罐', k: 36, fk: 1.2 }), food({ a: 10, ft: '乾糧', k: 38, fk: 3.8 })]);
  assert.equal(s.kcalEstimated, false);
  assert.equal(s.kcalIncomplete, false);
  assert.equal(s.unknownKcalCount, 0);
});

test('4) 全部可粗估 → estimated=true、incomplete=false', () => {
  const s = computeDailySummary([food({ a: 30, ft: '罐頭', k: 27 })]);
  assert.equal(s.kcalEstimated, true);
  assert.equal(s.kcalIncomplete, false);
});

test('5) 只有未知零食 → kcal=0 但語意為「未設定」，不得對外顯示成「0 kcal」', () => {
  const s = computeDailySummary([food({ a: 3, ft: '零食', k: 0 })]);
  assert.equal(s.kcal, 0);
  assert.equal(s.kcalIncomplete, true);
  // 對外文字：不是「熱量 0 kcal」，而是「熱量 未設定」
  const t = kcalText(s.kcal, s);
  assert.ok(t.includes('未設定'), `應顯示未設定，實得：${t}`);
  assert.ok(!/熱量 0 kcal$/.test(t), '不得呈現成 0 kcal');
});

test('6) 零食已有品牌 kcalPerGram → 正常計入、incomplete=false', () => {
  const s = computeDailySummary([food({ a: 4, ft: '零食', k: 10, fk: 2.5 })]);
  assert.equal(s.kcal, 10);
  assert.equal(s.kcalIncomplete, false);
  assert.equal(s.unknownKcalCount, 0);
  assert.equal(isKcalUnknown(food({ a: 4, ft: '零食', k: 10, fk: 2.5 })), false);
});

test('7) 非食物（喝水／用藥／嘔吐）不影響 incomplete 狀態', () => {
  const s = computeDailySummary([
    { category: 'water', isDeleted: 0, amount: 30, waterMl: 30 },
    { category: 'med', isDeleted: 0, medStatus: '已吃' },
    { category: 'vomit', isDeleted: 0, note: '白沫' }
  ]);
  assert.equal(s.kcalIncomplete, false);
  assert.equal(s.unknownKcalCount, 0);
  assert.equal(isKcalUnknown({ category: 'water', amount: 30 }), false);
});

// ───────────────────────── 文字回覆不誤導（§7.9 LINE 7 日／交班）─────────────────────────

test('§7.9 weekReply 有未知熱量日不呈現成完整精準值（顯示 + 或 未設定）', () => {
  const rows = [
    { date: `${taipeiToday()}`, entryCount: 2, totalWaterMl: 50, kcal: 36, kcalEstimated: 0, kcalIncomplete: true, unknownKcalCount: 1, medTakenCount: 0, vomitCount: 0, medIssueCount: 0 },
    { date: '2026-08-01', entryCount: 1, totalWaterMl: 0, kcal: 0, kcalEstimated: 0, kcalIncomplete: true, unknownKcalCount: 1, medTakenCount: 0, vomitCount: 0, medIssueCount: 0 }
  ];
  const out = weekReply('蚵仔', rows);
  assert.ok(out.includes('熱36+'), `有部分計入應標 +，實得：${out}`);
  assert.ok(out.includes('熱未設定'), `全未知應標未設定，實得：${out}`);
});

test('handoffReply / summaryBlock：不完整時明講「尚有未計」而非完整總熱量', () => {
  const totals = { waterMl: 50, foodG: 33, kcal: 36, kcalEstimated: false, kcalIncomplete: true, unknownKcalCount: 1 };
  const h = handoffReply({ petName: '蚵仔' }, '8/13', { totals, medTotal: 0, medDone: 0, pending: [], status: [] });
  assert.ok(h.includes('尚未設定熱量') || h.includes('尚有未計'), `交班應提示未計入，實得：${h}`);
  const sb = summaryBlock({ totalWaterMl: 50, dryFoodG: 0, wetFoodG: 30, otherFoodG: 3, kcal: 36, kcalIncomplete: true, unknownKcalCount: 1 });
  assert.ok(sb.includes('尚有未計'), `今日摘要應提示尚有未計，實得：${sb}`);
});

// ───────────────────────── getSummaries 讀時衍生（§7.8 A4／網站來源）─────────────────────────

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

async function addFood(db, pet, { itemName = '', foodType, amount, kcal, when }) {
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName, foodId: '', amount, unit: 'g', kcal, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}

test('§7.8 getSummaries：主食精準＋未知零食的那天 kcalIncomplete=true（A4／網站讀同一份）', async () => {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  const day = '2026-08-10';
  await addFood(db, pet, { foodType: '主食罐', amount: 30, kcal: 36, when: `${day} 09:00` }); // 有 kcal（視為已算）
  await addFood(db, pet, { foodType: '零食', amount: 3, kcal: 0, when: `${day} 15:00` });      // 未知
  await recomputeDay(db, pet.petId, day);

  const rows = await getSummaries(db, pet.petId, day, day);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kcalIncomplete, true, '該天應標不完整');
  assert.equal(rows[0].unknownKcalCount, 1);
  assert.ok(Number(rows[0].otherFoodG) > 0, '零食計入其他食物桶');
});

test('§7.8 getSummaries：只有可估算食物的那天 kcalIncomplete=false（otherFoodG=0 免查 logs）', async () => {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  const day = '2026-08-11';
  await addFood(db, pet, { foodType: '罐頭', amount: 30, kcal: 27, when: `${day} 09:00` });
  await recomputeDay(db, pet.petId, day);
  const rows = await getSummaries(db, pet.petId, day, day);
  assert.equal(rows[0].kcalIncomplete, false);
  assert.equal(rows[0].unknownKcalCount, 0);
});
