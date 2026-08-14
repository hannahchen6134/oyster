// LINE 照護說明巡檢：所有「使用者會看到的說明」實際渲染內容都要跟上自然語言規則，不留舊格式。
// 對應入口：說明→menuFlex；怎麼記/怎麼用→quickRecordCarousel；完整記法→recordTutorialFlex；
//          範例→exampleCard；安心上手→onboardingCarousel。此檔直接驗這些「實際渲染」的 Flex 內容。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage } from '../src/parser.js';
import { quickRecordCarousel, exampleCard, recordTutorialFlex, onboardingCarousel } from '../src/flex.js';

const J = (o) => JSON.stringify(o);

test('怎麼記（quickRecordCarousel）第一層：口語核心例句，且不留舊 lead 例句', () => {
  const j = J(quickRecordCarousel({ petName: '蚵仔' }));
  for (const ex of ['主食3', '乾乾10', '喝水30', '嘔吐 白沫', '最近吃什麼', '乾乾減5']) {
    assert.ok(j.includes(ex), `應含「${ex}」`);
  }
  assert.ok(!j.includes('水 60'), '不留舊 lead「水 60」');
  assert.ok(!j.includes('罐頭 皇家 30'), '不把「罐頭 皇家 30」當第一層 lead');
  // 進階層：預設食物＋沒設定也能先記＋粗估
  assert.ok(j.includes('預設食物') && j.includes('沒設定也能先記') && j.includes('粗估'), '進階層應說明預設/沒設定也能先記/粗估');
});

test('範例（exampleCard）：口語核心例句，不留舊格式 lead', () => {
  const j = J(exampleCard());
  for (const ex of ['主食3', '喝水30', '嘔吐 白沫', '最近吃什麼']) assert.ok(j.includes(ex), `應含「${ex}」`);
  assert.ok(!j.includes('水 60') && !j.includes('罐頭 皇家 30'), '不留舊 lead 例句');
});

test('完整記法（recordTutorialFlex）第二層：吃飯／調整／查詢／想更準俱全', () => {
  const j = J(recordTutorialFlex());
  for (const ex of ['主食3', '副食5', '乾乾10', '罐罐20', '零食3', '希爾斯10',
    '乾乾減5', '罐罐剩10', '主食改成20', '喝水30', '最近吃什麼', '之前吃過哪些罐頭']) {
    assert.ok(j.includes(ex), `第二層應含「${ex}」`);
  }
  // 想更準：預設食物＋沒設定也可先記＋系統粗估值
  assert.ok(j.includes('預設食物') && j.includes('沒設定也可以先記') && j.includes('粗估值'), '應含想更準說明');
  assert.ok(!j.includes('水 60'), '不留舊 lead「水 60」');
});

test('安心上手（onboardingCarousel）：第一筆示範改為口語', () => {
  const j = J(onboardingCarousel('蚵仔'));
  for (const ex of ['乾乾5', '喝水30', '嘔吐 白沫']) assert.ok(j.includes(ex), `應含「${ex}」`);
  assert.ok(!j.includes('罐頭 30') && !j.includes('水 20'), '不留舊 step 例句');
});

test('無殘留「3 個小問題／共 3 步」等舊 onboarding 框架', () => {
  for (const j of [J(quickRecordCarousel({})), J(exampleCard()), J(recordTutorialFlex()), J(onboardingCarousel(''))]) {
    assert.ok(!j.includes('3 個小問題') && !j.includes('共 3 步'), '不得殘留多步精靈框架');
  }
});

test('所有教學例句都能被 parser 正確解析（不放尚未支援的說法）', () => {
  const cases = [
    ['主食3', 'record'], ['副食5', 'record'], ['乾乾10', 'record'], ['罐罐20', 'record'], ['零食3', 'record'],
    ['喝水30', 'record'], ['嘔吐 白沫', 'record'], ['乾乾5', 'record'],
    ['乾乾減5', 'foodAdjust'], ['罐罐剩10', 'foodAdjust'], ['主食改成20', 'record'],
    ['今天吃多少', 'query'], ['今天喝多少', 'query'], ['最近吃什麼', 'query'], ['之前吃過哪些罐頭', 'query'],
    ['希爾斯10', 'item_lookup_candidate']
  ];
  for (const [text, type] of cases) {
    assert.equal(parseMessage(text).type, type, `「${text}」應解析為 ${type}`);
  }
});
