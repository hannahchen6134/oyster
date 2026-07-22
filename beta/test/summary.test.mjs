// 計算核心的自動化測試——每次改熱量/摘要邏輯前後都要跑：node --test test/
// 重點：守住「記錄某類不該動到別類」的不變量，擋掉「加了新食物類型卻漏改摘要」這種低級錯誤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailySummary, deriveFoodFields, WET_FOOD_TYPES } from '../src/summary.js';

const foodLog = (foodType, amount, kcal, waterMl = 0) => ({ category: 'food', foodType, amount, kcal, waterMl });
const waterLog = (amount) => ({ category: 'water', amount, waterMl: amount });
const medLog = () => ({ category: 'med', medSlot: '早', medStatus: '已吃' });

test('deriveFoodFields：可估算類型有預設值、標 estimated', () => {
  for (const t of ['乾糧', '罐頭', '濕糧', '濕食']) {
    const d = deriveFoodFields(10, t, null);
    assert.ok(d.kcal > 0, `${t} 應該有估算熱量`);
    assert.equal(d.estimated, true, `${t} 沒品項公式時應標估算`);
  }
});

test('deriveFoodFields：零食/其他沒有預設值、不假裝估算', () => {
  for (const t of ['零食', '其他']) {
    const d = deriveFoodFields(10, t, null);
    assert.equal(d.kcal, 0);
    assert.equal(d.estimated, false);
  }
});

test('deriveFoodFields：有精確公式就用精確值、不算估算', () => {
  const d = deriveFoodFields(10, '乾糧', { kcalPerGram: 4.0 });
  assert.equal(d.kcal, 40);
  assert.equal(d.estimated, false);
});

test('computeDailySummary：熱量＝所有食物筆 kcal 相加', () => {
  const s = computeDailySummary([foodLog('乾糧', 21, 79.8), foodLog('罐頭', 5, 4.1, 4), foodLog('乾糧', 6, 22.8)]);
  assert.equal(Math.round(s.kcal * 10) / 10, 106.7);
});

test('每一種「濕的」類型都算進 wetFoodG（固形量），不會掉進 other', () => {
  for (const t of WET_FOOD_TYPES) {
    const s = computeDailySummary([foodLog(t, 20, 20, 15)]); // 20g，含水15 → 固形5
    assert.equal(s.wetFoodG, 5, `${t} 應算 5g 固形`);
    assert.equal(s.otherFoodG, 0, `${t} 不該掉進 other`);
  }
});

test('不變量：加一筆喝水，不會改到食物與熱量', () => {
  const foods = [foodLog('乾糧', 21, 79.8), foodLog('濕糧', 20, 20, 15)];
  const before = computeDailySummary(foods);
  const after = computeDailySummary([...foods, waterLog(28)]);
  assert.equal(after.kcal, before.kcal, '喝水不該改變熱量');
  assert.equal(after.dryFoodG, before.dryFoodG);
  assert.equal(after.wetFoodG, before.wetFoodG);
  assert.equal(after.otherFoodG, before.otherFoodG);
  assert.equal(after.totalWaterMl, before.totalWaterMl + 28, '喝水應只加水分');
});

test('不變量：加一筆餵藥，不會改到食物、熱量、水分', () => {
  const foods = [foodLog('乾糧', 21, 79.8), foodLog('罐頭', 7, 5.8, 5.6)];
  const before = computeDailySummary(foods);
  const after = computeDailySummary([...foods, medLog()]);
  assert.equal(after.kcal, before.kcal, '餵藥不該改變熱量');
  assert.equal(after.dryFoodG, before.dryFoodG);
  assert.equal(after.wetFoodG, before.wetFoodG);
  assert.equal(after.totalWaterMl, before.totalWaterMl);
  assert.equal(after.medTakenCount, 1);
});

test('已刪除的紀錄不列入任何加總', () => {
  const s = computeDailySummary([foodLog('乾糧', 21, 79.8), { ...foodLog('濕糧', 20, 20, 15), isDeleted: 1 }]);
  assert.equal(s.kcal, 79.8, '刪掉的濕糧不該算進熱量');
  assert.equal(s.wetFoodG, 0);
});
