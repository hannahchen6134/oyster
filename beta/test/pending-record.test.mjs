// 多貓家庭：紀錄已可解析、只缺「哪隻貓」時，暫存這筆（pendrec），使用者回貓名後用既有 handleRecord 完成，
// 不再要求重打。端到端驅動真實 handleTextMessage（真 DB、stub LINE fetch）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleTextMessage } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// schema.sql 已含 pendingAction；betaAccess 由 0010 migration 加（isBetaAllowed 需要）。
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8') + '\n' + readFileSync(join(ROOT, 'migrations', '0010_beta_access.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
test.after(() => { globalThis.fetch = origFetch; });

function seed({ cats = ['蚵仔', '麵線'], defaultPetId = '' } = {}) {
  const db = new D1();
  db.prepare("INSERT INTO users (lineUserId, betaAccess, defaultPetId, createdAt, updatedAt) VALUES ('u1',1,?,'t','t')").bind(defaultPetId).run();
  cats.forEach((name, i) => db.prepare('INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES (?,?,?,?,?)').bind(`p${i + 1}`, 'u1', name, 't', 't').run());
  return db;
}
const env = (db) => ({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'x' });
const ev = (id, text) => ({ replyToken: 'r', source: { type: 'user', userId: 'u1' }, message: { id, text } });
const send = (db, id, text) => handleTextMessage(ev(id, text), env(db), '');
const cnt = (db, cat) => db.prepare('SELECT COUNT(*) c FROM logs WHERE category=? AND isDeleted=0').bind(cat).first().c;
const pend = (db) => db.prepare("SELECT pendingAction p FROM users WHERE lineUserId='u1'").bind().first().p;
const def = (db) => db.prepare("SELECT defaultPetId d FROM users WHERE lineUserId='u1'").bind().first().d;
const foodLog = (db) => db.prepare("SELECT petId, foodType, amount, note FROM logs WHERE category='food' AND isDeleted=0").bind().first();

test('1 多貓＋主食30 → 蚵仔：暫存後只寫一次給蚵仔，pending 清除', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  assert.equal(cnt(db, 'food'), 0, '選貓前不寫入');
  assert.ok(pend(db).startsWith('pendrec:'), '暫存 pendrec');
  await send(db, 'm2', '蚵仔');
  assert.equal(cnt(db, 'food'), 1, '完成後只寫一次');
  const log = foodLog(db);
  assert.equal(log.petId, 'p1'); assert.equal(log.foodType, '主食罐'); assert.equal(log.amount, 30);
  assert.equal(pend(db), '', 'pending 已清除');
  assert.equal(def(db), 'p1', '完成後也設成 active pet');
});

test('2 多貓＋水3 → 蚵仔：正確寫入喝水', async () => {
  const db = seed();
  await send(db, 'm1', '水3');
  assert.ok(pend(db).startsWith('pendrec:'));
  await send(db, 'm2', '蚵仔');
  assert.equal(cnt(db, 'water'), 1);
  assert.equal(db.prepare("SELECT petId FROM logs WHERE category='water'").bind().first().petId, 'p1');
});

test('3 多貓＋嘔吐 白沫 → 蚵仔：保留詳細內容（note=白沫）', async () => {
  const db = seed();
  await send(db, 'm1', '嘔吐 白沫');
  await send(db, 'm2', '蚵仔');
  const v = db.prepare("SELECT petId, note FROM logs WHERE category='vomit' AND isDeleted=0").bind().first();
  assert.ok(v, '有寫入嘔吐');
  assert.equal(v.petId, 'p1');
  assert.ok(String(v.note).includes('白沫'), 'note 保留白沫');
});

test('4 其他類型（乾糧10／益生菌／吃藥／排便／排尿）pending 後都能完成', async () => {
  for (const [text, cat] of [['乾糧10', 'food'], ['益生菌', 'supplement'], ['吃藥', 'med'], ['排便', 'stool'], ['排尿', 'urine']]) {
    const db = seed();
    await send(db, 'a1', text);
    assert.ok(pend(db).startsWith('pendrec:'), `「${text}」先暫存`);
    await send(db, 'a2', '蚵仔');
    assert.equal(cnt(db, cat), 1, `「${text}」→ ${cat} 完成寫入`);
    assert.equal(pend(db), '', `「${text}」pending 清除`);
  }
});

test('5/12 完成後清除、不重複寫入：再打一次「蚵仔」不會又寫一筆', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  await send(db, 'm2', '蚵仔');
  assert.equal(cnt(db, 'food'), 1);
  await send(db, 'm3', '蚵仔');   // 沒有 pending 了 → 只是切換
  assert.equal(cnt(db, 'food'), 1, '不得重複寫入');
});

test('6 沒有 pending 時輸入「蚵仔」→ 維持原本「切換 active pet」', async () => {
  const db = seed();
  await send(db, 'm1', '蚵仔');
  assert.equal(cnt(db, 'food'), 0, '不寫任何紀錄');
  assert.equal(def(db), 'p1', '切成 active pet');
});

test('7 pending 時輸入不存在的貓名 → 不寫入、不猜 pet', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  await send(db, 'm2', '小花');   // 不是這家的貓
  assert.equal(cnt(db, 'food'), 0, '不得寫入');
  assert.equal(def(db), '', '不得亂設 active pet');
});

test('8 pending 過期 → 不自動補寫舊紀錄（回貓名只當切換）', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  // 把暫存時間改成 20 分鐘前（>15 分 TTL）
  const raw = pend(db); const obj = JSON.parse(raw.slice('pendrec:'.length)); obj.t = Date.now() - 20 * 60 * 1000;
  db.prepare("UPDATE users SET pendingAction=? WHERE lineUserId='u1'").bind(`pendrec:${JSON.stringify(obj)}`).run();
  await send(db, 'm2', '蚵仔');
  assert.equal(cnt(db, 'food'), 0, '過期不補寫');
  assert.equal(pend(db), '', 'pending 已清');
  assert.equal(def(db), 'p1', '過期回貓名 → 當一般切換');
});

test('9 pending 時收到無關文字（今天）→ 不誤寫，pending 清掉', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  await send(db, 'm2', '今天');   // 查詢，不是貓名
  assert.equal(cnt(db, 'food'), 0, '不得誤寫');
  assert.equal(pend(db), '', '無關文字後清掉舊 pending');
});

test('10 單貓家庭：主食30 直接寫入，不問也不 pending', async () => {
  const db = seed({ cats: ['蚵仔'] });
  await send(db, 'm1', '主食30');
  assert.equal(cnt(db, 'food'), 1);
  assert.equal(pend(db), '');
});

test('11 已有 active pet：主食30 直接記給該貓，不再問', async () => {
  const db = seed({ defaultPetId: 'p2' });
  await send(db, 'm1', '主食30');
  assert.equal(cnt(db, 'food'), 1, '直接寫入');
  assert.equal(foodLog(db).petId, 'p2', '記給目前 active pet');
  assert.equal(pend(db), '');
});

test('新的明確紀錄覆蓋舊 pending：主食30（等待）後打水3 → 舊丟棄、水3 變成新 pending', async () => {
  const db = seed();
  await send(db, 'm1', '主食30');
  await send(db, 'm2', '水3');     // 沒答貓名，改打新紀錄
  assert.equal(cnt(db, 'food'), 0, '舊主食30 不寫');
  assert.equal(cnt(db, 'water'), 0, '新水3 也還沒寫（仍缺貓）');
  assert.ok(pend(db).startsWith('pendrec:'), '水3 成為新的 pending');
  await send(db, 'm3', '蚵仔');
  assert.equal(cnt(db, 'water'), 1, '水3 完成');
  assert.equal(cnt(db, 'food'), 0, '主食30 已被丟棄、不誤寫');
});
