// 中文數字辨識 ＋ 品項錯字確認流程：把「數字辨識」與「品項名稱不確定」分開。
// 純函式測 normalizeText/parseAmountToken/parseMessage；整合測 recordMultiForPet（真 db.js，LINE 以 stub fetch 靜默）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeText, parseAmountToken, parseMessage } from '../src/parser.js';
import { recordMultiForPet, collectUndoableBySmid, applyUndo } from '../src/index.js';

// ── 一、中文/阿拉伯數字正規化（數量辨識，與品項無關）──
// 取正規化後第一個可解析成量的 token（38 克 / 15 ml / 3.5 克…）
function amountOf(raw) {
  const toks = normalizeText(raw).split(' ');
  for (let i = 0; i < toks.length; i += 1) {
    const p = parseAmountToken(toks.slice(i).join('')) || parseAmountToken(toks[i]);
    if (p && p.value > 0) return p;
  }
  return null;
}
const NUM = [
  ['三八克', 38, 'g'], ['三十八克', 38, 'g'], ['38克', 38, 'g'], ['３８克', 38, 'g'],
  ['一五ml', 15, 'ml'], ['十五毫升', 15, 'ml'], ['三點五克', 3.5, 'g'], ['零點五克', 0.5, 'g'],
  ['3點5克', 3.5, 'g'], ['一二三克', 123, 'g'], ['零五克', 5, 'g'], ['一百二十ml', 120, 'ml'],
  ['兩百ml', 200, 'ml'], ['三點五公克', 3.5, 'g'], ['十五cc', 15, 'ml']
];
for (const [raw, val, unit] of NUM) {
  test(`中文/阿拉伯數字：「${raw}」→ ${val}${unit}`, () => {
    const a = amountOf(raw);
    assert.ok(a, `「${raw}」應解析出數量`);
    assert.equal(a.value, val);
    assert.equal(a.unit, unit);
  });
}

test('數字後有明確單位時，中文數字不可失敗：皇家罐頭三八克 → 皇家 38g 罐頭（可綁品項）', () => {
  const p = parseMessage('皇家罐頭三八克');
  assert.equal(p.type, 'record');
  assert.equal(p.record.category, 'food');
  assert.equal(p.record.foodType, '罐頭');
  assert.equal(p.record.amount, 38);
  assert.equal(p.record.unit, 'g');
});

test('喝水中文數字：喝水一五ml → 15ml、喝水十五毫升 → 15ml', () => {
  for (const s of ['喝水一五ml', '喝水十五毫升']) {
    const p = parseMessage(s);
    const r = p.type === 'record' ? p.record : (p.records || [])[0];
    assert.equal(r.category, 'water');
    assert.equal(r.amount, 15);
    assert.equal(r.unit, 'ml');
  }
});

// ── 二、品項錯字：數量辨識成功，但品項對不到 → 候選（不當新品項）──
test('品項錯字「皇家水粉三八克」：辨識為候選 itemName=皇家水粉、amount=38、unit=g（數字不遺失、不併入品名）', () => {
  const p = parseMessage('皇家水粉三八克');
  assert.equal(p.type, 'item_lookup_candidate');
  assert.equal(p.itemName, '皇家水粉');    // 「三八」不得併入品名
  assert.equal(p.amount, 38);
  assert.equal(p.unit, 'g');
});

// ── 三、多數字對應不明：不猜（水明確者記，食物候選另問，不憑空造食物紀錄）──
test('多數字對應不明「皇家三八水十五」：水15 明確、皇家38 當候選詢問，不臆測成食物紀錄', () => {
  const p = parseMessage('皇家三八水十五');
  assert.equal(p.type, 'multiRecord');
  assert.ok(p.records.some((r) => r.category === 'water' && r.amount === 15), '水 15 明確辨識');
  assert.ok(!p.records.some((r) => r.category === 'food'), '不得直接產生食物紀錄');
  assert.ok((p.candidates || []).some((c) => c.itemName === '皇家' && c.amount === 38), '皇家 38 進候選待確認');
});

// ── 整合：真 db.js（LINE stub），驗證品項錯字流程的資料寫入 ──
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
const foodCnt = (db) => db.prepare("SELECT COUNT(*) c FROM logs WHERE category='food' AND isDeleted=0").bind().first().c;
const itemCnt = (db) => db.prepare("SELECT COUNT(*) c FROM food_items WHERE isDeleted=0").bind().first().c;
const toCand = (p) => (p.type === 'item_lookup_candidate' ? [{ itemName: p.itemName, amount: p.amount, addedWaterMl: p.addedWaterMl || 0 }] : []);

// 案 8/10：中文數字＋既有品項 → 綁定既有 food item、用其熱量公式、amount=38
test('整合：罐頭皇家三八克（家裡有皇家罐頭）→ 綁定既有品項、用其熱量公式、38g，不新增品項', async () => {
  const db = seed(); env.DB = db;
  const p = parseMessage('罐頭皇家三八克'); // 帶類型詞 → food record（itemName 皇家、罐頭、38g）
  const records = p.type === 'multiRecord' ? p.records : [p.record];
  await recordMultiForPet(env, ev(), db, { pet: { petId: 'p1', petName: '蚵仔' }, records, candidates: [], unparsed: [], smid: 'MA', rawText: '罐頭皇家三八克', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: '' });
  const f = db.prepare("SELECT itemName, amount, foodType, kcal, foodId FROM logs WHERE category='food'").bind().first();
  assert.ok(f, '有寫入食物');
  assert.equal(f.amount, 38);
  assert.equal(f.itemName, '皇家罐頭');    // 綁定既有品項顯示名
  assert.equal(f.foodId, 'f-royal');
  assert.ok(f.kcal > 0, '用該品項熱量公式（非 0）');
  assert.equal(itemCnt(db), 1, '不新增品項');
});

// 案 9/11/12：品項錯字皇家水粉 → 詢問、不自動新增品項、不遺失 38g，rawText 保留中文數字原文
test('整合：皇家水粉三八克 → 不寫食物 log、不自動新增品項、38g 進待確認，rawText 保留「皇家水粉三八克」', async () => {
  const db = seed(); env.DB = db;
  const p = parseMessage('皇家水粉三八克');
  await recordMultiForPet(env, ev(), db, { pet: { petId: 'p1', petName: '蚵仔' }, records: [], candidates: toCand(p), unparsed: [], smid: 'MB', rawText: '皇家水粉三八克', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: '' });
  assert.equal(foodCnt(db), 0, '品項未確認前不寫食物 log');
  assert.equal(itemCnt(db), 1, '不自動新增「皇家水粉」為品項（仍只有皇家罐頭）');
  const row = db.prepare("SELECT rawText, parsedResult FROM text_inputs WHERE sourceMessageId='MB' ORDER BY id DESC LIMIT 1").bind().first();
  assert.equal(row.rawText, '皇家水粉三八克', 'rawText 完整保留中文數字原文（未被覆寫成阿拉伯數字）');
  const pr = JSON.parse(row.parsedResult);
  const pend = (pr.pendingFoods || []).filter((x) => x.status === 'pending');
  const nm = pr.noMatch || [];
  const g = [...pend, ...nm].some((x) => Number(x.grams) === 38);
  assert.ok(g, '38g 保留在待確認/未命中，不遺失');
});

// 案 14：重複點擊確認（同一 smid 已寫入）→ 不重複寫入（沿用既有 smid 冪等）
test('整合：唯一命中已寫入後，重複用同 smid 收集刪除為冪等（不重複、可全刪）', async () => {
  const db = seed(); env.DB = db;
  const p = parseMessage('罐頭皇家三八克');
  const records = p.type === 'multiRecord' ? p.records : [p.record];
  await recordMultiForPet(env, ev(), db, { pet: { petId: 'p1', petName: '蚵仔' }, records, candidates: [], unparsed: [], smid: 'MC', rawText: '罐頭皇家三八克', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: '' });
  assert.equal(foodCnt(db), 1);
  const items1 = await collectUndoableBySmid(db, 'MC', 'u1');
  assert.equal(items1.length, 1);
  await applyUndo(db, items1, 'u1');
  const items2 = await collectUndoableBySmid(db, 'MC', 'u1'); // 已刪 → 再收為空（冪等）
  assert.equal(items2.length, 0);
  assert.equal(foodCnt(db), 0);
});

test.after(() => { globalThis.fetch = origFetch; });
