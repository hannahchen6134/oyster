// 品牌選擇流程：part 四用「真實 foodDisambigFlex」驗證 postback 帶值/編碼/長度；
// part 二/三用 node:sqlite 等價測試重現 recFoodG 完成序列（食物＋加水各一筆、savedLogIds 兩個、最新狀態 record）。
// 註：LINE webhook 的實際 handleRecord/recFoodG 串接無法在無 webhook 環境單測，屬「等價測試＋程式審查」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { foodDisambigFlex } from '../src/flex.js';
import { deriveFoodFields } from '../src/summary.js';
import { insertLog, logTextInput } from '../src/db.js';

// ---------- part 四：真實 foodDisambigFlex 的 postback 帶 g/aw/smid ----------
test('part四：品牌選擇卡 postback 完整保留 g=34、aw=14、smid，編碼正確、長度未爆', () => {
  const flex = foodDisambigFlex({
    pet: { petName: '蚵仔' }, foodType: '罐頭', typedName: '罐頭',
    grams: 34, addedWaterMl: 14, smid: '123456789',
    options: [{ foodId: 'f-hills', displayName: '希爾斯罐頭', foodType: '罐頭' }, { foodId: 'f-royal', displayName: '皇家罐頭', foodType: '罐頭' }],
    guessId: 'f-hills'
  });
  const json = JSON.stringify(flex);
  // 找出品牌按鈕的 postback data
  const m = json.match(/action=recFoodG&foodId=f-hills&g=34&aw=14&smid=[^"']*/);
  assert.ok(m, '品牌按鈕 postback 應含 recFoodG&foodId&g=34&aw=14&smid');
  const data = m[0];
  const usp = new URLSearchParams(data); // data 無 leading '?'，可直接當 query 解析
  assert.equal(usp.get('foodId'), 'f-hills');
  assert.equal(usp.get('g'), '34');
  assert.equal(usp.get('aw'), '14');
  assert.equal(usp.get('smid'), '123456789');
  assert.ok(data.length < 300, `postback 長度需 < 300（LINE 限制），實際 ${data.length}`);
});

test('part四：smid 為空時仍安全（smid= 空字串，不炸）', () => {
  const flex = foodDisambigFlex({ pet: {}, foodType: '乾糧', typedName: '乾糧', grams: 5, addedWaterMl: 0, smid: '', options: [{ foodId: 'a', displayName: 'A乾糧', foodType: '乾糧' }, { foodId: 'b', displayName: 'B乾糧', foodType: '乾糧' }] });
  const json = JSON.stringify(flex);
  assert.ok(json.includes('action=recFoodG&foodId=a&g=5&aw=0&smid='));
});

// ---------- part 二/三：等價重現 recFoodG 完成序列 ----------
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
const cnt = (db, cat) => db.prepare('SELECT COUNT(*) c FROM logs WHERE category=? AND isDeleted=0').bind(cat).first().c;

test('part二/三（等價）：選品牌前 0 log/awaiting；選完 食物1筆34g＋加水1筆14ml、不重複、最新狀態 record、savedLogIds 兩個', async () => {
  const db = new D1();
  const smid = 'MSG_FOOD';
  const food = { foodId: 'f-royal', displayName: '皇家罐頭', foodType: '罐頭', kcalPerGram: 0.96, waterRatio: 0.8 };

  // 選品牌前：只記一列 awaiting_food_selection，正式 logs = 0
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', sourceMessageId: smid, parseStatus: 'awaiting_food_selection', resolvedPetId: 'p1', linkedLogId: '', parsedResult: JSON.stringify({ awaitingAction: 'food_selection', savedLogIds: [], unparsedSegments: [] }) });
  assert.equal(cnt(db, 'food'), 0);
  assert.equal(cnt(db, 'water'), 0);

  // 選完品牌（重現 recFoodG＋handleRecord 的資料寫入：食物 log 34g ＋ 加水 log 14ml）
  const g = 34, aw = 14;
  const derived = deriveFoodFields(g, food.foodType, food);
  const foodLog = await insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType: food.foodType, foodId: food.foodId, itemName: food.displayName, amount: g, unit: 'g', kcal: derived.kcal, waterMl: derived.waterMl, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  const waterLog = await insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: aw, unit: 'ml', waterMl: aw, note: '罐頭加水', source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', sourceMessageId: smid, parseStatus: 'record', resolvedPetId: 'p1', linkedLogId: foodLog.logId, parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: '罐頭', itemName: '皇家罐頭', amount: g, addedWaterMl: aw }], savedLogIds: [foodLog.logId, waterLog.logId], unparsedSegments: [], awaitingAction: '' }) });

  // 食物與加水各只有一筆、量正確、不重複
  assert.equal(cnt(db, 'food'), 1);
  assert.equal(cnt(db, 'water'), 1);
  assert.equal(db.prepare("SELECT amount a FROM logs WHERE category='food'").bind().first().a, 34);
  assert.equal(db.prepare("SELECT amount a FROM logs WHERE category='water'").bind().first().a, 14);

  // 同一 sourceMessageId 最新列（最大 id）＝ record，且 savedLogIds 含兩個 log、unparsed/awaiting 為空
  const latest = db.prepare('SELECT * FROM text_inputs WHERE sourceMessageId=? ORDER BY id DESC LIMIT 1').bind(smid).first();
  assert.equal(latest.parseStatus, 'record');
  const pr = JSON.parse(latest.parsedResult);
  assert.deepEqual(pr.savedLogIds, [foodLog.logId, waterLog.logId]);
  assert.equal(pr.unparsedSegments.length, 0);
  assert.equal(pr.awaitingAction, '');
  // append-only：awaiting 那列仍在（共兩列）
  assert.equal(db.prepare('SELECT COUNT(*) c FROM text_inputs WHERE sourceMessageId=?').bind(smid).first().c, 2);
});
