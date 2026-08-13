// 零食（§3、§4）：獨立食物類型，但「不設統一 kcal/g 預設」——肉泥/凍乾/餅乾差太多。
//  - 「明確類型/別名＋正數」超口語輸入（含各種空白、可省略單位）→ 記成零食 Ng。
//  - 沒有品牌熱量 → kcal 一律 0、不假估算、不標「估算」、不做水分粗估。
//  - 有既有零食 food_item 的 kcalPerGram → 正常用品牌熱量計算。
//  - 零食歸「其他食物」桶（otherFoodG），不錯誤併入主食罐/副食罐/乾糧/濕食統計。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage } from '../src/parser.js';
import { deriveFoodFields, isKcalEstimated, TYPE_KCAL_DEFAULT, computeDailySummary } from '../src/summary.js';

test('零食超口語輸入：各種空白／有無單位全部等價 → 零食 3g', () => {
  const variants = ['零食3', '零食 3', '零食   3', '零食3g', '零食 3 g', '零食3克', '零食 3 克'];
  const base = JSON.stringify(parseMessage('零食3'));
  for (const v of variants) {
    const r = parseMessage(v);
    assert.equal(r.type, 'record', `「${v}」應成立為 record`);
    assert.equal(r.record.foodType, '零食');
    assert.equal(r.record.amount, 3);
    assert.equal(r.record.unit, 'g');
    assert.equal(JSON.stringify(r), base, `「${v}」應與「零食3」完全等價`);
  }
});

test('「點心」作為零食 alias，且不過度匹配（點心3 → 零食；單獨數字/主3 不成立）', () => {
  const r = parseMessage('點心3');
  assert.equal(r.type, 'record');
  assert.equal(r.record.foodType, '零食');
  assert.equal(r.record.amount, 3);
  // 負向：語意不明確者不得被當成零食或任何食物直接記錄
  for (const x of ['3', '吃3', '點3']) {
    assert.notEqual(parseMessage(x).type, 'record', `「${x}」不得直接建立食物紀錄`);
  }
});

test('零食沒有統一 kcal 預設：沒有品牌熱量時 kcal=0、不假估算、不估水', () => {
  assert.equal(TYPE_KCAL_DEFAULT['零食'], undefined, '零食不得有類型預設 kcal');
  const d = deriveFoodFields(3, '零食', null);
  assert.equal(d.kcal, 0, '沒品牌熱量 → 不亂估 kcal');
  assert.equal(d.waterMl, 0, '零食不做水分粗估');
  assert.equal(d.estimated, false, '不得標成「估算」');
  // 一筆 kcal=0 的零食 log 不算「估算」（不會讓當日誤標含估算）
  assert.equal(isKcalEstimated({ foodType: '零食', kcal: 0 }), false);
});

test('零食有既有品牌 kcalPerGram → 用品牌熱量正常計算（不視為估算）', () => {
  const ciao = { kcalPerGram: 2.5, waterRatio: 0 };
  const d = deriveFoodFields(4, '零食', ciao);
  assert.equal(d.kcal, 10, '4g × 2.5 = 10 kcal');
  assert.equal(d.estimated, false, '品牌自訂 → 精準、非估算');
  assert.equal(isKcalEstimated({ foodType: '零食', kcal: 10, foodKcalPerGram: 2.5 }, ciao), false);
});

test('零食歸「其他食物」桶，不併入乾糧/濕食/主食罐統計', () => {
  const s = computeDailySummary([
    { category: 'food', foodType: '零食', amount: 3, kcal: 0, waterMl: 0, isDeleted: 0 },
    { category: 'food', foodType: '主食罐', amount: 30, kcal: 30, waterMl: 23, isDeleted: 0 },
    { category: 'food', foodType: '乾糧', amount: 10, kcal: 37, waterMl: 0, isDeleted: 0 }
  ]);
  assert.equal(s.otherFoodG, 3, '零食 3g → 其他食物桶');
  assert.equal(s.dryFoodG, 10, '乾糧不受零食影響');
  assert.ok(s.wetFoodG > 0, '主食罐仍計入濕食桶');
  assert.equal(s.kcal, 67, '總熱量＝主食罐 30＋乾糧 37；零食 0 不灌水');
});
