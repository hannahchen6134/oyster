// LINE 圖文選單 v8 路由：選單各格送出的字，必須對映到正確的既有查詢。
// 記一筆／近七天記錄／出摘要 ・ 管家後台(URI)／說明・怎麼記／照護月曆
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/parser.js';

test('近七天記錄 → week（沿用既有 7 天卡，不另做計算）', () => {
  assert.equal(parseMessage('近七天記錄').query, 'week');
  assert.equal(parseMessage('近7天').query, 'week', '舊詞仍相容');
});

test('照護月曆 → calendar（在對話看月曆，不開網站）', () => {
  assert.equal(parseMessage('照護月曆').query, 'calendar');
  assert.equal(parseMessage('月曆').query, 'calendar', '舊詞仍相容');
});

test('出摘要 → report（先選貓咪的入口）', () => {
  assert.equal(parseMessage('出摘要').query, 'report');
});

test('舊摘要指令統一進 LINE 選貓與出圖流程', () => {
  assert.equal(parseMessage('就醫摘要').query, 'report');
  assert.equal(parseMessage('就醫使用').query, 'report');
  assert.equal(parseMessage('照護摘要').query, 'report');
  assert.equal(parseMessage('照護使用').query, 'report');
});

test('給醫生看仍可用（出摘要取代它進選單，但舊詞不失效）', () => {
  assert.equal(parseMessage('給醫生看').query, 'report');
});
