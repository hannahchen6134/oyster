// 「先選貓咪」流程不得遺失紀錄（皇家罐頭33克水8毫升早藥吃了 → 選蚵仔 → 3 筆）。
// 直接驗真實 export：analyzeLeading（判別 leadingNoPet vs leadingUnknown）、describeParsedEvents（選貓提示列出事件）、
// recordMultiForPet（選完貓後用「同一套多筆機制」落地，含 deferDisambig/candidates/pending）＋ collectUndoableBySmid/applyUndo。
// 用 node:sqlite 跑真正的 db.js；LINE API 以 stub fetch 靜默掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { analyzeLeading, parseMessage } from '../src/parser.js';
import { recordMultiForPet, describeParsedEvents, collectUndoableBySmid, savedLogIdsBySmid, applyUndo } from '../src/index.js';

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

// LINE API 靜默：所有 fetch 一律回 ok，避免測試對外連線
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const FAMILY = ['蚵仔', '麵線', '辜董'];
function seed(withFood = true) {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p2','u1','麵線','t','t')").bind().run();
  if (withFood) {
    db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-royal','u1','皇家罐頭','罐頭',0.96,0.8,'t','t')").bind().run();
  }
  return db;
}
const env = { DB: null, LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });
const catOf = (db, cat) => db.prepare("SELECT COUNT(*) c FROM logs WHERE category=? AND isDeleted=0").bind(cat).first().c;
const recsOf = (text) => { const p = parseMessage(text); return p.type === 'multiRecord' ? p.records : (p.type === 'record' ? [p.record] : []); };

// ── 根因回歸：analyzeLeading 不得把食物名當不明貓名前綴 ──
test('analyzeLeading：食物名句首（皇家罐頭33 水8 早藥）→ leadingNoPet、帶完整句（食物不被剝掉）', () => {
  const r = analyzeLeading('皇家罐頭33克水8毫升早藥吃了', FAMILY);
  assert.equal(r.kind, 'leadingNoPet');
  assert.ok(r.eventText.includes('皇家罐頭'), 'eventText 必須保留食物名');
  // 完整句解析＝3 筆（食物＋水＋藥），證明沒有遺失
  assert.equal(recsOf(r.eventText).length, 3);
});

test('analyzeLeading：真雜字句首（旺財 喝水 1ml）維持 leadingUnknown、前綴=旺財（不受影響）', () => {
  const r = analyzeLeading('旺財 喝水 1ml', FAMILY);
  assert.equal(r.kind, 'leadingUnknown');
  assert.equal(r.prefix, '旺財');
});

test('analyzeLeading：未命中的食物句首（喵喵牌罐頭…）仍 leadingNoPet（食物是事件、不可丟）', () => {
  const r = analyzeLeading('喵喵牌罐頭33克水8毫升早藥吃了', FAMILY);
  assert.equal(r.kind, 'leadingNoPet');
  assert.equal(recsOf(r.eventText).length, 3);
});

test('analyzeLeading：句首帶已知貓名（蚵仔皇家罐頭33 水8 早藥）→ named、剝出貓名後 3 筆可直接處理（不需選貓）', () => {
  const r = analyzeLeading('蚵仔皇家罐頭33克水8毫升早藥吃了', FAMILY);
  assert.equal(r.kind, 'named');
  assert.equal(r.petName, '蚵仔');
  assert.equal(recsOf(r.rest).length, 3, '剝出貓名後仍是 3 筆（食物不遺失）');
});

test('describeParsedEvents：選貓提示會列出 3 個事件（食物/水/藥），不遺漏食物', () => {
  const list = describeParsedEvents('皇家罐頭33克水8毫升早藥吃了');
  assert.equal(list.length, 3);
  assert.ok(list.some((t) => t.includes('皇家') && t.includes('33')), '含皇家罐頭33g');
  assert.ok(list.some((t) => t.includes('水') && t.includes('8')), '含水8ml');
  assert.ok(list.some((t) => t.includes('藥')), '含藥');
});

// ── 整合①：選蚵仔後，食物唯一命中 → 直接 3 筆全寫入、不遺失，且同一 smid 可一起刪除 ──
test('recordMultiForPet：食物唯一命中 food_items → 3 筆全寫入（食物+水+藥），savedLogIds=3、同一 smid 可全刪', async () => {
  const db = seed(true); env.DB = db;
  const smid = 'MSG_A';
  const records = recsOf('皇家罐頭33克水8毫升早藥吃了');
  assert.equal(records.length, 3, '前置：解析出 3 筆');
  await recordMultiForPet(env, mkEvent(), db, {
    pet: { petId: 'p1', petName: '蚵仔' }, records, candidates: [], unparsed: [],
    smid, rawText: '皇家罐頭33克水8毫升早藥吃了', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: ''
  });
  assert.equal(catOf(db, 'food'), 1, '食物 1 筆（不得遺失）');
  assert.equal(catOf(db, 'water'), 1, '水 1 筆');
  assert.equal(catOf(db, 'med'), 1, '藥 1 筆');
  const food = db.prepare("SELECT itemName, amount, foodType, kcal FROM logs WHERE category='food'").bind().first();
  assert.equal(food.itemName, '皇家罐頭');
  assert.equal(food.amount, 33);
  assert.equal(food.foodType, '罐頭');
  assert.ok(food.kcal > 0, '唯一命中 → 用 food_item 公式算熱量');
  // savedLogIds 掛在同一 smid，且刪除這次能一起刪 3 筆
  assert.equal((await savedLogIdsBySmid(db, smid, 'u1')).length, 3, 'savedLogIds=3、延續同一次操作');
  const items = await collectUndoableBySmid(db, smid, 'u1');
  assert.equal(items.length, 3, '刪除這次 → 收得同一 smid 全部 3 筆');
  await applyUndo(db, items, 'u1');
  assert.equal(catOf(db, 'food') + catOf(db, 'water') + catOf(db, 'med'), 0, '3 筆一起軟刪');
});

// ── 整合③：未命中食物 → 水藥先記（2 筆），食物進 pending（partial），不遺失 ──
test('recordMultiForPet：食物未命中 → 水藥先寫入（2 筆），食物進 pendingFoods、狀態 multi_partial（不遺失）', async () => {
  const db = seed(true); env.DB = db; // 家裡有皇家罐頭，但輸入「喵喵牌」對不到
  const smid = 'MSG_C';
  const records = recsOf('喵喵牌罐頭33克水8毫升早藥吃了');
  assert.equal(records.length, 3);
  await recordMultiForPet(env, mkEvent(), db, {
    pet: { petId: 'p1', petName: '蚵仔' }, records, candidates: [], unparsed: [],
    smid, rawText: '喵喵牌罐頭33克水8毫升早藥吃了', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: ''
  });
  assert.equal(catOf(db, 'water'), 1, '水先寫入');
  assert.equal(catOf(db, 'med'), 1, '藥先寫入');
  assert.equal(catOf(db, 'food'), 0, '未命中食物先不寫入（進待確認）');
  const row = db.prepare("SELECT parseStatus, parsedResult FROM text_inputs WHERE sourceMessageId=? ORDER BY id DESC LIMIT 1").bind(smid).first();
  assert.equal(row.parseStatus, 'multi_partial', '狀態＝multi_partial，不宣稱完成');
  const pr = JSON.parse(row.parsedResult);
  assert.equal(pr.savedLogIds.length, 2, '已寫入 2 筆');
  assert.equal(pr.pendingFoods.filter((p) => p.status === 'pending').length, 1, '食物 1 筆待確認、未遺失');
  assert.equal(pr.awaitingAction, 'food_selection');
});

test.after(() => { globalThis.fetch = origFetch; });
