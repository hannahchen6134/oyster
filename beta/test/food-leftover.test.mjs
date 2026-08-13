// 「foodType／口語別名 + 剩 + 數字」→ foodAdjust leftover（不是新增一筆）。
//  - 解析：罐罐剩10 / 乾乾剩5 / 主食剩3 … → mode=leftover、foodType 正確、amount 正確（空格彈性）。
//  - targeting：只改該貓、該 foodType、最近合理那一餐；唯一才直接改、多筆出確認卡、找不到不寫。
//  - leftover 語意：實吃＝原餵量−剩，保留 servedAmount／leftoverAmount。
//  - 預設品項不影響 leftover targeting（改的是實際那筆，不是預設品項）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { handleFoodAdjust } from '../src/index.js';
import { createPet, createFoodItem, insertLog, getLog, setDefaultFood } from '../src/db.js';

// ───────────────────────── 解析（§9）─────────────────────────

test('解析：<類型/別名>剩N → foodAdjust leftover，foodType/amount 正確', () => {
  const cases = [
    ['罐罐剩10', '罐頭', 10], ['罐頭剩10', '罐頭', 10],
    ['乾乾剩5', '乾糧', 5], ['乾糧 剩 5', '乾糧', 5],
    ['主食剩3', '主食罐', 3], ['主食罐 剩3', '主食罐', 3],
    ['副食剩2', '副食罐', 2], ['零食剩1', '零食', 1]
  ];
  for (const [text, ft, amt] of cases) {
    const r = parseMessage(text);
    assert.equal(r.type, 'foodAdjust', `「${text}」應為 foodAdjust`);
    assert.equal(r.mode, 'leftover', `「${text}」mode 應為 leftover`);
    assert.equal(r.foodType, ft, `「${text}」foodType`);
    assert.equal(r.amount, amt, `「${text}」amount`);
    assert.equal(r.confirm, false);
  }
});

test('解析：空格彈性完全等價（罐罐剩10 == 罐罐 剩10 == 罐罐 剩 10 == 罐罐   剩   10）', () => {
  const base = JSON.stringify(parseMessage('罐罐剩10'));
  for (const v of ['罐罐 剩10', '罐罐剩 10', '罐罐 剩 10', '罐罐   剩   10']) {
    assert.equal(JSON.stringify(parseMessage(v)), base, `「${v}」應與「罐罐剩10」等價`);
  }
});

test('負向：剩／剩abc／今天剩10／體重剩1／藥剩2／裸剩10 都不得成為 foodAdjust leftover', () => {
  for (const x of ['剩', '剩abc', '今天剩10', '體重剩1', '藥剩2']) {
    const r = parseMessage(x);
    assert.ok(!(r.type === 'foodAdjust' && r.mode === 'leftover'), `「${x}」不得誤當 leftover，實得 ${JSON.stringify(r)}`);
  }
  // 裸「剩10」維持既有 fixLast leftover（不受本次改動影響）
  const bare = parseMessage('剩10');
  assert.equal(bare.type, 'fixLast');
  assert.equal(bare.mode, 'leftover');
});

// ───────────────────────── integration ─────────────────────────

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

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });
function capture() {
  const texts = [];
  globalThis.fetch = async (url, opts) => { try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => { if (m.text) texts.push(m.text); }); } catch {} return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
  return texts;
}
async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}
async function addFood(db, pet, { itemName = '', foodType, foodId = '', amount, when }) {
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName, foodId, amount, unit: 'g', kcal: Math.round(amount * 0.9), recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
function foodCount(db) { return db.prepare("SELECT COUNT(*) AS n FROM logs WHERE category='food' AND isDeleted=0").bind().first().n; }
const leftoverIntent = (ft, amt) => ({ type: 'foodAdjust', foodType: ft, mode: 'leftover', amount: amt, confirm: false });

test('1) 罐頭40 + 乾糧10，罐罐剩10 → 改罐頭那筆(30/served40/leftover10)，乾糧不變，不新增', async () => {
  const { db, pet } = await seed();
  const can = await addFood(db, pet, { foodType: '罐頭', amount: 40, when: '2026-08-10 18:00' });
  const dry = await addFood(db, pet, { foodType: '乾糧', amount: 10, when: '2026-08-10 19:00' });
  const before = foodCount(db);
  await handleFoodAdjust({ DB: db }, mkEvent(), pet, leftoverIntent('罐頭', 10), 'u1');
  const gotCan = await getLog(db, can.logId);
  assert.equal(gotCan.amount, 30, '實吃＝原餵 40 − 剩 10');
  assert.equal(gotCan.servedAmount, 40, '保留原餵量');
  assert.equal(gotCan.leftoverAmount, 10, '保留剩餘量');
  assert.equal((await getLog(db, dry.logId)).amount, 10, '乾糧不受影響');
  assert.equal(foodCount(db), before, '不新增食物紀錄');
});

test('2) 同類型多筆合理候選 → 出確認卡、不直接猜、不寫入', async () => {
  const { db, pet } = await seed();
  const a = await addFood(db, pet, { foodType: '罐頭', amount: 40, when: '2026-08-10 08:00' });
  const b = await addFood(db, pet, { foodType: '罐頭', amount: 35, when: '2026-08-10 18:00' });
  const texts = capture();
  await handleFoodAdjust({ DB: db }, mkEvent(), pet, leftoverIntent('罐頭', 10), 'u1');
  assert.equal((await getLog(db, a.logId)).amount, 40, '多筆 → 不自動改');
  assert.equal((await getLog(db, b.logId)).amount, 35);
  assert.ok(texts.join('').includes('你要調整哪一筆'), `應出選餐卡，實得：${texts.join(' | ')}`);
});

test('3) 找不到該 foodType 的近期紀錄 → 不修改任何資料、提示找不到', async () => {
  const { db, pet } = await seed();
  const dry = await addFood(db, pet, { foodType: '乾糧', amount: 10, when: '2026-08-10 09:00' });
  const texts = capture();
  await handleFoodAdjust({ DB: db }, mkEvent(), pet, leftoverIntent('罐頭', 10), 'u1');
  assert.equal((await getLog(db, dry.logId)).amount, 10, '不誤改乾糧');
  assert.ok(texts.join('').includes('找不到可以調整的罐頭紀錄'));
});

test('4) 設定預設乾糧=希爾斯，但最近實際吃皇家 → 乾乾剩5 改的是皇家那筆，不受預設影響', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  // 最近實際吃的是皇家乾糧（帶其 itemName，foodId 綁皇家）
  const royalLog = await addFood(db, pet, { itemName: '皇家乾糧', foodType: '乾糧', amount: 20, when: '2026-08-10 09:00' });
  await handleFoodAdjust({ DB: db }, mkEvent(), pet, leftoverIntent('乾糧', 5), 'u1');
  const got = await getLog(db, royalLog.logId);
  assert.equal(got.amount, 15, '改的是實際皇家那筆：20 − 剩 5 = 15');
  assert.equal(got.servedAmount, 20);
  assert.equal(got.leftoverAmount, 5);
  assert.equal(got.itemName, '皇家乾糧', '仍是皇家，不因預設變成希爾斯');
});
