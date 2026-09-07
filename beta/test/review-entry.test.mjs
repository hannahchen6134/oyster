// LINE「紀錄／回顧入口」自然語言規則：模糊回顧詞 → 入口卡；明確食物語意 → 直接食物歷史／時間軸；
// 食物類型別名帶 filter；且不得把「食物類型＋數字」的新增紀錄誤判成查詢。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, parseLooseFoodReview } from '../src/parser.js';
import { reviewMenuFlex } from '../src/flex.js';
import { helpText } from '../src/replies.js';

const p = (t) => parseMessage(t);

// ── §一 模糊回顧詞 → reviewMenu（不直接猜食物）──
test('§一 模糊回顧詞 → reviewMenu 入口卡（紀錄／記錄／最近／之前的紀錄／查看紀錄）', () => {
  for (const w of ['紀錄', '記錄', '最近', '之前的紀錄', '查看紀錄', '看紀錄', '查記錄']) {
    assert.deepEqual(p(w), { type: 'query', query: 'reviewMenu' }, `「${w}」應為 reviewMenu`);
  }
});

test('記／紀錄類「新增」詞不受影響：記一筆 / 新增 / 我要記錄 仍是 recordMenu', () => {
  for (const w of ['記一筆', '新增', '我要記錄', '我要紀錄', '快速記錄']) {
    assert.deepEqual(p(w), { type: 'query', query: 'recordMenu' }, `「${w}」仍應為 recordMenu`);
  }
});

// ── §二 明確食物查詢 → 直接食物歷史（不再多問）──
test('§二 明確食物查詢 → foodHistory（最近吃什麼／吃過什麼／飲食紀錄／食物紀錄／最近的飲食）', () => {
  for (const w of ['最近吃什麼', '吃過什麼', '之前吃什麼', '飲食紀錄', '食物紀錄', '最近的飲食', '吃什麼']) {
    const r = p(w);
    assert.equal(r.type, 'query', `「${w}」應為 query`);
    assert.equal(r.query, 'foodHistory', `「${w}」應直接進 foodHistory，不出入口卡`);
  }
});

// ── §三 明確 foodType → 帶 filter（別名對應）──
test('§三 明確 foodType → foodTimeline 帶對應類型（乾乾=乾糧、罐罐=罐頭、主食=主食罐、副食=副食罐）', () => {
  const cases = [['最近乾糧', '乾糧'], ['最近乾乾', '乾糧'], ['最近罐頭', '罐頭'], ['最近罐罐', '罐頭'], ['最近主食', '主食罐'], ['最近副食', '副食罐']];
  for (const [w, ft] of cases) {
    const r = p(w);
    assert.equal(r.query, 'foodTimeline', `「${w}」應為 foodTimeline`);
    assert.equal(r.foodType, ft, `「${w}」→ foodType=${ft}`);
  }
});

test('§三 之前吃過哪些乾糧 → 全歷史食物查詢帶乾糧', () => {
  const r = p('之前吃過哪些乾糧');
  assert.equal(r.query, 'foodHistory');
  assert.equal(r.foodType, '乾糧');
  assert.equal(r.scope, 'all');
});

// ── §四 不影響新增紀錄：食物類型＋數字一律 record ──
test('§四 食物類型＋數字仍是新增紀錄，不得變 query（乾乾5／主食3／喝水30／罐罐10）', () => {
  assert.equal(p('乾乾5').type, 'record');
  assert.equal(p('乾乾5').record.foodType, '乾糧');
  assert.equal(p('乾乾5').record.amount, 5);
  assert.equal(p('主食3').type, 'record');
  assert.equal(p('主食3').record.amount, 3);
  const w = p('喝水30');
  assert.equal(w.type, 'record');
  assert.equal(w.record.category, 'water');
  assert.equal(p('罐罐10').type, 'record');
  // 純函式層再確認：帶數字一律不攔
  assert.equal(parseLooseFoodReview('乾乾5'), null);
  assert.equal(parseLooseFoodReview('喝水30'), null);
});

test('§四 邊界：純類型別名（無數字、無回顧語境）不被誤判成 query（乾乾／罐罐 → 非 query）', () => {
  for (const w of ['乾乾', '罐罐', '主食']) {
    assert.notEqual(p(w).type, 'query', `「${w}」不應被當查詢`);
  }
});

// ── §五 入口卡：手機單手、單一 tap、四類＋完整入口 ──
test('§五 reviewMenuFlex：三個入口（今天／近七天／吃過的食物）＋完整紀錄，皆一鍵', () => {
  const json = JSON.stringify(reviewMenuFlex('https://site'));
  assert.ok(json.includes('想看哪種紀錄？'), '標題');
  assert.ok(json.includes('吃過的食物') && json.includes('今天') && json.includes('近七天'), '三個不同用途入口');
  assert.ok(json.includes('"text":"最近吃什麼"'), '吃過的食物 → 打「最近吃什麼」（沿用既有查詢）');
  assert.ok(json.includes('"uri":"https://site"'), '完整紀錄 → 照護站連結');
  // 點了會真的通到既有 handler：模擬按鈕送出的文字
  assert.equal(p('最近吃什麼').query, 'foodHistory', '按鈕文字可被 parser 接住');
  assert.equal(p('今天').query, 'today');
});

// ── §六 教學同步 ──
test('§六 教學第二層加一句：可直接打「紀錄」跳入口', () => {
  const h = helpText();
  assert.ok(h.includes('紀錄') && h.includes('入口'), 'help 提到打「紀錄」會跳入口');
  assert.ok(h.includes('最近吃什麼'), 'help 仍保留「最近吃什麼」例句');
});
