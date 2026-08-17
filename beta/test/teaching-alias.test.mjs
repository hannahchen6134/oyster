// 教學一致性（§26）：LINE／網站教到的例句必須真的可用，且家庭叫法要誠實說「第一次會先問」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseMessage } from '../src/parser.js';
import { recordTutorialFlex } from '../src/flex.js';
import { helpText } from '../src/replies.js';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, '../public/index.html'), 'utf8');

test('LINE 教學例句真的可用（乾乾5／主食3／罐罐10／喝水30／嘔吐 白沫／乾乾減5／罐罐剩10）', () => {
  assert.equal(parseMessage('乾乾5').type, 'record');
  assert.equal(parseMessage('主食3').record.foodType, '主食罐');
  assert.equal(parseMessage('罐罐10').record.foodType, '罐頭');
  assert.equal(parseMessage('喝水30').record.category, 'water');
  assert.equal(parseMessage('嘔吐 白沫').record.category, 'vomit');
  assert.equal(parseMessage('乾乾減5').type, 'foodAdjust');
  assert.equal(parseMessage('罐罐剩10').type, 'foodAdjust');
});

test('回顧教學詞真的可用（紀錄／最近吃什麼／最近乾糧／之前吃過哪些罐頭）', () => {
  assert.equal(parseMessage('紀錄').query, 'reviewMenu');
  assert.equal(parseMessage('最近吃什麼').query, 'foodHistory');
  assert.equal(parseMessage('最近乾糧').query, 'foodTimeline');
  assert.equal(parseMessage('最近乾糧').foodType, '乾糧');
  assert.equal(parseMessage('之前吃過哪些罐頭').query, 'foodHistory');
});

test('家庭叫法教學誠實：肉5 未設定時不是自動食物；教學說明「第一次會先問／先讓管家記住」', () => {
  // 未設定別名時，肉5 不會被當成罐頭自動記——需先讓管家記住
  assert.notEqual(parseMessage('肉5').type, 'record', '肉5 未設定不得直接變食物紀錄');
  const j = JSON.stringify(recordTutorialFlex());
  assert.ok(j.includes('家裡自己的說法') && j.includes('肉5'), '第二層有家裡自己的說法＋肉5 例子');
  assert.ok(j.includes('會先問') || j.includes('先讓管家記住'), '誠實說明第一次會先問／要先記住');
  const h = helpText();
  assert.ok(h.includes('肉5') && h.includes('會先問'), 'help 也誠實說明第一次會先問');
});

test('網站食物說明含三個「為什麼要設」＋生活化用詞，且保留沒設定也能先記', () => {
  // 抽出 foods hint 區塊
  const i = html.indexOf('大部分紀錄直接在 LINE 打一句就好');
  assert.ok(i > 0, 'foods hint 已改為生活化第一句');
  const hint = html.slice(i, i + 700);
  for (const kw of ['設為預設', '實際熱量', '系統粗估值', '家裡習慣的叫法', '沒設定也可以先記', '3.7']) {
    assert.ok(hint.includes(kw), `foods hint 應含「${kw}」`);
  }
  // 品牌歷史引導（§20）
  assert.ok(hint.includes('吃過的食物'), '提到有品牌之後能在「吃過的食物」回看');
  // 不露技術詞
  assert.ok(!/foodId|kcalSource|targetType/.test(hint), 'hint 不露技術欄位');
});
