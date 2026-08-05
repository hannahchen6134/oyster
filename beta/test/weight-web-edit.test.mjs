// 網站編輯體重（PUT /api/logs/:id）安全性：改 amount、保留原日期、resync 目前體重、
// 不新增第二筆、拒收空/0/負/非數字（伺服端防繞過）、刪除回退。食物/水編輯不受影響。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleApi } from '../src/api.js';
import { insertLog, getLog, getPet, createSession, resyncPetWeight } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
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
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, weightKg, createdAt, updatedAt) VALUES ('p1','u1','蚵仔',5.8,'t','t')").bind().run();
  const token = await createSession(db, 'u1');
  return { db, token };
}
const addWeight = (db, amount, dt) => insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: dt, category: 'weight', amount, unit: 'kg', recordedBy: 'u1', source: 'web', updatedBy: 'u1' });
const weightCount = (db) => db.prepare("SELECT COUNT(*) c FROM logs WHERE category='weight' AND isDeleted=0").bind().first().c;

async function putLog(db, token, logId, body) {
  const req = new Request(`https://x/api/logs/${logId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const res = await handleApi(req, { DB: db }, new URL(`https://x/api/logs/${logId}`));
  return { status: res.status, json: await res.json() };
}
async function delLog(db, token, logId) {
  const req = new Request(`https://x/api/logs/${logId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  const res = await handleApi(req, { DB: db }, new URL(`https://x/api/logs/${logId}`));
  return { status: res.status, json: await res.json() };
}

test('編輯體重 4.27→4.28：改原 log、保留原日期、不新增、pets.weightKg=4.28', async () => {
  const { db, token } = await setup();
  const w = await addWeight(db, 4.27, '2026-08-05 21:37');
  await resyncPetWeight(db, 'p1');
  const r = await putLog(db, token, w.logId, { petId: 'p1', category: 'weight', amount: 4.28, unit: 'kg', eventDateTime: '2026-08-05 21:37' });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  const after = await getLog(db, w.logId);
  assert.equal(after.amount, 4.28, '同筆改為 4.28');
  assert.equal(String(after.eventDateTime), '2026-08-05 21:37', '原日期時間保留');
  assert.equal(weightCount(db), 1, '不新增第二筆');
  assert.equal((await getPet(db, 'p1')).weightKg, 4.28, 'pets.weightKg 同步 4.28');
});

test('編輯較舊體重：pets.weightKg 仍取真正最新一筆，不被舊值蓋掉', async () => {
  const { db, token } = await setup();
  const older = await addWeight(db, 4.05, '2026-08-01 09:00');
  await addWeight(db, 5.10, '2026-08-04 09:00'); // 最新
  await resyncPetWeight(db, 'p1');
  await putLog(db, token, older.logId, { petId: 'p1', category: 'weight', amount: 4.20, unit: 'kg', eventDateTime: '2026-08-01 09:00' });
  assert.equal((await getPet(db, 'p1')).weightKg, 5.10, '目前體重仍為最新 5.10，不被舊紀錄蓋成 4.2');
});

test('伺服端拒收無效體重（空/0/負/非數字）→ 400 且不改動', async () => {
  const { db, token } = await setup();
  const w = await addWeight(db, 4.27, '2026-08-05 21:37');
  for (const bad of [0, -1, '', 'abc', null]) {
    const r = await putLog(db, token, w.logId, { petId: 'p1', category: 'weight', amount: bad, unit: 'kg', eventDateTime: '2026-08-05 21:37' });
    assert.equal(r.status, 400, `amount=${JSON.stringify(bad)} 應被拒`);
  }
  assert.equal((await getLog(db, w.logId)).amount, 4.27, '原值 4.27 未被清成 0 或改動');
});

test('刪除最新體重（web DELETE）→ pets.weightKg 回退上一筆', async () => {
  const { db, token } = await setup();
  await addWeight(db, 4.05, '2026-08-01 09:00');
  const latest = await addWeight(db, 5.10, '2026-08-04 09:00');
  await resyncPetWeight(db, 'p1');
  const r = await delLog(db, token, latest.logId);
  assert.equal(r.status, 200);
  assert.equal((await getPet(db, 'p1')).weightKg, 4.05, '回退到 4.05');
});

test('食物編輯不受影響：改克數仍正常（回歸保護）', async () => {
  const { db, token } = await setup();
  const f = await insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-05 12:00', category: 'food', foodType: '罐頭', amount: 30, unit: 'g', recordedBy: 'u1', source: 'web', updatedBy: 'u1' });
  const r = await putLog(db, token, f.logId, { petId: 'p1', category: 'food', foodType: '罐頭', amount: 45, unit: 'g', eventDateTime: '2026-08-05 12:00' });
  assert.equal(r.status, 200);
  assert.equal((await getLog(db, f.logId)).amount, 45, '食物克數改為 45');
});
