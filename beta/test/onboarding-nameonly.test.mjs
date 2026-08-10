// P0-1 護欄：新增貓咪只要名字就完成、立刻可記錄；不再用體重阻塞（第 2、3 隻同樣不阻塞）。
// 用真正的 db.js + recordMultiForPet（與線上同一套落地機制）驗「名字建立後立即可記錄」「未填體重仍可記錄」。
// 另加原始碼護欄：petname 待辦流程不得再強迫進 weight-onboard，須改叫 petAddedCard。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createPet, getPet } from '../src/db.js';
import { parseMessage } from '../src/parser.js';
import { recordMultiForPet } from '../src/index.js';

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

const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const env = { DB: null, LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });
const catOf = (db, cat) => db.prepare("SELECT COUNT(*) c FROM logs WHERE category=? AND isDeleted=0").bind(cat).first().c;
const recsOf = (text) => { const p = parseMessage(text); return p.type === 'multiRecord' ? p.records : (p.type === 'record' ? [p.record] : []); };

async function record(db, pet, text, smid) {
  const records = recsOf(text);
  await recordMultiForPet(env, mkEvent(), db, {
    pet, records, candidates: [], unparsed: [], smid, rawText: text, ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: ''
  });
}

test('只填名字建立的貓（無體重）→ 立刻可記錄水／吐（logs 落地、不被阻塞）', async () => {
  const db = new D1(); env.DB = db;
  const pet = await createPet(db, 'u1', { petName: '蚵仔' });
  const got = await getPet(db, pet.petId);
  assert.equal(got.petName, '蚵仔');
  assert.ok(got.weightKg === null || got.weightKg === undefined || got.weightKg === 0, '名字建立的貓沒有體重也 OK');
  await record(db, { petId: pet.petId, petName: '蚵仔' }, '水 60 吐了', 'M1');
  assert.equal(catOf(db, 'water'), 1, '未填體重仍可記喝水');
  assert.equal(catOf(db, 'vomit'), 1, '未填體重仍可記嘔吐');
});

test('未填體重也能記食物（食物記錄不依賴體重）', async () => {
  const db = new D1(); env.DB = db;
  const pet = await createPet(db, 'u1', { petName: '麵線' });
  await record(db, { petId: pet.petId, petName: '麵線' }, '罐頭 30', 'M2');
  assert.equal(catOf(db, 'food'), 1, '未填體重仍可記食物');
});

test('第二、第三隻貓也只要名字、同樣不被阻塞，全部可記錄', async () => {
  const db = new D1(); env.DB = db;
  const p1 = await createPet(db, 'u1', { petName: '蚵仔' });
  const p2 = await createPet(db, 'u1', { petName: '麵線' });
  const p3 = await createPet(db, 'u1', { petName: '辜董' });
  for (const [pet, tag] of [[p1, 'A'], [p2, 'B'], [p3, 'C']]) {
    const before = catOf(db, 'water');
    await record(db, { petId: pet.petId, petName: pet.petName }, '水 50', `W${tag}`);
    assert.equal(catOf(db, 'water'), before + 1, `${pet.petName} 未填體重仍可記錄`);
  }
});

test('原始碼護欄：petname 待辦建立完貓後不得再強迫 weight-onboard，須改叫 petAddedCard', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.js'), 'utf8');
  // petname 待辦區塊：createPet 之後應是 clear() + petAddedCard，而非把 pendingAction 設為 weight-onboard
  const anchor = src.indexOf("if (pending === 'petname') {");
  assert.ok(anchor > 0, '找得到 petname 完成區塊');
  const block = src.slice(anchor, anchor + 700);
  assert.ok(block.includes('petAddedCard'), 'petname 完成後要用 petAddedCard');
  assert.ok(!/pendingAction:\s*'weight-onboard'/.test(block), 'petname 完成後不得強迫進 weight-onboard');
  // addPet 意圖（第 2 隻以後）同樣不得阻塞：完成後 pendingAction 清空 + petAddedCard
  const addBlock = src.slice(src.indexOf("case 'addPet'"), src.indexOf("case 'addPet'") + 700);
  assert.ok(addBlock.includes('petAddedCard'), 'addPet 完成後要用 petAddedCard');
  assert.ok(!/pendingAction:\s*'weight-onboard'/.test(addBlock), 'addPet 完成後不得強迫進 weight-onboard');
});
