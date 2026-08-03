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
import { exactFoodMatches, smidPriorSavedIds, smidPendingFoods, smidHasFoodLog, logsForSmid, collectUndoableBySmid, applyUndo } from '../src/index.js';
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

test('安全：品名含「水」不得誤切出 water（Commit2 後品名保留、句尾水正常切）', () => {
  // 皇家水解蛋白33 水8：句尾「水8」是獨立水事件，品名裡的「水」不切；品名段（無類別詞）保留在 unparsed
  const r1 = parseMessage('皇家水解蛋白33水8');
  assert.equal(r1.type, 'multiRecord');
  assert.ok(water(r1) && water(r1).amount === 8, '句尾水8應記');
  assert.ok((r1.unparsed || []).some((u) => u.includes('水解蛋白')), '品名段保留，不誤切成 water');
  // 罐頭皇家水8：RC3 切出句尾水8；罐頭皇家（無克數）保留、不誤記成食物
  const r2 = parseMessage('罐頭皇家水8');
  assert.equal(r2.type, 'multiRecord');
  assert.ok(water(r2) && water(r2).amount === 8);
  assert.ok((r2.unparsed || []).some((u) => u.includes('罐頭皇家')));
  // 水解蛋白罐頭33：Commit2 後認得食物（罐頭/水解蛋白/33），且不誤切出獨立 water
  const r3 = parseMessage('水解蛋白罐頭33');
  assert.equal(r3.type, 'record');
  assert.equal(r3.record.category, 'food');
  assert.equal(r3.record.foodType, '罐頭');
  assert.equal(r3.record.itemName, '水解蛋白');
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

// ---------- Commit 1.1：局部成功→補確認→依 smid 完整回讀 ----------
test('Commit1.1：完整回讀卡的資料來自 smid 重查（含先前的水），不是只用新增食物 log', async () => {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const smid = 'MSG_READBACK';

  // (1) 第一次「罐頭希爾斯26 水8」：水先寫入 → water log 確實存在
  const w = U();
  await insertLog(db, { logId: w, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 8, unit: 'ml', waterMl: 8, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'multi_partial', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: w, parsedResult: JSON.stringify({ events: [], savedLogIds: [w], unparsedSegments: [], awaitingAction: 'food_selection' }) });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM logs WHERE category='water' AND isDeleted=0").bind().first().c, 1, '(1) water log 確實存在');
  // 局部完成前，回讀只有水
  const before = await logsForSmid(db, smid, 'u1');
  assert.equal(before.length, 1);
  assert.equal(before[0].category, 'water');

  // (2)(3) 確認食物 → 食物與水共用同一 smid，savedLogIds 含兩筆
  const f = U();
  await insertLog(db, { logId: f, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType: '罐頭', foodId: 'f-hills-can', itemName: '希爾斯罐頭', amount: 26, unit: 'g', sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  const merged = [...new Set([...(await smidPriorSavedIds(db, smid, 'u1')), f])];
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: f, parsedResult: JSON.stringify({ events: [], savedLogIds: merged, unparsedSegments: [], awaitingAction: '' }) });
  assert.deepEqual(merged, [w, f], '(3) savedLogIds 含水＋食物兩筆');
  assert.equal(db.prepare('SELECT sourceMessageId s FROM logs WHERE logId=?').bind(f).first().s, smid, '(2) 食物 log 用同一原始 smid');

  // (4) 完整回讀卡的資料＝依 smid 重查全部正式紀錄（水＋食物），非只用新增食物 log
  const readback = await logsForSmid(db, smid, 'u1');
  assert.equal(readback.length, 2, '(4) 回讀兩筆');
  assert.deepEqual(readback.map((l) => l.category).sort(), ['food', 'water']);

  // (5) 撤銷同時撤水與食物
  const items = await collectUndoableBySmid(db, smid, 'u1');
  assert.equal(items.length, 2);
  await applyUndo(db, items, 'u1');
  assert.equal((await logsForSmid(db, smid, 'u1')).length, 0, '(5) 撤銷後回讀為空');
});

test('Commit1.1：食物取消時水仍保留，回讀仍看得到水（不會靠猜）', async () => {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const smid = 'MSG_CANCEL';
  const w = U();
  await insertLog(db, { logId: w, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 8, unit: 'ml', waterMl: 8, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'multi_partial', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: w, parsedResult: JSON.stringify({ events: [], savedLogIds: [w], unparsedSegments: [], awaitingAction: 'food_selection' }) });
  // 使用者按「取消」→ 不寫食物；水仍在，回讀仍為 1 筆水（foodCancel 會據此回「已保留水」）
  const kept = await logsForSmid(db, smid, 'u1');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].category, 'water');
  assert.equal(kept[0].amount, 8);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM logs WHERE category='food' AND isDeleted=0").bind().first().c, 0, '取消後沒有食物 log');
});

// ---------- Commit 1.1-followup：多 pending 佇列（確認一筆不宣稱全部完成）----------
// 模擬「皇家罐頭33 希爾斯乾糧10 水8」：水先寫入，兩個食物待確認，逐一確認/取消才收斂。
const latestStatus = (db, smid) => db.prepare('SELECT parseStatus FROM text_inputs WHERE sourceMessageId=? ORDER BY id DESC LIMIT 1').bind(smid).first().parseStatus;
async function seedMultiPending(db, smid) {
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  const w = U();
  await insertLog(db, { logId: w, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 8, unit: 'ml', waterMl: 8, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'multi_partial', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: w, parsedResult: JSON.stringify({ events: [], savedLogIds: [w], pendingFoods: [{ foodType: '罐頭', typedName: '皇家', grams: 33, aw: 0 }, { foodType: '乾糧', typedName: '希爾斯', grams: 10, aw: 0 }], unparsedSegments: [], awaitingAction: 'food_selection' }) });
  return w;
}
// 確認一筆 pending（模擬 recFoodG/recFoodRaw 尾段：寫 log、合併 savedLogIds、pendingFoods 減一）
async function confirmOne(db, smid, foodType, typedName, grams) {
  const priorIds = await smidPriorSavedIds(db, smid, 'u1');
  const pending = await smidPendingFoods(db, smid, 'u1');
  const remaining = pending.slice(1);
  const f = U();
  await insertLog(db, { logId: f, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType, itemName: typedName, amount: grams, unit: 'g', sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  const allIds = [...new Set([...priorIds, f])];
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: remaining.length ? 'multi_partial' : 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: f, parsedResult: JSON.stringify({ events: [], savedLogIds: allIds, pendingFoods: remaining, unparsedSegments: [], awaitingAction: remaining.length ? 'food_selection' : '' }) });
  return f;
}

test('多 pending：確認第一筆食物後仍為 multi_partial（不得宣稱全部完成），另有 1 筆待確認', async () => {
  const db = new D1();
  const smid = 'MSG_MULTI';
  await seedMultiPending(db, smid);
  assert.equal((await smidPendingFoods(db, smid, 'u1')).length, 2, '起始兩筆待確認');
  assert.equal((await logsForSmid(db, smid, 'u1')).length, 1, '起始只有水');

  await confirmOne(db, smid, '罐頭', '皇家', 33); // 確認第一筆
  assert.equal(latestStatus(db, smid), 'multi_partial', '確認第一筆後仍 multi_partial，不算完成');
  assert.equal((await smidPendingFoods(db, smid, 'u1')).length, 1, '還剩 1 筆待確認');
  assert.equal((await logsForSmid(db, smid, 'u1')).length, 2, '已記錄水＋皇家罐頭');

  await confirmOne(db, smid, '乾糧', '希爾斯', 10); // 確認第二筆
  assert.equal(latestStatus(db, smid), 'record', '兩筆都確認後才算完成');
  assert.equal((await smidPendingFoods(db, smid, 'u1')).length, 0);
  const finalLogs = await logsForSmid(db, smid, 'u1');
  assert.equal(finalLogs.length, 3, '最終水＋兩食物共三筆');
  assert.deepEqual(finalLogs.map((l) => l.category).sort(), ['food', 'food', 'water']);
});

test('多 pending：確認一筆、取消最後一筆 → 保留已記錄、明確標未記錄', async () => {
  const db = new D1();
  const smid = 'MSG_MULTI_CANCEL';
  await seedMultiPending(db, smid);
  await confirmOne(db, smid, '罐頭', '皇家', 33); // 確認皇家罐頭
  // 取消最後一筆（希爾斯乾糧）：模擬 foodCancel 尾段
  const pending = await smidPendingFoods(db, smid, 'u1');
  assert.equal(pending.length, 1);
  const cancelled = pending[0];
  assert.equal(cancelled.typedName, '希爾斯');
  const kept = await logsForSmid(db, smid, 'u1');
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: kept.map((l) => l.logId).join(','), parsedResult: JSON.stringify({ events: [], savedLogIds: kept.map((l) => l.logId), pendingFoods: [], unparsedSegments: [], awaitingAction: '' }) });
  // 取消後：沒有希爾斯乾糧 log；已記錄仍是水＋皇家罐頭
  assert.equal((await smidPendingFoods(db, smid, 'u1')).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM logs WHERE category='food' AND isDeleted=0").bind().first().c, 1, '只有皇家罐頭一筆食物，希爾斯未寫入');
  assert.equal((await logsForSmid(db, smid, 'u1')).length, 2);
});

test('logsForSmid 不跨家庭：別家相同 smid 的紀錄讀不到', async () => {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('px','u2','別家貓','t','t')").bind().run();
  const smid = 'SAME_MSG';
  const w1 = U(); const w2 = U();
  await insertLog(db, { logId: w1, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 8, unit: 'ml', waterMl: 8, sourceMessageId: smid, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await insertLog(db, { logId: w2, lineUserId: 'u2', petId: 'px', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 99, unit: 'ml', waterMl: 99, sourceMessageId: smid, source: 'line', recordedBy: 'u2', updatedBy: 'u2' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'p1', linkedLogId: w1, parsedResult: JSON.stringify({ events: [], savedLogIds: [w1], unparsedSegments: [], awaitingAction: '' }) });
  await logTextInput(db, { lineUserId: 'u2', ownerId: 'u2', petId: 'px', parseStatus: 'record', sourceMessageId: smid, resolvedPetId: 'px', linkedLogId: w2, parsedResult: JSON.stringify({ events: [], savedLogIds: [w2], unparsedSegments: [], awaitingAction: '' }) });
  const mine = await logsForSmid(db, smid, 'u1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amount, 8, '只讀到自己家的水，不讀到別家 99');
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
