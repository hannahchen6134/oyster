// 照護站「家裡習慣的叫法」API（/api/food-aliases，owner scope、只存 app_kv）。
//  - GET 列出；POST 新增/覆蓋（foodType 或 foodItem，server 端驗證）；DELETE 移除。
//  - 保留詞／帶數字不得建立；foodItem 必須屬本家庭；跨家庭 petId/foodId 一律拒絕。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleApi } from '../src/api.js';
import { createFoodItem, createSession, getFoodAlias } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8') + '\n' + readFileSync(join(ROOT, 'migrations', '0012_app_kv.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

async function setup() {
  const db = new D1();
  db.prepare("INSERT INTO users (lineUserId, createdAt, updatedAt) VALUES ('u1','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const token = await createSession(db, 'u1');
  return { db, token };
}
async function apiCall(db, token, path, method = 'GET', body) {
  const url = `https://x/api/${path}`;
  const res = await handleApi(new Request(url, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), { DB: db }, new URL(url));
  return { status: res.status, json: await res.json() };
}

test('POST foodType alias → GET 列出；肉→罐頭', async () => {
  const { db, token } = await setup();
  const post = await apiCall(db, token, 'food-aliases', 'POST', { alias: '肉', targetType: 'foodType', value: '罐頭' });
  assert.equal(post.status, 200); assert.equal(post.json.ok, true);
  const list = await apiCall(db, token, 'food-aliases');
  assert.equal(list.json.rows.length, 1);
  assert.equal(list.json.rows[0].alias, '肉');
  assert.equal(list.json.rows[0].displayTarget, '罐頭');
  assert.equal(list.json.rows[0].valid, true);
});

test('POST foodItem alias（本家庭品項）→ 顯示品項名', async () => {
  const { db, token } = await setup();
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '罐頭', kcalPerGram: 1.5 });
  const post = await apiCall(db, token, 'food-aliases', 'POST', { alias: '小藍罐', targetType: 'foodItem', value: peak.foodId });
  assert.equal(post.status, 200);
  const list = await apiCall(db, token, 'food-aliases');
  const row = list.json.rows.find((r) => r.alias === '小藍罐');
  assert.equal(row.displayTarget, '巔峰羊'); assert.equal(row.valid, true);
});

test('保留詞／帶數字不得建立（今天／體重／肉5）', async () => {
  const { db, token } = await setup();
  for (const bad of ['今天', '體重', '喝水', '肉5']) {
    const r = await apiCall(db, token, 'food-aliases', 'POST', { alias: bad, targetType: 'foodType', value: '罐頭' });
    assert.equal(r.status, 400, `「${bad}」應被拒`);
  }
});

test('不支援的類型 / 缺 targetType 一律 400', async () => {
  const { db, token } = await setup();
  assert.equal((await apiCall(db, token, 'food-aliases', 'POST', { alias: '飯飯', targetType: 'foodType', value: '亂類型' })).status, 400);
  assert.equal((await apiCall(db, token, 'food-aliases', 'POST', { alias: '飯飯', value: '罐頭' })).status, 400);
});

test('foodItem 跨家庭 foodId → 拒絕（403），不建立', async () => {
  const { db, token } = await setup();
  const other = await createFoodItem(db, 'u2', { displayName: '別家罐', foodType: '罐頭', kcalPerGram: 1.1 });
  const r = await apiCall(db, token, 'food-aliases', 'POST', { alias: '偷', targetType: 'foodItem', value: other.foodId });
  assert.equal(r.status, 403);
  assert.equal(await getFoodAlias(db, 'u1', '偷'), null, '不得寫入');
});

test('DELETE 移除叫法', async () => {
  const { db, token } = await setup();
  await apiCall(db, token, 'food-aliases', 'POST', { alias: '肉', targetType: 'foodType', value: '罐頭' });
  const del = await apiCall(db, token, `food-aliases?alias=${encodeURIComponent('肉')}`, 'DELETE');
  assert.equal(del.status, 200);
  assert.equal((await apiCall(db, token, 'food-aliases')).json.rows.length, 0);
});
