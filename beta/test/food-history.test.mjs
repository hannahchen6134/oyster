// 食物歷史口語查詢（§11-13）：
//  - parseFoodHistoryQuery：最近/這陣子=近30天、之前/以前=全歷史、最近N天=N、可選類型過濾。
//  - getFoodHistory：一律查「實際 logs 吃過」的品項，food_items 有設定但沒吃過的不得混進來；
//    有 foodId 時 JOIN 補 brand/displayName。
//  - buildFoodHistoryResult：依類型分組、空狀態、太多時導照護站。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, parseFoodHistoryQuery, analyzeLeading } from '../src/parser.js';
import { buildFoodHistoryResult } from '../src/index.js';
import { createPet, createFoodItem, insertLog, getFoodHistory } from '../src/db.js';
import { taipeiToday, addDays } from '../src/util.js';

// ───────────────────────── parser（§F 時間語意 + 類型）─────────────────────────

test('§F 時間語意：最近/這陣子=近30天、之前/以前=全歷史', () => {
  for (const x of ['最近吃什麼', '這陣子吃什麼', '這陣子都吃什麼']) {
    const r = parseMessage(x);
    assert.equal(r.query, 'foodHistory'); assert.equal(r.scope, 'recent'); assert.equal(r.sinceDays, 30);
  }
  for (const x of ['之前吃什麼', '之前吃過什麼', '以前吃什麼', '以前吃過什麼']) {
    const r = parseMessage(x);
    assert.equal(r.query, 'foodHistory'); assert.equal(r.scope, 'all'); assert.equal(r.sinceDays, null);
  }
});

test('§F 類型過濾與牌子、明確天數', () => {
  assert.deepEqual(pick(parseMessage('最近吃哪些罐頭')), { q: 'foodHistory', scope: 'recent', days: 30, ft: '罐頭' });
  assert.deepEqual(pick(parseMessage('以前吃過哪些乾糧')), { q: 'foodHistory', scope: 'all', days: null, ft: '乾糧' });
  assert.deepEqual(pick(parseMessage('最近吃哪些主食')), { q: 'foodHistory', scope: 'recent', days: 30, ft: '主食罐' });
  assert.deepEqual(pick(parseMessage('最近吃什麼牌子')), { q: 'foodHistory', scope: 'recent', days: 30, ft: '' });
  assert.equal(parseMessage('最近7天吃什麼').sinceDays, 7);
});

test('§F 貓名前綴（無空格）由 analyzeLeading 剝離→named，剩餘句仍解析為 foodHistory（蚵仔最近吃什麼→正確 pet）', () => {
  const lead = analyzeLeading('蚵仔最近吃什麼', ['蚵仔']);
  assert.equal(lead.kind, 'named', '應辨識貓名前綴並歸給該貓');
  assert.equal(lead.petName, '蚵仔');
  const r = parseMessage(lead.rest);
  assert.equal(r.query, 'foodHistory');
  assert.equal(r.scope, 'recent');
});

test('§F/§20 不誤觸：今天吃多少 / 純查詢詞 / 記錄 都不是 foodHistory', () => {
  assert.equal(parseFoodHistoryQuery('今天吃多少'), null);
  assert.equal(parseFoodHistoryQuery('近7天'), null);
  assert.equal(parseFoodHistoryQuery('罐頭30'), null);
  assert.notEqual(parseMessage('近7天').query, 'foodHistory'); // 仍是 week
});

// ───────────────────────── getFoodHistory（§G 資料來源）─────────────────────────

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

function pick(r) { return { q: r.query, scope: r.scope, days: r.sinceDays, ft: r.foodType }; }
async function addFood(db, pet, { itemName = '', foodType, foodId = '', daysAgo = 0 }) {
  const when = `${addDays(taipeiToday(), -daysAgo)} 09:00`;
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName, foodId, amount: 20, unit: 'g', kcal: 20, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊肉', foodType: '主食罐', kcalPerGram: 1.2 });
  // 從沒吃過的品項：設定了但不該出現在「吃過」清單
  await createFoodItem(db, 'u1', { displayName: '從沒吃過的乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  return { db, pet, peak };
}

test('§G 最近吃什麼：只列實際 logs 吃過的、排除 30 天前、排除從沒吃過的 food_item', async () => {
  const { db, pet, peak } = await seed();
  await addFood(db, pet, { foodId: peak.foodId, foodType: '主食罐', daysAgo: 1 });   // 近期，有 foodId
  await addFood(db, pet, { foodId: peak.foodId, foodType: '主食罐', daysAgo: 3 });   // 同品項再一次 → times=2
  await addFood(db, pet, { itemName: '希爾斯', foodType: '乾糧', daysAgo: 5 });        // 近期，無 foodId
  await addFood(db, pet, { itemName: '舊罐頭', foodType: '罐頭', daysAgo: 40 });        // 40 天前 → 不在近30天

  const recent = await getFoodHistory(db, pet.petId, { sinceDays: 30 });
  const names = recent.map((r) => r.name);
  assert.ok(names.includes('巔峰羊肉'), '有 foodId → 補品項 displayName');
  assert.ok(names.includes('希爾斯'), '無 foodId → 用 itemName');
  assert.ok(!names.includes('舊罐頭'), '40 天前不列入近 30 天');
  assert.ok(!names.includes('從沒吃過的乾糧'), 'food_items 有設定但沒吃過 → 不得冒進最近清單');
  const peakRow = recent.find((r) => r.name === '巔峰羊肉');
  assert.equal(peakRow.times, 2, '同品項吃兩次 → 聚合成一列、times=2');
  assert.equal(peakRow.foodType, '主食罐');
});

test('§G 之前（全歷史）含 40 天前那筆；類型過濾只回該類型', async () => {
  const { db, pet, peak } = await seed();
  await addFood(db, pet, { foodId: peak.foodId, foodType: '主食罐', daysAgo: 1 });
  await addFood(db, pet, { itemName: '舊罐頭', foodType: '罐頭', daysAgo: 40 });

  const all = await getFoodHistory(db, pet.petId, { sinceDays: null });
  assert.ok(all.map((r) => r.name).includes('舊罐頭'), '全歷史應含 40 天前');

  const onlyCan = await getFoodHistory(db, pet.petId, { sinceDays: null, foodType: '罐頭' });
  assert.equal(onlyCan.length, 1);
  assert.equal(onlyCan[0].name, '舊罐頭');
  assert.equal(onlyCan[0].foodType, '罐頭');
});

// ───────────────────────── buildFoodHistoryResult（§13 回覆）─────────────────────────

test('§13 回覆：依類型分組、標時間範圍；空狀態給生活化提示', () => {
  const rows = [
    { foodType: '主食罐', name: '巔峰羊肉', times: 2 },
    { foodType: '主食罐', name: 'XX 雞肉', times: 1 },
    { foodType: '乾糧', name: '希爾斯', times: 1 }
  ];
  const out = buildFoodHistoryResult(rows, { scope: 'recent', sinceDays: 30, petName: '蚵仔' });
  assert.ok(out.includes('蚵仔 最近 30 天吃過'));
  assert.ok(out.includes('主食罐') && out.includes('・巔峰羊肉（2 次）') && out.includes('・XX 雞肉'));
  assert.ok(out.includes('乾糧') && out.includes('・希爾斯'));

  const empty = buildFoodHistoryResult([], { scope: 'all' });
  assert.ok(empty.includes('以前') && empty.includes('還沒有吃東西的紀錄'));
});
