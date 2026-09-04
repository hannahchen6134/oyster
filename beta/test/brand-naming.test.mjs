// Phase 1 收斂：品牌名「喵喵管家」、入口更名「管家後台」（指令相容舊詞「照護站」）、
// 以及「處理中…」載入動畫的非阻塞護欄。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BRAND } from '../src/brand.js';
import { parseMessage } from '../src/parser.js';
import { showLoadingAnimation } from '../src/line.js';

test('品牌名前台收斂為「喵喵管家」，且不再出現舊全名', () => {
  assert.equal(BRAND.name, '喵喵管家');
  assert.equal(BRAND.site, '管家後台');
  assert.ok(!BRAND.name.includes('照護安心'), '不應再是舊全名');
  assert.ok(!BRAND.beta.includes('喵喵照護安心管家'), 'Beta 聲明也收斂為喵喵管家');
});

test('入口更名：新詞「管家後台」可進網站頁；舊詞「照護站」仍相容（不失效）', () => {
  for (const w of ['管家後台', '開啟管家後台', '後台']) {
    assert.equal(parseMessage(w).query, 'website', `「${w}」應對映 website`);
  }
  // 向後相容：舊詞照舊可用，避免既有使用者習慣／舊連結失效
  for (const w of ['照護站', '網站', '開網站']) {
    assert.equal(parseMessage(w).query, 'website', `舊詞「${w}」仍應可用`);
  }
});

test('載入動畫：空 chatId 直接略過，不打任何 API', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  try {
    await showLoadingAnimation({ LINE_CHANNEL_ACCESS_TOKEN: 'x' }, '');
    assert.equal(called, false, '空 chatId 不應觸發 fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('載入動畫：API 失敗被吞掉（純視覺提示，絕不影響主流程回覆）', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network boom'); };
  try {
    await assert.doesNotReject(async () => {
      await showLoadingAnimation({ LINE_CHANNEL_ACCESS_TOKEN: 'x' }, 'Uxxxxxxxx');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
