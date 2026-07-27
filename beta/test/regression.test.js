import test from 'node:test';
import assert from 'node:assert/strict';
import { foodLabel, foodShortcutCmd, autoMedSlot } from '../src/index.js';
import { isWetFoodType, deriveFoodFields, TYPE_KCAL_DEFAULT } from '../src/summary.js';

// 這些是「曾經出過的 bug」的回歸守門員：改壞了會立刻變紅，避免同一個問題偷偷跑回來。

test('foodLabel：品名已含類型時不重複前綴（避免「罐頭 希爾斯罐頭」）', () => {
  assert.equal(foodLabel('罐頭', '希爾斯罐頭'), '希爾斯罐頭');   // 不變「罐頭 希爾斯罐頭」
  assert.equal(foodLabel('乾糧', '希爾斯乾糧'), '希爾斯乾糧');
  assert.equal(foodLabel('罐頭', '皇家'), '罐頭 皇家');          // 品名沒含類型才前綴
  assert.equal(foodLabel('乾糧', ''), '乾糧');                   // 沒品名就只有類型
});

test('foodShortcutCmd：一鍵捷徑指令去除重複類型字，且仍可解析', () => {
  assert.equal(foodShortcutCmd('乾糧', '希爾斯乾糧', 5), '乾糧 希爾斯 5'); // 不變「乾糧 希爾斯乾糧 5」
  assert.equal(foodShortcutCmd('罐頭', '皇家', 30), '罐頭 皇家 30');
  assert.equal(foodShortcutCmd('乾糧', '乾糧', 5), '乾糧 5');              // 品名就是類型 → 只留一個
  assert.equal(foodShortcutCmd('罐頭', '', 24), '罐頭 24');
});

test('autoMedSlot：沒帶時段時依記錄時間歸到最接近的餵藥時段', () => {
  const pet = { goalMedSlots: JSON.stringify(['早', '晚']) };
  assert.equal(autoMedSlot(pet, '2026-07-27 08:00:00'), '早');  // 早上 → 早
  assert.equal(autoMedSlot(pet, '2026-07-27 21:00:00'), '晚');  // 晚上 → 晚
  assert.equal(autoMedSlot({ goalMedSlots: '[]' }, '2026-07-27 08:00:00'), ''); // 沒設時段 → 不猜
  assert.equal(autoMedSlot({}, '2026-07-27 08:00:00'), '');     // 沒欄位也不炸
});

test('生食：屬於濕食（有含水），且有熱量預設', () => {
  assert.equal(isWetFoodType('生食'), true);
  assert.ok(Number(TYPE_KCAL_DEFAULT['生食']) > 0);
  const d = deriveFoodFields(100, '生食', {});
  assert.ok(d.waterMl > 0, '生食應該貢獻水分');
  assert.ok(d.kcal > 0, '生食應該用預設熱量估算');
});
