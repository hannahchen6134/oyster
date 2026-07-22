// 平行常數比對：網站 index.html 是獨立檔案（跑在瀏覽器、不能 import worker），
// 它自己有一份食物類型常數（FOOD）。這個測試自動比對「網站的 FOOD」和「worker 的 summary.js」，
// 只要兩邊有一處不一致（改了一邊漏改另一邊），測試就變紅——結構性擋掉這類低級錯誤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FOOD_TYPES, WET_FOOD_TYPES, TYPE_KCAL_DEFAULT, TYPE_WATER_DEFAULT } from '../src/summary.js';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, '../public/index.html'), 'utf8');
const match = html.match(/const FOOD = (\{[\s\S]*?\});/);
const web = match ? new Function('return ' + match[1])() : null; // 我方檔案、受信任

test('網站 FOOD 常數與 worker summary.js 一致', () => {
  assert.ok(web, '在 index.html 找不到 FOOD 常數');
  assert.deepEqual(web.TYPES, FOOD_TYPES, '食物類型清單（TYPES）與 worker 不一致');
  assert.deepEqual([...web.WET].sort(), [...WET_FOOD_TYPES].sort(), '濕的類型（WET）與 worker 不一致');
  assert.deepEqual(web.KCAL, TYPE_KCAL_DEFAULT, '每克熱量預設（KCAL）與 worker 不一致');
  assert.deepEqual(web.WATER, TYPE_WATER_DEFAULT, '含水預設（WATER）與 worker 不一致');
});
