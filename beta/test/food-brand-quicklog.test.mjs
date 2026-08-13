// 已知品牌快速記錄（§5、§6、§10）與安全邊界（§20）。
//  - 品牌／品項與數字之間 0～任意空白都等價（normalizeText 已處理，不需逐種空白寫 regex）。
//  - 已知品牌＋數字 → 沿用既有 foodId／foodType／kcalPerGram、amount=數字、不建新品項、不問類型。
//  - 只有品牌名沒有數字 → 問份量（handleBrandOnly），不硬記 0g；多個同名 → 先選品項。
//  - 安全邊界：今天35／吃35／體重35／藥35／35／主3／副3 不得被當成新品牌食物直接記錄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, matchFood } from '../src/parser.js';
import { deriveFoodFields } from '../src/summary.js';
import { handleBrandOnly, exactFoodMatches } from '../src/index.js';
import { createPet, createFoodItem } from '../src/db.js';

// ───────────────────────── 純解析／匹配層（§5、§6）─────────────────────────

test('§5 品牌＋數字：0～任意空白全部等價（巔峰羊35 == 巔峰羊 35 == 巔峰羊   35）', () => {
  const base = JSON.stringify(parseMessage('巔峰羊35'));
  for (const v of ['巔峰羊 35', '巔峰羊   35']) {
    assert.equal(JSON.stringify(parseMessage(v)), base, `「${v}」應與「巔峰羊35」等價`);
  }
  const r = parseMessage('巔峰羊35');
  assert.equal(r.type, 'item_lookup_candidate');
  assert.equal(r.itemName, '巔峰羊');
  assert.equal(r.amount, 35);
});

test('§6 已知品牌命中：沿用既有 foodType／kcalPerGram，數字＝克數（不建新品項、不問類型）', () => {
  const foods = [
    { foodId: 'f-peak', ownerLineUserId: 'u1', displayName: '巔峰羊', brand: '', productName: '', foodType: '主食罐', kcalPerGram: 1.2, waterRatio: 0.78, isDeleted: 0 }
  ];
  // 三種空白版本解析出的 itemName 都是「巔峰羊」，都精確命中同一個 foodId
  for (const v of ['巔峰羊35', '巔峰羊 35', '巔峰羊   35']) {
    const cand = parseMessage(v);
    const hit = exactFoodMatches(foods, cand.itemName);
    assert.equal(hit.length, 1, `「${v}」應唯一命中`);
    assert.equal(hit[0].foodId, 'f-peak');
    assert.equal(hit[0].foodType, '主食罐', '沿用既有類型，不改成別的');
    const derived = deriveFoodFields(cand.amount, hit[0].foodType, hit[0]);
    assert.equal(cand.amount, 35);
    assert.equal(derived.kcal, 42, '35g × 1.2 = 42 kcal（用品牌熱量）');
    assert.equal(derived.estimated, false, '品牌自訂 → 精準、非估算');
  }
  // matchFood 也回同一品項（handleRecord 走這條）
  assert.equal(matchFood(foods, '巔峰羊', '主食罐')?.foodId, 'f-peak');
});

// ───────────────────────── handleBrandOnly（§10）with DB ─────────────────────────

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });
function capture() {
  const texts = [];
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => { if (m.text) texts.push(m.text); }); } catch {}
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return texts;
}
function logCount(db) { return db.prepare("SELECT COUNT(*) AS n FROM logs WHERE category='food'").bind().first().n; }

async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}

test('§10 只有品牌名（唯一命中）→ 問份量、不記成 0g', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '主食罐', kcalPerGram: 1.2 });
  const texts = capture();
  const handled = await handleBrandOnly({ DB: db }, mkEvent(), db, pet, 'u1', '巔峰羊');
  assert.equal(handled, true, '應接手（問份量）');
  assert.ok(texts.join('').includes('這次吃了多少'), `應問份量，實得：${texts.join(' | ')}`);
  assert.equal(logCount(db), 0, '只問份量、不得先記成一筆 0g');
});

test('§10 只有品牌名（多個同名候選）→ 先問是哪一個，不亂猜', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '主食罐', kcalPerGram: 1.2 });
  await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '乾糧', kcalPerGram: 3.8 });
  const texts = capture();
  const handled = await handleBrandOnly({ DB: db }, mkEvent(), db, pet, 'u1', '巔峰羊');
  assert.equal(handled, true);
  assert.ok(texts.join('').includes('你是指哪一個'), `多候選應先問，實得：${texts.join(' | ')}`);
  assert.equal(logCount(db), 0);
});

test('§10/§20 安全邊界：非品牌名或帶數字 → handleBrandOnly 不接手（交回 unknown 引導）', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '主食罐', kcalPerGram: 1.2 });
  capture();
  for (const x of ['今天', '巔峰羊35', '隨便打的字', '藥']) {
    assert.equal(await handleBrandOnly({ DB: db }, mkEvent(), db, pet, 'u1', x), false, `「${x}」不該被當純品牌名接手`);
  }
});

// ───────────────────────── 安全邊界負向（§20、§23-H）─────────────────────────

test('§20 負向：今天35／吃35／體重35／藥35／35／主3／副3 不得被當成新品牌「食物紀錄」', () => {
  // 這些都不能解析成 category=food 的 record（也就是不會憑空建立一筆錯的食物紀錄）
  const notFoodRecord = (x) => {
    const r = parseMessage(x);
    return !(r.type === 'record' && r.record?.category === 'food');
  };
  for (const x of ['今天35', '吃35', '35', '主3', '副3']) {
    assert.ok(notFoodRecord(x), `「${x}」不得成為食物 record，實得 ${JSON.stringify(parseMessage(x))}`);
  }
  // 體重/藥有各自正確語意（不是食物、也不是品牌）
  assert.equal(parseMessage('體重35').record?.category, 'weight');
  assert.equal(parseMessage('藥35').record?.category, 'med');
});
