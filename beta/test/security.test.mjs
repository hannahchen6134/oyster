// 資安強化測試（§資安）：登入碼／邀請碼改用加密級亂數、兌換端限流、金鑰定時比對。
// 用 node:sqlite 記憶體 DB 跑真正的 db.js（app_kv 需併入 0012 遷移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { randomDigits, randomFromAlphabet, constantTimeEqual } from '../src/util.js';
import { createLoginCode, createCareInvite, redeemLoginCode, redeemCareInvite, rateLimited } from '../src/db.js';
import worker from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8') + '\n'
  + readFileSync(join(ROOT, 'migrations', '0012_app_kv.sql'), 'utf8') + '\n'
  + readFileSync(join(ROOT, 'migrations', '0010_beta_access.sql'), 'utf8');

function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...args) { this.params = args.map(norm); return this; }
  run() { const info = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }; }
  first() { const row = this.sdb.prepare(this.sql).get(...this.params); return row ?? null; }
  all() { const rows = this.sdb.prepare(this.sql).all(...this.params); return { results: rows }; }
}
class D1 {
  constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); }
  prepare(sql) { return new Stmt(this.sdb, sql); }
}

// ---------- 加密級亂數 ----------
test('randomDigits：長度正確、只含 0-9，且跨多次呼叫具備變化（非常數）', () => {
  for (const n of [1, 4, 6, 10]) {
    const s = randomDigits(n);
    assert.equal(s.length, n, `長度應為 ${n}`);
    assert.ok(/^\d+$/.test(s), '只能是數字');
  }
  // 100 次取樣不應全部相同（Math.random 也會過此測，但可抓到「回傳常數」的退化）
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) seen.add(randomDigits(6));
  assert.ok(seen.size > 50, '6 位登入碼應有足夠亂度');
});

test('randomFromAlphabet：長度正確、每個字元都落在給定字母表內', () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 200; i += 1) {
    const s = randomFromAlphabet(6, alphabet);
    assert.equal(s.length, 6);
    for (const ch of s) assert.ok(alphabet.includes(ch), `字元 ${ch} 必須在字母表內`);
  }
});

// ---------- 定時比對 ----------
test('constantTimeEqual：相等為 true、任一處不同為 false、長度不同為 false、null 安全', () => {
  assert.equal(constantTimeEqual('abc123', 'abc123'), true);
  assert.equal(constantTimeEqual('abc123', 'abc124'), false);
  assert.equal(constantTimeEqual('abc123', 'abc12'), false);   // 長度不同
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, ''), true);              // null → '' 與 '' 相等
  assert.equal(constantTimeEqual(null, 'x'), false);
  assert.equal(constantTimeEqual(undefined, undefined), true);
});

// ---------- 限流 ----------
test('rateLimited：同一 scope 在窗內累計，超過上限才回 true（正常一次就過）', async () => {
  const db = new D1();
  // max=3：第 1~3 次應放行（false），第 4 次起擋（true）
  assert.equal(await rateLimited(db, 'unit:a', 3, 600), false);
  assert.equal(await rateLimited(db, 'unit:a', 3, 600), false);
  assert.equal(await rateLimited(db, 'unit:a', 3, 600), false);
  assert.equal(await rateLimited(db, 'unit:a', 3, 600), true);
  assert.equal(await rateLimited(db, 'unit:a', 3, 600), true);
  // 不同 scope 各自獨立，不受上一個影響
  assert.equal(await rateLimited(db, 'unit:b', 3, 600), false);
});

test('rateLimited：DB 壞掉不擋主流程（回 false，不丟例外）', async () => {
  const brokenDb = { prepare() { throw new Error('boom'); } };
  await assert.doesNotReject(async () => {
    const blocked = await rateLimited(brokenDb, 'unit:x', 1, 600);
    assert.equal(blocked, false, '限流本身故障時不應誤擋合法請求');
  });
});

// ---------- 登入碼 ----------
test('createLoginCode：產生 6 位數字碼、可被 redeem 取回原使用者、用一次即失效', async () => {
  const db = new D1();
  const code = await createLoginCode(db, 'U-login-1');
  assert.ok(/^\d{6}$/.test(code), `登入碼應為 6 位數字，實得 ${code}`);
  assert.equal(await redeemLoginCode(db, code), 'U-login-1');
  assert.equal(await redeemLoginCode(db, code), null, '第二次兌換應失效');
});

// ---------- 邀請碼 ----------
test('createCareInvite：產生 6 碼、無易混淆字元、可被兌換', async () => {
  const db = new D1();
  const code = await createCareInvite(db, 'U-owner');
  assert.equal(code.length, 6, '邀請碼維持 6 碼（parser 以 [A-Za-z0-9]{6} 比對）');
  assert.ok(/^[A-Za-z0-9]{6}$/.test(code), '邀請碼為 6 碼英數');
  for (const ch of code) assert.ok(!'IOL01'.includes(ch), `不應含易混淆字元：${ch}`);
  const result = await redeemCareInvite(db, code, 'U-member');
  assert.equal(result.ok, true, '合法成員可用邀請碼加入');
});

// ---------- 管理員驗證（金鑰不再掛在導覽網址、改用 cookie session；比對為定時比對）----------
const ADMIN_KEY = 'super-secret-admin-key';
function adminEnv() { return { DB: new D1(), ADMIN_KEY }; }
const ctx = { waitUntil() {} };

test('/admin/testers：沒帶金鑰也沒 cookie → 403', async () => {
  const res = await worker.fetch(new Request('https://x/admin/testers'), adminEnv(), ctx);
  assert.equal(res.status, 403);
});

test('/admin/testers：金鑰錯誤 → 403', async () => {
  const res = await worker.fetch(new Request('https://x/admin/testers?key=wrong'), adminEnv(), ctx);
  assert.equal(res.status, 403);
});

test('/admin/testers：金鑰正確 → 200，且順手換發 HttpOnly cookie（金鑰之後不必再掛網址）', async () => {
  const env = adminEnv();
  const res = await worker.fetch(new Request(`https://x/admin/testers?key=${ADMIN_KEY}`), env, ctx);
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie') || '';
  assert.ok(/(?:^|;\s*)adm=[A-Za-z0-9]+/.test(sc), '應發出 adm= cookie');
  assert.ok(/HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Strict/i.test(sc), 'cookie 應具 HttpOnly/Secure/SameSite');
  // 拿這張 cookie 再訪（不帶金鑰）也應通過
  const token = sc.match(/adm=([A-Za-z0-9]+)/)[1];
  const res2 = await worker.fetch(new Request('https://x/admin/testers', { headers: { cookie: `adm=${token}` } }), env, ctx);
  assert.equal(res2.status, 200, '有效 cookie 應可免金鑰進入');
});

test('/admin/testers：偽造 cookie（無對應 session）→ 403', async () => {
  const res = await worker.fetch(new Request('https://x/admin/testers', { headers: { cookie: 'adm=deadbeefdeadbeef' } }), adminEnv(), ctx);
  assert.equal(res.status, 403);
});

test('/admin/testers 產生的切換連結不含金鑰（不再把 ADMIN_KEY 洩漏到網址／瀏覽記錄）', async () => {
  const res = await worker.fetch(new Request(`https://x/admin/testers?key=${ADMIN_KEY}`), adminEnv(), ctx);
  const html = await res.text();
  assert.ok(!html.includes(ADMIN_KEY), 'HTML 內容不得含 ADMIN_KEY');
  assert.ok(!html.includes('?key='), '切換連結不得再帶 ?key=');
});

test('/admin/login：金鑰正確 → 302 導回名單並種 cookie；金鑰錯誤 → 403', async () => {
  const ok = await worker.fetch(new Request(`https://x/admin/login?key=${ADMIN_KEY}`), adminEnv(), ctx);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin/testers');
  assert.ok(/adm=[A-Za-z0-9]+/.test(ok.headers.get('set-cookie') || ''), '登入應種 cookie');
  const bad = await worker.fetch(new Request('https://x/admin/login?key=nope'), adminEnv(), ctx);
  assert.equal(bad.status, 403);
});

test('/admin/metrics 與 /admin/line-token：無授權一律 403（不可用測試者也有的邀請碼繞過）', async () => {
  assert.equal((await worker.fetch(new Request('https://x/admin/metrics'), adminEnv(), ctx)).status, 403);
  assert.equal((await worker.fetch(new Request('https://x/admin/line-token'), adminEnv(), ctx)).status, 403);
});

test('/api/login-code：同一 IP 短時間內狂試 → 429（暴力猜碼被限流擋下）', async () => {
  const env = adminEnv();
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' };
  const hit = () => worker.fetch(new Request('https://x/api/login-code', { method: 'POST', headers, body: JSON.stringify({ code: '000000' }) }), env, ctx);
  let got429 = false;
  for (let i = 0; i < 15; i += 1) {
    const r = await hit();
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, '連續嘗試應在上限後回 429');
});
