// ↩️ 撤銷這次紀錄：直接測真實 export（parseUndoIds/collectUndoable/applyUndo）＋ recordFlex 卡片。
// 用 node:sqlite 建記憶體 DB 跑真正的 db.js（softDeleteLog/getLog/insertLog/recomputeDay）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseUndoIds, collectUndoable, collectUndoableBySmid, savedLogIdsBySmid, applyUndo } from '../src/index.js';
import { insertLog, logTextInput } from '../src/db.js';
import { recordFlex, multiRecordFlex, undoConfirmFlex } from '../src/flex.js';

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
const isDel = (db, id) => db.prepare('SELECT isDeleted d FROM logs WHERE logId=?').bind(id).first().d;

async function seedFamily() {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('px','u2','別家貓','t','t')").bind().run();
  return db;
}
const mkFood = (id) => ({ logId: id, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'food', foodType: '罐頭', amount: 34, unit: 'g', kcal: 33, waterMl: 27, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });
const mkWater = (id, ml = 14) => ({ logId: id, lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 12:00', category: 'water', amount: ml, unit: 'ml', waterMl: ml, source: 'line', recordedBy: 'u1', updatedBy: 'u1' });

// ── 3/十：parseUndoIds 不可信輸入 ──
test('parseUndoIds：只收 uuid、去重、濾無效、接受陣列（cap 由呼叫端控制）', () => {
  const a = U(), b = U();
  assert.deepEqual(parseUndoIds(`${a},${b},${a}`), [a, b]);            // 去重
  assert.deepEqual(parseUndoIds(`${a}, not-a-uuid , 123`), [a]);       // 濾無效
  assert.deepEqual(parseUndoIds(''), []);
  assert.deepEqual(parseUndoIds([a, b, a]), [a, b]);                   // 接受陣列
  assert.equal(parseUndoIds(Array.from({ length: 30 }, () => U())).length, 30); // 本身不截斷
});

test('collectUndoable 內嵌路徑上限 6（避免超長 postback；實務單筆只 ≤2）', async () => {
  const db = await seedFamily();
  const ids = Array.from({ length: 8 }, () => U());
  for (const id of ids) await insertLog(db, mkWater(id, 5));
  const items = await collectUndoable(db, ids.join(','), 'u1'); // 預設 cap = 6
  assert.equal(items.length, 6);
});

// ── 1/2：單筆／食物＋加水一起撤銷 ──
test('食物＋加水兩筆一起撤銷（都軟刪、不漏加水）', async () => {
  const db = await seedFamily();
  const f = U(), w = U();
  await insertLog(db, mkFood(f)); await insertLog(db, mkWater(w));
  const items = await collectUndoable(db, `${f},${w}`, 'u1');
  assert.equal(items.length, 2);
  await applyUndo(db, items, 'u1');
  assert.equal(isDel(db, f), 1);
  assert.equal(isDel(db, w), 1);
});

// ── 3：多筆一起撤銷 ──
test('multiRecord 多筆一起撤銷', async () => {
  const db = await seedFamily();
  const ids = [U(), U(), U()];
  await insertLog(db, mkFood(ids[0])); await insertLog(db, mkWater(ids[1])); await insertLog(db, mkWater(ids[2], 20));
  await applyUndo(db, await collectUndoable(db, ids.join(','), 'u1'), 'u1');
  for (const id of ids) assert.equal(isDel(db, id), 1);
});

// ── 4/5：multi_partial 只撤已成功的；不影響同天其他 ──
test('只撤銷傳入的 savedIds，不影響同一天其他紀錄', async () => {
  const db = await seedFamily();
  const w1 = U(), other = U();
  await insertLog(db, mkWater(w1)); await insertLog(db, mkWater(other, 99)); // other 不在撤銷清單
  await applyUndo(db, await collectUndoable(db, w1, 'u1'), 'u1');
  assert.equal(isDel(db, w1), 1);
  assert.equal(isDel(db, other), 0); // 同天其他紀錄不受影響
});

// ── 6：重複撤銷安全（冪等）──
test('重複撤銷安全：第二次 collectUndoable 為空、不重複刪、不報錯', async () => {
  const db = await seedFamily();
  const f = U(); await insertLog(db, mkFood(f));
  await applyUndo(db, await collectUndoable(db, f, 'u1'), 'u1');
  assert.equal(isDel(db, f), 1);
  const again = await collectUndoable(db, f, 'u1'); // 已刪 → 不再可撤銷
  assert.equal(again.length, 0);
  await applyUndo(db, again, 'u1'); // 空陣列 → 不炸、無副作用
  assert.equal(isDel(db, f), 1);
});

// ── 7：取消不刪資料 ──
test('取消（只 collect 不 apply）不刪任何資料', async () => {
  const db = await seedFamily();
  const f = U(); await insertLog(db, mkFood(f));
  await collectUndoable(db, f, 'u1'); // 只列出，不執行
  assert.equal(isDel(db, f), 0);
});

// ── 8/9：權限——別家不可刪；家庭 owner 可刪 ──
test('權限：別家 log 不可撤銷；家庭 owner 可撤銷家庭 log', async () => {
  const db = await seedFamily();
  const mine = U(), theirs = U();
  await insertLog(db, mkFood(mine));
  await insertLog(db, { logId: theirs, lineUserId: 'u2', petId: 'px', eventDateTime: '2026-08-03 12:00', category: 'water', amount: 5, unit: 'ml', waterMl: 5, source: 'line', recordedBy: 'u2', updatedBy: 'u2' });
  const items = await collectUndoable(db, `${mine},${theirs}`, 'u1'); // 以 u1 家庭撤銷
  assert.equal(items.length, 1);                 // 只收得到自己家的
  assert.equal(items[0].logId, mine);
  await applyUndo(db, items, 'u1');
  assert.equal(isDel(db, mine), 1);
  assert.equal(isDel(db, theirs), 0);            // 別家未被刪
});

// ── 10：混入無效/重複/過多 id 的容錯 ──
test('容錯：混入無效與重複 id，只撤有效且有權限者', async () => {
  const db = await seedFamily();
  const f = U(); await insertLog(db, mkFood(f));
  const items = await collectUndoable(db, `${f}, not-uuid, ${f}, ${U()}`, 'u1'); // 重複 f、無效字串、不存在 uuid
  assert.equal(items.length, 1);
  await applyUndo(db, items, 'u1');
  assert.equal(isDel(db, f), 1);
});

// ── 11：撤銷後今日累積正確重算 ──
test('撤銷後 recomputeDay：daily_summary 水分正確扣除', async () => {
  const db = await seedFamily();
  const w = U(); await insertLog(db, mkWater(w, 40));
  await applyUndo(db, await collectUndoable(db, w, 'u1'), 'u1'); // 內含 recomputeDay
  const s = db.prepare("SELECT totalWaterMl t FROM daily_summary WHERE petId='p1' AND date='2026-08-03'").bind().first();
  assert.ok(s && Number(s.t) === 0, `撤銷後今日水分應為 0，實際 ${s && s.t}`);
});

// ── 12：卡片——有 undoData 顯示撤銷、仍保留改數量；無 undoData 維持刪除 ──
test('recordFlex：有 undoData → 顯示「撤銷這次紀錄」且保留「改數量」；無 undoData → 維持「刪除」', () => {
  const withUndo = JSON.stringify(recordFlex({ pet: { petName: '蚵仔' }, categoryKey: 'water', mainText: '喝水 14ml', summary: {}, logId: 'L1', undoData: 'smid=12345' }));
  assert.ok(withUndo.includes('action=undoOp&smid=12345'), '應有撤銷 postback');
  assert.ok(withUndo.includes('改數量'), '改數量功能不受影響');
  assert.ok(!withUndo.includes('action=delAsk'), '有 undoData 時不再顯示單筆刪除');

  const noUndo = JSON.stringify(recordFlex({ pet: {}, categoryKey: 'water', mainText: '喝水 14ml', summary: {}, logId: 'L9' }));
  assert.ok(noUndo.includes('action=delAsk&logId=L9'), '無 undoData → 維持既有單筆刪除');
});

// ── postback 長度：兩把鑰匙在最大合法情況下都 < 300 bytes（UTF-8）──
test('postback byte 長度：smid 與 內嵌 ids（上限 6）的 undoOp/undoDo 皆 < 300 bytes', () => {
  const B = (s) => Buffer.byteLength(s, 'utf8');
  // smid：LINE message id 最長約 19 位數
  const smid = '1'.repeat(19);
  assert.ok(B(`action=undoOp&smid=${smid}`) < 300);
  assert.ok(B(`action=undoDo&smid=${smid}`) < 300);
  // 內嵌 ids：達內嵌上限 6 個 UUID（實務單筆/食物+加水只會 ≤2）
  const ids = Array.from({ length: 6 }, () => U()).join(',');
  assert.ok(B(`action=undoOp&ids=${ids}`) < 300, `6 個 UUID 的 undoOp 應 < 300，實際 ${B(`action=undoOp&ids=${ids}`)}`);
  assert.ok(B(`action=undoDo&ids=${ids}`) < 300);
});

// ── 全流程文案一律「刪除」，正式 UI 不得出現「撤銷」──
const NO_UNDO = (json, where) => assert.ok(!/撤銷/.test(json), `${where} 不得出現「撤銷」`);

// 第一層刪除鈕：單筆＝刪除這筆、多筆＝刪除這次 N 筆；底層都走 undoOp（smid 批次軟刪）
test('recordFlex：undoCount=1 → 「刪除這筆」；undoCount≥2 → 「刪除這次 N 筆」；不得出現「撤銷」', () => {
  const single = JSON.stringify(recordFlex({ pet: { petName: '蚵仔' }, categoryKey: 'wet', mainText: '希爾斯罐頭 32g', summary: {}, logId: 'L1', undoData: 'smid=12345', undoCount: 1 }));
  assert.ok(single.includes('action=undoOp&smid=12345'), '單筆仍走 undoOp（刪同次整批）');
  assert.ok(single.includes('刪除這筆'), '單筆顯示「刪除這筆」');
  NO_UNDO(single, 'recordFlex 單筆');

  const multi = JSON.stringify(recordFlex({ pet: { petName: '蚵仔' }, categoryKey: 'wet', mainText: '罐頭 30g＋加水 10ml', summary: {}, logId: 'L2', undoData: 'smid=12345', undoCount: 2 }));
  assert.ok(multi.includes('action=undoOp&smid=12345'), '多筆走 undoOp');
  assert.ok(multi.includes('刪除這次 2 筆'), '多筆顯示「刪除這次 2 筆」');
  assert.ok(!multi.includes('刪除這筆'), '多筆不顯示「刪除這筆」');
  NO_UNDO(multi, 'recordFlex 多筆');
});

test('multiRecordFlex：一次記多筆 → 刪除鈕文案為「刪除這次 N 筆」，不得出現「撤銷」', () => {
  const json = JSON.stringify(multiRecordFlex({ petName: '蚵仔' }, ['水 20ml', '乾糧 5g'], {}, '2026-08-04', '', 'smid=777'));
  assert.ok(json.includes('action=undoOp&smid=777'));
  assert.ok(json.includes('刪除這次 2 筆'), 'N＝顯示的紀錄行數');
  NO_UNDO(json, 'multiRecordFlex');
});

// ── 二段確認卡：Flex 內建按鈕（永遠可見），確認鈕綁 undo token、不要求打字，一律「刪除」措辭 ──
test('undoConfirmFlex（單筆）：標題/按鈕全是「刪除」、綁 smid、取消鈕 undoCancel、非 quick reply、無「撤銷」', () => {
  const json = JSON.stringify(undoConfirmFlex({ pet: { petName: '蚵仔' }, lines: ['希爾斯罐頭 32 g'], undoKey: 'smid=12345', count: 1 }));
  assert.ok(json.includes('刪除確認'), '標題列＝刪除確認');
  assert.ok(json.includes('確定要刪除這筆紀錄嗎？'), '單筆確認文字');
  assert.ok(json.includes('action=undoDo&smid=12345'), '確認鈕 postback 綁原 smid');
  assert.ok(json.includes('"label":"確認刪除"'), '紅色確認鈕文字');
  assert.ok(json.includes('"label":"取消"') && json.includes('action=undoCancel'), '取消鈕存在且不動資料');
  assert.ok(json.includes('希爾斯罐頭 32 g'), '列出要刪除的內容');
  assert.ok(!json.includes('quickReply'), '是氣泡內建按鈕，非 quick reply');
  assert.ok(json.includes('"type":"flex"'), '確認介面為 Flex 氣泡');
  NO_UNDO(json, 'undoConfirmFlex 單筆');
});

test('undoConfirmFlex（多筆）：標題「刪除這次 N 筆」、確認鈕「確認刪除」、綁同一 undo token、無「撤銷」', () => {
  const json = JSON.stringify(undoConfirmFlex({ pet: { petName: '蚵仔' }, lines: ['希爾斯罐頭 26 g', '水 8 ml'], undoKey: 'smid=888', count: 2 }));
  assert.ok(json.includes('刪除確認'), '標題列＝刪除確認');
  assert.ok(json.includes('確定要刪除這次 2 筆紀錄嗎？'), '多筆確認文字含筆數');
  assert.ok(json.includes('"label":"確認刪除"'), '多筆也是「確認刪除」');
  assert.ok(json.includes('action=undoDo&smid=888'));
  assert.ok(json.includes('希爾斯罐頭 26 g') && json.includes('水 8 ml'), '列出本次全部紀錄');
  NO_UNDO(json, 'undoConfirmFlex 多筆');
});

test('undoConfirmFlex：確認鈕文字（含 emoji 也）不會過長；內嵌 ids 版 postback < 300 bytes', () => {
  const ids = Array.from({ length: 6 }, () => U()).join(',');
  const json = JSON.stringify(undoConfirmFlex({ pet: {}, lines: ['x'], undoKey: `ids=${ids}`, count: 6 }));
  const m = json.match(/action=undoDo&ids=[^"']*/);
  assert.ok(m, '應有 undoDo&ids postback');
  assert.ok(Buffer.byteLength(m[0], 'utf8') < 300, `確認鈕 postback 應 < 300，實際 ${Buffer.byteLength(m[0], 'utf8')}`);
  // 按鈕 label 不截斷：LINE Flex button label 上限 20 字元，實際文字遠短於此
  assert.ok('確認刪除'.length <= 20 && '刪除這次 6 筆'.length <= 20);
});

// 一次掃過所有刪除相關 Flex／字樣：正式 UI 全面禁「撤銷」
test('全面檢查：刪除相關 Flex 與第一層鈕文字都不含「撤銷」', () => {
  const outs = [
    JSON.stringify(recordFlex({ pet: { petName: '蚵仔' }, categoryKey: 'wet', mainText: 'x', summary: {}, logId: 'L', undoData: 'smid=1', undoCount: 1 })),
    JSON.stringify(recordFlex({ pet: { petName: '蚵仔' }, categoryKey: 'wet', mainText: 'x', summary: {}, logId: 'L', undoData: 'smid=1', undoCount: 2 })),
    JSON.stringify(multiRecordFlex({ petName: '蚵仔' }, ['a', 'b'], {}, '2026-08-04', '', 'smid=1')),
    JSON.stringify(undoConfirmFlex({ pet: {}, lines: ['a'], undoKey: 'smid=1', count: 1 })),
    JSON.stringify(undoConfirmFlex({ pet: {}, lines: ['a', 'b'], undoKey: 'smid=1', count: 3 }))
  ];
  outs.forEach((o, i) => NO_UNDO(o, `輸出#${i}`));
});

// ── smid token：從 text_inputs.savedLogIds 取全量、不截斷（多筆也能全撤，杜絕部分撤銷）──
test('collectUndoableBySmid：多筆（8 筆）操作用 smid 全部取回、不截斷', async () => {
  const db = await seedFamily();
  const ids = Array.from({ length: 8 }, () => U());
  for (const id of ids) await insertLog(db, mkWater(id, 5));
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', sourceMessageId: 'MSGBIG', parseStatus: 'record', resolvedPetId: 'p1', linkedLogId: ids[0], parsedResult: JSON.stringify({ savedLogIds: ids, unparsedSegments: [], awaitingAction: '' }) });
  const items = await collectUndoableBySmid(db, 'MSGBIG', 'u1');
  assert.equal(items.length, 8, '8 筆應全部取回、不被 6 上限截斷');
  await applyUndo(db, items, 'u1');
  for (const id of ids) assert.equal(isDel(db, id), 1);
});

// 重複點擊「已刪除」的卡：要能分辨原本單/多筆（savedLogIds 不隨軟刪消失）→ 決定回「這筆／這次紀錄已經刪除了」
test('savedLogIdsBySmid：軟刪後仍回原始筆數（供重複點擊訊息判斷單/多筆）', async () => {
  const db = await seedFamily();
  const one = U();
  await insertLog(db, mkWater(one, 5));
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', sourceMessageId: 'MSG1', parseStatus: 'record', resolvedPetId: 'p1', linkedLogId: one, parsedResult: JSON.stringify({ savedLogIds: [one] }) });
  const ids2 = [U(), U()];
  for (const id of ids2) await insertLog(db, mkWater(id, 5));
  await logTextInput(db, { lineUserId: 'u1', ownerId: 'u1', petId: 'p1', sourceMessageId: 'MSG2', parseStatus: 'record', resolvedPetId: 'p1', linkedLogId: ids2[0], parsedResult: JSON.stringify({ savedLogIds: ids2 }) });

  // 先全部軟刪，再確認 savedLogIdsBySmid 仍回原始筆數（1 vs 2）→ 訊息才能分「這筆」/「這次」
  await applyUndo(db, await collectUndoableBySmid(db, 'MSG1', 'u1'), 'u1');
  await applyUndo(db, await collectUndoableBySmid(db, 'MSG2', 'u1'), 'u1');
  assert.equal((await savedLogIdsBySmid(db, 'MSG1', 'u1')).length, 1, '單筆 smid 仍回 1');
  assert.equal((await savedLogIdsBySmid(db, 'MSG2', 'u1')).length, 2, '多筆 smid 仍回 2');
  // 別家取不到
  assert.equal((await savedLogIdsBySmid(db, 'MSG1', 'u2')).length, 0, '別家 owner 取不到');
});

test('collectUndoableBySmid：別家的 sourceMessageId 取不到（權限）', async () => {
  const db = await seedFamily();
  const id = U(); await insertLog(db, mkWater(id));
  await logTextInput(db, { lineUserId: 'u2', ownerId: 'u2', petId: 'px', sourceMessageId: 'MSGX', parseStatus: 'record', parsedResult: JSON.stringify({ savedLogIds: [id] }) });
  const items = await collectUndoableBySmid(db, 'MSGX', 'u1'); // 以 u1 家庭查 u2 的訊息
  assert.equal(items.length, 0);
});
