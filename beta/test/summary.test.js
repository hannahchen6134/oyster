import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDailySummary, deriveFoodFields } from '../src/summary.js';

function log(fields) {
  return {
    eventDateTime: '2026-07-09 08:00',
    category: '',
    itemName: '',
    foodType: '',
    amount: 0,
    waterMl: 0,
    kcal: 0,
    medStatus: '',
    medSlot: '',
    note: '',
    isDeleted: 0,
    ...fields
  };
}

test('空清單 → 全零', () => {
  const s = computeDailySummary([]);
  assert.equal(s.entryCount, 0);
  assert.equal(s.totalWaterMl, 0);
  assert.deepEqual(s.abnormalFlags, []);
});

test('喝水加總', () => {
  const s = computeDailySummary([
    log({ category: 'water', amount: 20, waterMl: 20 }),
    log({ category: 'water', amount: 30.5, waterMl: 30.5 })
  ]);
  assert.equal(s.waterMl, 50.5);
  assert.equal(s.totalWaterMl, 50.5);
});

test('食物：乾濕分類、熱量與食物水分（罐頭/濕食只計固形量）', () => {
  const s = computeDailySummary([
    log({ category: 'food', foodType: '乾糧', amount: 40, kcal: 160, waterMl: 3 }),
    log({ category: 'food', foodType: '罐頭', amount: 80, kcal: 72, waterMl: 64 }),
    log({ category: 'food', foodType: '濕食', amount: 20, kcal: 20, waterMl: 15 }),
    log({ category: 'food', foodType: '零食', amount: 5, kcal: 15, waterMl: 0 }),
    log({ category: 'water', amount: 50, waterMl: 50 })
  ]);
  assert.equal(s.dryFoodG, 40);
  assert.equal(s.wetFoodG, 21); // 固形量：(80−64)＋(20−15)
  assert.equal(s.otherFoodG, 5);
  assert.equal(s.kcal, 267); // 熱量照原始克數的登記值
  assert.equal(s.foodWaterMl, 82);
  assert.equal(s.totalWaterMl, 132); // 喝水 50 + 食物 82
});

test('deriveFoodFields：罐頭未設定公式時預設 80% 水分、熱量 0（未計入）', () => {
  const d = deriveFoodFields(50, '罐頭', null);
  assert.equal(d.waterMl, 40);
  assert.equal(d.kcal, 0);
  // 有公式：熱量用原始克數，水分用品項比例
  const d2 = deriveFoodFields(50, '罐頭', { kcalPerGram: 1.2, waterRatio: 0.75 });
  assert.equal(d2.kcal, 60);
  assert.equal(d2.waterMl, 37.5);
  // 乾糧未設定公式不套 80%
  const d3 = deriveFoodFields(40, '乾糧', null);
  assert.equal(d3.waterMl, 0);
});

test('用藥：已吃與異常分開計數', () => {
  const s = computeDailySummary([
    log({ category: 'med', medSlot: '早', medStatus: '已吃' }),
    log({ category: 'med', medSlot: '晚', medStatus: '漏餵' }),
    log({ category: 'med', medStatus: '吐掉', itemName: '心臟藥' })
  ]);
  assert.equal(s.medTakenCount, 1);
  assert.equal(s.medIssueCount, 2);
  assert.equal(s.meds.length, 3);
  assert.ok(s.abnormalFlags.includes('medIssue'));
});

test('嘔吐與便便：次數與備註（含時間）', () => {
  const s = computeDailySummary([
    log({ category: 'vomit', note: '白色泡沫', eventDateTime: '2026-07-09 03:10' }),
    log({ category: 'stool', note: '成形', eventDateTime: '2026-07-09 09:00' }),
    log({ category: 'stool', note: '' })
  ]);
  assert.equal(s.vomitCount, 1);
  assert.equal(s.stoolCount, 2);
  assert.deepEqual(s.vomitNotes, ['03:10 白色泡沫']);
  assert.ok(s.abnormalFlags.includes('vomit'));
});

test('isDeleted 的紀錄不列入計算', () => {
  const s = computeDailySummary([
    log({ category: 'water', amount: 100, waterMl: 100, isDeleted: 1 }),
    log({ category: 'water', amount: 20, waterMl: 20 })
  ]);
  assert.equal(s.waterMl, 20);
  assert.equal(s.entryCount, 1);
});

test('水量以 waterMl 為主、退回 amount', () => {
  const s = computeDailySummary([log({ category: 'water', amount: 25, waterMl: 0 })]);
  assert.equal(s.waterMl, 25);
});
