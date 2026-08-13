// 乾糧超口語輸入規則（與主食／副食／罐罐的空格彈性完全一致）：
//  - 乾糧／乾乾 皆正規化為 foodType=乾糧。
//  - 「乾糧／乾乾 + 正數」即使沒寫 g／克，也直接把數字當克數。
//  - 食物名與數字之間、數字與 g／克之間，0～任意空白都等價（沿用 normalizeText/compact，不逐種空白寫 regex）。
//  - 無品牌時用類型預設 3.7 kcal/g（estimated=true）；有品牌 kcalPerGram>0 則品牌值優先（estimated=false）。
//  - 不得影響既有品牌匹配。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage, matchFood } from '../src/parser.js';
import { deriveFoodFields, TYPE_KCAL_DEFAULT } from '../src/summary.js';

// 同一組不同空白／有無單位的輸入必須產生「完全相同」的 parsed result
function assertAllEqual(inputs, label) {
  const base = JSON.stringify(parseMessage(inputs[0]));
  for (const x of inputs) {
    assert.equal(JSON.stringify(parseMessage(x)), base, `${label}：「${x}」應與「${inputs[0]}」完全等價，實得 ${JSON.stringify(parseMessage(x))}`);
  }
  return parseMessage(inputs[0]);
}

test('乾糧＋數字（各種空白）→ 乾糧 Ng，且不同空白完全等價', () => {
  const one = assertAllEqual(['乾糧1', '乾糧 1'], '乾糧1');
  assert.equal(one.type, 'record');
  assert.equal(one.record.foodType, '乾糧');
  assert.equal(one.record.amount, 1);
  assert.equal(one.record.unit, 'g');
  assert.equal(assertAllEqual(['乾糧2', '乾糧   2'], '乾糧2').record.amount, 2);
  assert.equal(assertAllEqual(['乾糧3', '乾糧      3'], '乾糧3').record.amount, 3);
});

test('乾乾＋數字（各種空白）→ 正規化成 foodType=乾糧，且不同空白完全等價', () => {
  const one = assertAllEqual(['乾乾1', '乾乾 1'], '乾乾1');
  assert.equal(one.record.foodType, '乾糧', '乾乾 必須正規化成 乾糧');
  assert.equal(one.record.amount, 1);
  assert.equal(one.record.unit, 'g');
  assert.equal(assertAllEqual(['乾乾2', '乾乾   2'], '乾乾2').record.amount, 2);
  assert.equal(assertAllEqual(['乾乾3', '乾乾    3', '乾乾      3'], '乾乾3').record.amount, 3);
});

test('乾糧＋數字＋單位（g／克、各種空白）全部等價（乾糧 1g）', () => {
  const r = assertAllEqual(['乾糧1', '乾糧1g', '乾糧 1g', '乾糧 1 g', '乾糧1克', '乾糧 1 克'], '乾糧1+單位');
  assert.equal(r.record.foodType, '乾糧');
  assert.equal(r.record.amount, 1);
  assert.equal(r.record.unit, 'g');
});

test('乾乾＋數字＋單位（g／克、各種空白）全部等價（乾乾 3g）', () => {
  const r = assertAllEqual(['乾乾3', '乾乾3g', '乾乾 3g', '乾乾 3 g', '乾乾3克', '乾乾 3 克'], '乾乾3+單位');
  assert.equal(r.record.foodType, '乾糧');
  assert.equal(r.record.amount, 3);
  assert.equal(r.record.unit, 'g');
});

test('無品牌乾糧用類型預設 3.7 kcal/g（粗估）：1→3.7、2→7.4、3→11.1，estimated=true', () => {
  assert.equal(TYPE_KCAL_DEFAULT['乾糧'], 3.7);
  for (const [g, kcal] of [[1, 3.7], [2, 7.4], [3, 11.1]]) {
    const d = deriveFoodFields(g, '乾糧', null);
    assert.equal(d.kcal, kcal, `${g}g → ${kcal} kcal`);
    assert.equal(d.estimated, true, `${g}g 無品牌 → 標粗估`);
  }
});

test('乾糧有品牌 kcalPerGram>0 → 品牌值優先、不套 3.7、不標粗估', () => {
  const d = deriveFoodFields(10, '乾糧', { kcalPerGram: 3.8, waterRatio: 0 });
  assert.equal(d.kcal, 38, '10g × 3.8 = 38（用品牌值，非 3.7 預設）');
  assert.equal(d.estimated, false, '品牌自訂 → 精準、非粗估');
});

test('§6 不影響既有品牌匹配：品牌名乾糧仍精確命中，沿用其 foodId/kcalPerGram', () => {
  const foods = [
    { foodId: 'f-hill', displayName: '希爾斯乾糧', brand: '', productName: '', foodType: '乾糧', kcalPerGram: 3.8, isDeleted: 0 }
  ];
  const m = matchFood(foods, '希爾斯乾糧', '乾糧');
  assert.equal(m?.foodId, 'f-hill');
  assert.equal(m?.kcalPerGram, 3.8);
  const d = deriveFoodFields(10, m.foodType, m);
  assert.equal(d.kcal, 38);
  assert.equal(d.estimated, false);
});
