// 教學一致性（LINE 指引 + 照護站文案）必須與實際 parser／功能一致（§12、§15）。
//  - LINE 主教學維持「不用學格式」，含新核心例句，不以有歧義的「主食-3」為主案例。
//  - 照護站清楚說明「設為預設」的效果，且不得暗示「一定要設定預設才能用」。
//  - 每個被教學的例句都要真的能被 parser 解析（不放尚未實作的語句）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseMessage } from '../src/parser.js';
import { helpText, recordTutorial, unknownReply } from '../src/replies.js';

const WEB = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'), 'utf8');

test('A LINE help 含核心例句：主食3 / 乾乾10 / 最近吃什麼', () => {
  const h = helpText();
  for (const ex of ['主食3', '乾乾10', '最近吃什麼']) assert.ok(h.includes(ex), `help 應含「${ex}」`);
});

test('B LINE help 不以「主食-3」作主要示範（示範清楚的 乾乾減5）', () => {
  const h = helpText();
  assert.ok(!h.includes('主食-3'), 'help 不得把 主食-3 當主案例');
  assert.ok(h.includes('乾乾減5'), 'help 應示範清楚的 乾乾減5');
});

test('C LINE 教學告知：可在照護站設「預設」，之後簡短紀錄', () => {
  const t = recordTutorial();
  assert.ok(/預設/.test(t) && /照護站/.test(t), '第二層教學應提到照護站可設預設');
  assert.ok(t.includes('乾乾3') || t.includes('主食5'), '應示範設預設後的簡短紀錄');
});

test('D 照護站含「設為預設」的效果說明（自動套用這款）', () => {
  assert.ok(WEB.includes('設為預設'), '應有「設為預設」控制');
  assert.ok(WEB.includes('自動套用這款'), '應說明預設效果＝之後少打品牌名');
});

test('E 照護站不得暗示「一定要設定預設才能使用」', () => {
  for (const bad of ['一定要設定預設', '設定後才能', '請先設定預設食物']) {
    assert.ok(!WEB.includes(bad), `不得出現強制性文案「${bad}」`);
  }
  assert.ok(WEB.includes('沒設定也能用'), '應明說沒設定也能用');
});

test('F 照護站說明乾糧沒品牌熱量時以 3.7 kcal/g 粗估', () => {
  assert.ok(WEB.includes('3.7') && WEB.includes('粗估'), '應說明乾糧 3.7 粗估');
});

test('G 照護站說明零食沒熱量時不自動估算／未計入', () => {
  assert.ok(WEB.includes('零食') && (WEB.includes('未計入') || WEB.includes('不自動估算')), '應說明零食未計入');
});

test('H 教學示範句全部可被 parser 解析（不放尚未實作的語句）', () => {
  const cases = [
    ['主食3', 'record', '主食罐'], ['副食5', 'record', '副食罐'], ['乾乾10', 'record', '乾糧'],
    ['乾乾 10', 'record', '乾糧'], ['罐罐20', 'record', '罐頭'], ['零食3', 'record', '零食'],
    ['乾乾減5', 'foodAdjust', '乾糧'], ['主食扣3', 'foodAdjust', '主食罐'],
    ['剩10', 'fixLast', null], ['主食改成20', 'record', '主食罐'],
    ['今天喝多少', 'query', null], ['今天吃多少', 'query', null],
    ['最近吃什麼', 'query', null], ['之前吃過哪些罐頭', 'query', null]
  ];
  for (const [text, type, ft] of cases) {
    const r = parseMessage(text);
    assert.equal(r.type, type, `「${text}」應解析為 ${type}，實得 ${r.type}`);
    if (ft) {
      const got = r.type === 'record' ? r.record.foodType : r.foodType; // record 在 r.record.foodType、foodAdjust 在 r.foodType
      assert.equal(got, ft, `「${text}」foodType 應為 ${ft}`);
    }
  }
  // 帶品牌的例句：解析為「品名＋數量」候選（測試資料有對應品牌時才會命中既有 food_item）
  const brand = parseMessage('希爾斯10');
  assert.equal(brand.type, 'item_lookup_candidate');
  assert.equal(brand.itemName, '希爾斯');
});
