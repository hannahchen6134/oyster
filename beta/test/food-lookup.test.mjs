// Commit 1：食物類型/品項黏字與倒序（RC1）＋ 無類別詞反查 food_items ＋ multiRecord 局部確認的
// smid 合併／冪等／撤銷。parser 用真實 parseMessage；反查用 exactFoodMatches；smid 流程用 node:sqlite
// 跑真正的 db.js（insertLog/logTextInput/getLog/softDeleteLog/recomputeDay）＋ index.js 匯出的 helper。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { exactFoodMatches, smidPriorSavedIds, smidHasFoodLog, collectUndoableBySmid, applyUndo } from '../src/index.js';
import { insertLog, logTextInput } from '../src/db.js';

// ---------- part A：parser RC1 詞序/黏字 + 中性候選 ----------
function multi(s) { const r = parseMessage(s); assert.equal(r.type, 'multiRecord', `「${s}」應 multiRecord，實為 ${r.type}`); return r; }
const food = (r) => r.records.find((x) => x.category === 'food');
const water = (r) => r.records.find((x) => x.category === 'water');

test('RC1：罐頭皇家33 水8（含黏字／換行／逗號變體）→ 食物 罐頭/皇家/33 ＋ 水8，無殘留', () => {
  for (const s of ['罐頭皇家33 水8', '罐頭皇家33水8', '皇家罐頭33水8', '罐頭皇家33克，水8毫升']) {
    const r = multi(s);
    const f = food(r); const w = water(r);
    assert.ok(f && f.foodType === '罐頭' && f.itemName === '皇家' && f.amount === 33, `${s} 食物應 罐頭/皇家/33`);
    assert.ok(w && w.amount === 8, `${s} 水應 8`);
    assert.equal((r.unparsed || []).length, 0, `${s} 不應有未解析片段`);
  }
});

test('RC1：品牌對不到也要保留類型＋數量（罐頭未知品牌33 水8）→ 食物候選 未知品牌/33 ＋ 水8', () => {
  const r = multi('罐頭未知品牌33水8');
  const f = food(r);
  assert.ok(f && f.foodType === '罐頭' && f.itemName === '未知品牌' && f.amount === 33);
  assert.ok(water(r).amount === 8);
  assert.equal((r.unparsed || []).length, 0);
});

test('中性候選：皇家33（只有品名＋數量、無類別詞）→ item_lookup_candidate，不臆測類型', () => {
  const r = parseMessage('皇家33');
  assert.equal(r.type, 'item_lookup_candidate');
  assert.equal(r.itemName, '皇家');
  assert.equal(r.amount, 33);
  assert.equal(r.foodType, undefined); // parser 不臆測類型
});

test('安全：品名含「水」不得誤切出 water；黏著水事件保守放棄不誤記', () => {
  // 皇家水解蛋白33 水8：句尾「水8」是獨立水事件，品名裡的「水」不切
  const r1 = parseMessage('皇家水解蛋白33水8');
  assert.equal(r1.type, 'multiRecord');
  assert.ok(water(r1) && water(r1).amount === 8, '句尾水8應記');
  assert.ok((r1.unparsed || []).some((u) => u.includes('水解蛋白')), '品名段保留，不誤切成 water');
  assert.ok(!r1.records.some((x) => x.category === 'food'), 'Commit1：水解蛋白暫不誤記成食物（留 Commit2）');
  // 罐頭皇家水8：類別詞黏著、無法乾淨切出 → 保守不誤記
  assert.equal(parseMessage('罐頭皇家水8').type, 'unknown');
  // 水解蛋白罐頭33：Commit1 保守（含水的品名）→ 不誤記、不誤切 water
  const r3 = parseMessage('水解蛋白罐頭33');
  assert.notEqual(r3.type, 'multiRecord'); // 不會冒出獨立 water
});

// ---------- part B：exactFoodMatches 唯一/多筆/無 ----------
const FOODS = [
  { foodId: 'f-royal-can', displayName: '皇家罐頭', foodType: '罐頭', isDeleted: 0 },
  { foodId: 'f-royal-dry', displayName: '皇家乾糧', foodType: '乾糧', isDeleted: 0 },
  { foodId: 'f-hills-can', displayName: '希爾斯罐頭', foodType: '罐頭', isDeleted: 0 }
];

test('exactFoodMatches：皇家＝皇家罐頭（去類別詞後精確），唯一命中', () => {
  const m = exactFoodMatches([FOODS[0], FOODS[2]], '皇家');
  assert.equal(m.length, 1);
  assert.equal(m[0].foodId, 'f-royal-can');
});
test('exactFoodMatches：皇家有罐頭＋乾糧兩型 → 多筆命中（跨類型，不可自動記）', () => {
  assert.equal(exactFoodMatches(FOODS, '皇家').length, 2);
});
test('exactFoodMatches：未知品牌 → 無命中（模糊不算精確）', () => {
  assert.equal(exactFoodMatches(FOODS, '未知品牌').length, 0);
  assert.equal(exactFoodMatches(FOODS, '皇冠').length, 0); // 皇冠≈皇家 只是模糊，不得算精確
});

// ---------- part C：smid 合併／冪等／撤銷（罐頭未知品牌33 水8 的延後確認流程）----------
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
const U = () => crypto.randomUUID();
const foodCount = (db) => db.prepare("SELECT COUNT(*) c FROM logs WHERE category='food' AND isDeleted=0").bind().first().c;

test('延後確認：水先記→確認食物合併同 smid→撤銷撤兩筆→重複確認不重複建立', async () => {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const smid = 'MSG_ROYAL';

  // 第一次處理「罐頭未知品牌33 水8」：水 8 立即寫入；食物段（品牌對不到）pending，multi_partial 只存水
  const w = U();
  await insertLog(db, { logId: w, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 8, unit: 'ml', waterMl: 8, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'multi_partial', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: w, parsedResult: JSON.stringify({ events: [{ category: 'water', amount: 8 }, { category: 'food', foodType: '罐頭', itemName: '未知品牌', amount: 33 }], savedLogIds: [w], unparsedSegments: [], awaitingAction: 'food_selection' }) });

  assert.deepEqual(await smidPriorSavedIds(db, smid, 'u1'), [w], '確認前 savedLogIds 只有水');
  assert.equal(await smidHasFoodLog(db, smid, 'u1', { foodType: '罐頭', itemName: '未知品牌', grams: 33 }), false, '確認前尚無食物');
  assert.equal(foodCount(db), 0);

  // 使用者按「只記罐頭 33g」（recFoodRaw）：冪等檢查 false → 寫食物 → 合併 savedLogIds
  const f = U();
  await insertLog(db, { logId: f, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType: '罐頭', itemName: '未知品牌', amount: 33, unit: 'g', kcal: 30, waterMl: 26, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  const prior = await smidPriorSavedIds(db, smid, 'u1');
  const merged = [...new Set([...prior, f])];
  assert.deepEqual(merged, [w, f], '合併後 savedLogIds＝水＋食物（不覆蓋水）');
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: f, parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: '罐頭', itemName: '未知品牌', amount: 33 }], savedLogIds: merged, unparsedSegments: [], awaitingAction: '' }) });

  // 冪等：再點一次同樣的確認 → smidHasFoodLog 為 true（呼叫端會直接略過、不寫第二筆）
  assert.equal(await smidHasFoodLog(db, smid, 'u1', { foodType: '罐頭', itemName: '未知品牌', grams: 33 }), true);
  assert.equal(foodCount(db), 1, '冪等：食物仍只有一筆');

  // 撤銷：同一 smid 取得兩筆（水＋食物），撤銷後都軟刪
  const items = await collectUndoableBySmid(db, smid, 'u1');
  assert.equal(items.length, 2, 'collectUndoableBySmid 應取得水＋食物兩筆');
  await applyUndo(db, items, 'u1');
  assert.equal(db.prepare('SELECT isDeleted d FROM logs WHERE logId=?').bind(w).first().d, 1);
  assert.equal(db.prepare('SELECT isDeleted d FROM logs WHERE logId=?').bind(f).first().d, 1);
  assert.equal((await collectUndoableBySmid(db, smid, 'u1')).length, 0, '撤銷後不再有可撤銷筆（冪等）');
});

test('冪等（recFoodG foodId 路徑）：同 smid 同 foodId+克數只算一次', async () => {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const smid = 'MSG_FID';
  const f = U();
  await insertLog(db, { logId: f, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType: '罐頭', foodId: 'f-royal-can', itemName: '皇家罐頭', amount: 33, unit: 'g', sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: f, parsedResult: JSON.stringify({ events: [], savedLogIds: [f], unparsedSegments: [], awaitingAction: '' }) });
  assert.equal(await smidHasFoodLog(db, smid, 'u1', { foodId: 'f-royal-can', grams: 33 }), true);
  assert.equal(await smidHasFoodLog(db, smid, 'u1', { foodId: 'f-royal-can', grams: 20 }), false, '不同克數不算重複');
  assert.equal(await smidHasFoodLog(db, smid, 'u1', { foodId: 'f-hills-can', grams: 33 }), false, '不同品項不算重複');
});
