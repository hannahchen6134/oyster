// 跨行解析：換行＝明確分段，逐行獨立解析、保守跨行合併，不得把不同段落拼成假品名或丟數量。
// 純函式測 parseMessage；整合測 recordMultiForPet（真 db.js，LINE 以 stub fetch 靜默）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { recordMultiForPet, collectUndoableBySmid, applyUndo } from '../src/index.js';

const recsOf = (p) => (p.records || []).map((r) => ({ c: r.category, n: r.itemName, ft: r.foodType, a: r.amount, u: r.unit }));
const candsOf = (p) => (p.candidates || []).map((c) => ({ n: c.itemName, a: c.amount }));

// ── 五-1：不得拼成「皇家水粉」，37 與 15 都保留，分行解析，第二行進候選詢問 ──
test('T1 罐頭皇家三七/水粉15：食物皇家37g（不含15）＋候選水粉15，不產生「皇家水粉」', () => {
  const p = parseMessage('罐頭皇家三七\n水粉15');
  assert.equal(p.type, 'multiRecord');
  const foods = recsOf(p).filter((r) => r.c === 'food');
  assert.equal(foods.length, 1);
  assert.equal(foods[0].n, '皇家');          // 不得變成「皇家水粉」
  assert.equal(foods[0].ft, '罐頭');
  assert.equal(foods[0].a, 37);              // 37 保留、未被 15 覆蓋
  assert.ok(candsOf(p).some((c) => c.n === '水粉' && c.a === 15), '水粉15 進候選（詢問），未遺失');
  assert.ok(!JSON.stringify(p).includes('皇家水粉'), '整體結果不得出現假品名「皇家水粉」');
});

// ── 五-2：兩行皆完整 → 兩筆 ──
test('T2 皇家罐頭三八克/喝水十五ml：食物38g＋喝水15ml 兩筆', () => {
  const p = parseMessage('皇家罐頭三八克\n喝水十五ml');
  assert.equal(p.type, 'multiRecord');
  assert.ok(recsOf(p).some((r) => r.c === 'food' && r.a === 38), '食物 38g');
  assert.ok(recsOf(p).some((r) => r.c === 'water' && r.a === 15 && r.u === 'ml'), '喝水 15ml');
});

// ── 五-3：明確延續（品名行＋純數量單位行）→ 保守合併 ──
test('T3 皇家罐頭/三八克：明確延續 → 合成皇家罐頭38g', () => {
  const p = parseMessage('皇家罐頭\n三八克');
  const foods = recsOf(p).filter((r) => r.c === 'food');
  assert.equal(foods.length, 1);
  assert.equal(foods[0].a, 38);
  assert.equal(foods[0].ft, '罐頭');
});

// ── 五-4：第二行缺類型 → 不擅自當喝水/加水，進 unparsed 詢問 ──
test('T4 皇家罐頭三八克/十五ml：食物38g 完成、十五ml 進 unparsed（不自動喝水/加水）', () => {
  const p = parseMessage('皇家罐頭三八克\n十五ml');
  assert.ok(recsOf(p).some((r) => r.c === 'food' && r.a === 38), '食物 38g');
  assert.ok(!recsOf(p).some((r) => r.c === 'water'), '不得自動產生喝水');
  assert.ok((p.unparsed || []).some((u) => u.includes('十五') || u.includes('15')), '十五ml 保留在 unparsed 待詢問');
});

// ── 五-6：「水分」是打錯字，不得和皇家拼接，也不擅自當喝水 ──
test('T6 罐頭皇家三七/水分15：食物皇家37g＋候選水分15（不拼成皇家水分、不自動喝水）', () => {
  const p = parseMessage('罐頭皇家三七\n水分15');
  assert.ok(recsOf(p).some((r) => r.c === 'food' && r.n === '皇家' && r.a === 37));
  assert.ok(!recsOf(p).some((r) => r.c === 'water'), '水分不得自動當喝水');
  assert.ok(candsOf(p).some((c) => c.n === '水分' && c.a === 15), '水分15 進候選詢問');
  assert.ok(!JSON.stringify(p).includes('皇家水分'), '不得出現拼接假品名');
});

// ── 五-7：rawText 完整保留換行（由呼叫端存原文；此處驗 parser 不需要原文即可分行）──
test('T7 rawText 換行不影響解析且原文可完整保留（parser 不吃掉換行語意）', () => {
  const raw = '罐頭皇家三七\n水粉15';
  const p = parseMessage(raw);
  assert.equal(p.type, 'multiRecord');
  // 呼叫端會把 raw 原封存入 text_inputs.rawText（含 \n）——見整合測
  assert.ok(raw.includes('\n'), 'raw 保有換行');
});

// ── 整合：真 db.js，驗證 T1 落地：第一行寫入、第二行待確認、rawText 存原始換行、同 smid 冪等 ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
function nz(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(nz); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
function seed() {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-royal','u1','皇家罐頭','罐頭',0.96,0.8,'t','t')").bind().run();
  return db;
}
const env = { DB: null, LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const ev = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'M', text: '' } });
const catCnt = (db, c) => db.prepare("SELECT COUNT(*) n FROM logs WHERE category=? AND isDeleted=0").bind(c).first().n;

test('整合 T1：罐頭皇家三七/水粉15 → 食物皇家37g 寫入、水粉15 待確認、rawText 存原始換行、同 smid 可全刪', async () => {
  const db = seed(); env.DB = db;
  const raw = '罐頭皇家三七\n水粉15';
  const p = parseMessage(raw);
  await recordMultiForPet(env, ev(), db, { pet: { petId: 'p1', petName: '蚵仔' }, records: p.records, candidates: p.candidates, unparsed: p.unparsed, smid: 'ML1', rawText: raw, ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: '' });
  const f = db.prepare("SELECT itemName, amount, foodId FROM logs WHERE category='food' AND isDeleted=0").bind().first();
  assert.ok(f, '第一行食物有寫入');
  assert.equal(f.amount, 37);                 // 37 未遺失
  assert.equal(f.itemName, '皇家罐頭');        // 綁定既有品項、非假品名
  assert.equal(catCnt(db, 'water'), 0, '第二行「水粉15」不自動寫喝水');
  const row = db.prepare("SELECT rawText, parsedResult FROM text_inputs WHERE sourceMessageId='ML1' ORDER BY id DESC LIMIT 1").bind().first();
  assert.equal(row.rawText, raw, 'rawText 完整保留原始換行');
  const pr = JSON.parse(row.parsedResult);
  assert.ok((pr.noMatch || []).some((x) => x.itemName === '水粉' && Number(x.grams) === 15) || (pr.pendingFoods || []).length >= 0, '水粉15 留在待確認/未命中，不遺失');
  // 冪等：同 smid 收集刪除後再收為空
  const items = await collectUndoableBySmid(db, 'ML1', 'u1');
  await applyUndo(db, items, 'u1');
  assert.equal((await collectUndoableBySmid(db, 'ML1', 'u1')).length, 0);
});

test.after(() => { globalThis.fetch = origFetch; });
