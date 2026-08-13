// LINE 基本指引更新（§15-19）：核心概念「不用學格式，照平常說話就好」，
// 主指引只放高價值自然語言例句；unknown fallback 也給生活化範例，不只說「看不懂」。
// 主教學不把有歧義的極簡「主食-3」當主案例（§17）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helpText, welcomeText, unknownReply, recordTutorial } from '../src/replies.js';

test('§16/§18 helpText 含新核心例句，且點出「照平常說話」概念', () => {
  const h = helpText();
  for (const ex of ['主食3', '乾乾10', '巔峰羊35', '乾乾減5', '最近吃什麼']) {
    assert.ok(h.includes(ex), `主指引應包含核心例句「${ex}」`);
  }
  assert.ok(/不用學格式|照平常/.test(h), '主指引應點出「不用學格式／照平常說話」');
});

test('§17 主指引不把有歧義的「主食-3」當主教學案例（但示範較安全的「乾乾減5」）', () => {
  const h = helpText();
  assert.ok(!h.includes('主食-3'), '主指引不得把 主食-3 當主案例');
  assert.ok(h.includes('乾乾減5') || h.includes('罐罐剩10'), '應優先示範明確的減/剩寫法');
});

test('§15 welcomeText 以自然語言為核心，含新例句', () => {
  const w = welcomeText();
  assert.ok(/不用背指令|照平常說話|不用學格式/.test(w), '歡迎訊息應強調自然語言');
  for (const ex of ['主食3', '巔峰羊35']) assert.ok(w.includes(ex), `歡迎訊息應含「${ex}」`);
  // 醫療免責與定期回診提醒不得被移除
  assert.ok(w.includes('獸醫') && w.includes('回診'));
});

test('§19 unknownReply 給生活化範例，不只說「看不懂」，並提示可看更多', () => {
  const u = unknownReply();
  assert.ok(!/^看不懂/.test(u), '不應以「看不懂」冷回開頭');
  assert.ok(u.includes('最近吃什麼') && (u.includes('主食3') || u.includes('喝水30')), '應給生活化範例');
  assert.ok(u.includes('說明'), '應提示可看更多說法');
});

test('§18 第二層教學涵蓋超口語吃飯／調整／查詢，且完整名稱仍在', () => {
  const t = recordTutorial();
  for (const ex of ['主食3', '乾乾10', '罐罐20', '零食3', '巔峰羊35', '乾乾減5', '主食扣3', '最近吃什麼']) {
    assert.ok(t.includes(ex), `第二層教學應含「${ex}」`);
  }
  // 帶品牌的精確寫法仍保留（進階）
  assert.ok(t.includes('罐頭 皇家 30') || t.includes('乾糧 希爾斯 20'));
});
