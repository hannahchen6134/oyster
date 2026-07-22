// 計算核心的自動化測試——每次改熱量/摘要邏輯前後都要跑：node --test test/
// 重點：守住「記錄某類不該動到別類」的不變量，擋掉「加了新食物類型卻漏改摘要」這種低級錯誤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailySummary, deriveFoodFields, WET_FOOD_TYPES } from '../src/summary.js';

const foodLog = (foodType, amount, kcal, waterMl = 0) => ({ category: 'food', foodType, amount, kcal, waterMl });
const waterLog = (amount) => ({ category: 'water', amount, waterMl: amount });
const medLog = () => ({ category: 'med', medSlot: '早', medStatus: '已吃' });
const weightLog = (kg) => ({ category: 'weight', amount: kg, unit: 'kg' });

test('不變量：記體重不會改到食物、熱量、水分', () => {
  const base = [foodLog('乾糧', 20, 76), waterLog(30)];
  const before = computeDailySummary(base);
  const after = computeDailySummary([...base, weightLog(4.2)]);
  assert.equal(after.kcal, before.kcal);
  assert.equal(after.dryFoodG, before.dryFoodG);
  assert.equal(after.totalWaterMl, before.totalWaterMl);
});

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

// 黃金回歸值：鎖住「已驗證正確」的加總公式，任何改動讓數字跑掉就立刻紅。
// 乾糧＝原始克數；罐頭/濕糧＝固形量(克數−含水)；熱量＝各筆相加；總水分＝直接喝＋食物含水。
test('黃金回歸：一個代表日的每日總結必須完全等於已知正確值', () => {
  const logs = [
    foodLog('乾糧', 20, 76, 0),      // 乾 20g、76 kcal
    foodLog('罐頭', 30, 28.8, 24),   // 濕固形 30−24=6g、28.8 kcal、含水24
    foodLog('濕糧', 20, 20, 15),     // 濕固形 20−15=5g、20 kcal、含水15
    foodLog('零食', 5, 0, 0),        // 其他 5g、無熱量
    waterLog(50)                     // 直接喝 50
  ];
  const s = computeDailySummary(logs);
  assert.equal(s.dryFoodG, 20, '乾糧克數');
  assert.equal(s.wetFoodG, 11, '濕的固形量 6+5');
  assert.equal(s.otherFoodG, 5, '零食算其他');
  assert.equal(Math.round(s.kcal * 10) / 10, 124.8, '熱量＝76+28.8+20');
  assert.equal(s.foodWaterMl, 39, '食物含水 24+15');
  assert.equal(s.totalWaterMl, 89, '總水分＝直接喝50＋食物含水39');
  assert.equal(s.entryCount, 5);
});
