// 新手最短路徑文案（第一次加入 → 加貓 → 記下第一筆）：
//  - 第一則訊息：核心是「不用先設定，直接打字就能記」＋看得懂的例子，不是「先設定一堆」。
//  - 加貓後：立刻「現在就能用」＋可直接打的例句；次要入口叫「讓紀錄更準」，不叫「補完整資料」。
//  - unknown fallback：短、口語、給生活化例句，不丟一整份說明書。
//  - 所有出現的例句都真的能被 parser 解析（不放尚未支援的說法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage } from '../src/parser.js';
import { welcomeFlex } from '../src/flex.js';
import { petAddedCard, namePromptCard, guideUnknown } from '../src/index.js';

const json = (o) => JSON.stringify(o);

test('第一則歡迎訊息：主軸「不用先設定／照平常說話」＋三個例子＋直接記錄 CTA', () => {
  const w = json(welcomeFlex());
  assert.ok(/不用先設定|照平常說話/.test(w), '應強調不用先設定、照平常說話');
  for (const ex of ['乾乾5', '喝水30', '嘔吐 白沫']) assert.ok(w.includes(ex), `歡迎訊息應示範「${ex}」`);
  assert.ok(w.includes('記一筆'), '主 CTA 直接記錄');assert.ok(!w.includes('幫貓貓取名開始'));
  assert.ok(!w.includes('3 個小問題'), '不得再把建檔講成「3 個小問題」');
});

test('取名卡：不再是「第 1 步・共 3 步」，且說明其他資料可晚點補', () => {
  const n = json(namePromptCard());
  assert.ok(!/第 1 步|共 3 步/.test(n), '不得出現多步精靈框架');
  assert.ok(/晚點再補|之後/.test(n), '應讓人知道其他資料可之後再補');
});

test('加貓後：立刻可用＋可直接打的例句；次要入口叫「讓紀錄更準」、明說沒設定也能用', () => {
  const c = json(petAddedCard('蚵仔'));
  assert.ok(c.includes('現在就可以用') || c.includes('現在就可以開始'), '應讓人立刻感受可用');
  assert.ok(c.includes('乾乾5'), '應給可直接打的第一筆例句');
  assert.ok(c.includes('讓紀錄更準'), '次要入口用「讓紀錄更準」');
  assert.ok(!c.includes('補完整資料'), '不叫「補完整資料」（避免像還沒填完不能用）');
  assert.ok(/沒設定也能/.test(c), '明說沒設定也能用');
});

test('unknown fallback：短、口語、給生活化例句，不以「看不懂」冷回', async () => {
  const texts = [];
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => { if (m.text) texts.push(m.text); }); } catch {}
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  await guideUnknown({ DB: null }, { replyToken: 'r', source: { userId: 'u1' }, message: { id: 'X' } }, '');
  const t = texts.join('');
  assert.ok(!/看不懂/.test(t), '不以「看不懂」冷回');
  assert.ok(t.includes('乾乾5') && t.includes('最近吃什麼'), '應給生活化例句');
  assert.ok(/照平常/.test(t), '應點出照平常講話就好');
});

test('新手文案裡的每個例句都真的可解析（不放尚未支援的說法）', () => {
  const cases = [
    ['乾乾5', 'record'], ['喝水30', 'record'], ['嘔吐 白沫', 'record'],
    ['主食3', 'record'], ['罐罐20', 'record'],
    ['乾乾減5', 'foodAdjust'], ['罐罐剩10', 'foodAdjust'],
    ['最近吃什麼', 'query']
  ];
  for (const [text, type] of cases) {
    const r = parseMessage(text);
    assert.equal(r.type, type, `「${text}」應解析為 ${type}，實得 ${r.type}`);
  }
});
