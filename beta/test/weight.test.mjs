// 體重「新增 vs 修改」規格測試（規格七的 20 條）：
//  - 解析層：parseMessage 區分 weightAdd(record) / weightModify；貓名前綴由 analyzeLeading 正確剝離。
//  - 語意層：改6 不當體重、罐頭改6g 維持食物、多貓改6公斤先選貓、單貓進確認。
//  - 資料層（用真正的 db.js＋node:sqlite）：修改保留原日期、resync 目前體重、刪除回退、冪等不重複。
// 圖片/卡片外觀屬人工驗收；這裡驗真實 export 的行為與資料一致性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, analyzeLeading } from '../src/parser.js';
import {
  getLatestWeightLog, resyncPetWeight, getPet, insertLog, updateLog, softDeleteLog, getLog
} from '../src/db.js';
import {
  applyWeightModify, applyWeightAddToday, handleWeightModify, showWeightModifyConfirm, applyUndo
} from '../src/index.js';
import { formatWeightKg } from '../src/util.js';
import { weightAddedFlex, weightModifyConfirmFlex } from '../src/flex.js';
import { buildA4Report } from '../public/a4-report.js';

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

// LINE API 靜默＋擷取送出的卡片（altText）供「顯示哪張卡」斷言
let sentAlt = [];
globalThis.fetch = async (url, opts) => {
  try {
    const body = JSON.parse(opts?.body || '{}');
    for (const m of body.messages || []) sentAlt.push(m.altText || m.text || '');
  } catch { /* ignore */ }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

function seed({ multi = false } = {}) {
  const db = new D1();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, weightKg, createdAt, updatedAt) VALUES ('p1','u1','炭吉',5.8,'t','t')").bind().run();
  if (multi) db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, weightKg, createdAt, updatedAt) VALUES ('p2','u1','蚵仔',4.2,'t','t')").bind().run();
  return db;
}
async function addWeight(db, petId, amount, dateTime, smid = '') {
  return insertLog(db, { lineUserId: 'u1', petId, eventDateTime: dateTime, category: 'weight', amount, unit: 'kg', sourceMessageId: smid, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
const env = { DB: null, LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const mkEvent = (id = 'm1') => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id, text: '' } });
const parseType = (s) => { const r = parseMessage(s); return r.type; };
const isWeightAdd = (s) => { const r = parseMessage(s); return r.type === 'record' && r.record.category === 'weight' ? r.record.amount : null; };

// ── 一、新增體重的解析（測試 1–6）──────────────────────────────
test('新增：炭吉體重6 / 體重6公斤 / 體重6.2 / 記體重6.25kg → weight record，數值正確', () => {
  assert.equal(isWeightAdd('體重6'), 6);
  assert.equal(isWeightAdd('體重6公斤'), 6);
  assert.equal(isWeightAdd('體重6.2'), 6.2);
  assert.equal(isWeightAdd('記體重6.25kg'), 6.25);
});
test('新增：貓名＋公斤（炭吉6公斤 剝名後 6公斤）與 蚵仔體重4.2 → weight record', () => {
  assert.equal(isWeightAdd('6公斤'), 6);      // 炭吉6公斤 → 剝名後
  assert.equal(isWeightAdd('6kg'), 6);
  const lead = analyzeLeading('炭吉6公斤', ['炭吉', '蚵仔']);
  assert.equal(lead.kind, 'named');
  assert.equal(isWeightAdd(lead.rest), 6);
  assert.equal(isWeightAdd('體重4.2'), 4.2);   // 蚵仔體重4.2 → 剝名後
});

// ── 二、修改體重的解析（測試 7–11）──────────────────────────────
test('修改：改6公斤 / 改體重6 / 改體重6.2公斤 / 體重改6 / 體重改成6公斤 → weightModify', () => {
  for (const [s, amt] of [['改6公斤', 6], ['改體重6', 6], ['改體重6.2公斤', 6.2], ['體重改6', 6], ['體重改成6公斤', 6]]) {
    const r = parseMessage(s);
    assert.equal(r.type, 'weightModify', `${s} 應為 weightModify`);
    assert.equal(r.amount, amt, `${s} 金額`);
  }
});
test('修改：貓名前綴（炭吉改6公斤 / 把炭吉體重改成6公斤）→ analyzeLeading 剝名後仍是 weightModify', () => {
  const pets = ['炭吉', '蚵仔'];
  const l1 = analyzeLeading('炭吉改6公斤', pets);
  assert.equal(l1.kind, 'named'); assert.equal(parseMessage(l1.rest).type, 'weightModify');
  // 「把炭吉體重改成6公斤」的把字剝除由 index.js 處理；這裡驗剝除後的字串可辨識
  assert.equal(parseMessage('體重改成6公斤').type, 'weightModify');
});

// ── 三、語意優先序（測試 14、15）──────────────────────────────
test('改6（無體重/公斤）不得判為體重，維持既有改上一筆數量流程（fixLast）', () => {
  assert.equal(parseType('改6'), 'fixLast');
});
test('罐頭改6g 不得誤判成體重（維持食物流程）；乾糧2公斤 也不當貓體重', () => {
  assert.notEqual(parseType('罐頭改6g'), 'weightModify');
  assert.notEqual(isWeightAdd('罐頭改6g'), 6);
  assert.notEqual(isWeightAdd('乾糧2公斤'), 2);
});

// ── 四、修改流程分派（測試 12、13、16）───────────────────────────
test('多貓＋「改6公斤」無指定貓 → 先選貓（不直接動資料）', async () => {
  const db = seed({ multi: true }); env.DB = db;
  await addWeight(db, 'p1', 5.8, '2026-08-03 09:00');
  sentAlt = [];
  await handleWeightModify(env, mkEvent(), { db, pet: await getPet(db, 'p1'), pets: [await getPet(db, 'p1'), await getPet(db, 'p2')], explicitPet: false, amount: 6, lineUserId: 'u1', ownerId: 'u1', smid: 'm1', baseUrl: '' });
  assert.ok(sentAlt.some((t) => t.includes('要修改哪隻貓')), `應請先選貓，實得 ${JSON.stringify(sentAlt)}`);
  // 沒有新增任何體重、也沒改動
  const n = db.prepare("SELECT COUNT(*) c FROM logs WHERE category='weight'").bind().first().c;
  assert.equal(n, 1);
});
test('單貓＋「改6公斤」→ 顯示修改確認卡（有既有體重）', async () => {
  const db = seed(); env.DB = db;
  await addWeight(db, 'p1', 5.8, '2026-08-03 09:00');
  sentAlt = [];
  await handleWeightModify(env, mkEvent(), { db, pet: await getPet(db, 'p1'), pets: [await getPet(db, 'p1')], explicitPet: false, amount: 6, lineUserId: 'u1', ownerId: 'u1', smid: 'm1', baseUrl: '' });
  assert.ok(sentAlt.some((t) => t.includes('要怎麼處理') && t.includes('5.8')), `應顯示確認卡含最近體重，實得 ${JSON.stringify(sentAlt)}`);
});
test('沒有既有體重時「改6公斤」→ 詢問是否記為今天（不假裝修改成功）', async () => {
  const db = seed(); env.DB = db;
  sentAlt = [];
  await showWeightModifyConfirm(env, mkEvent(), { db, pet: await getPet(db, 'p1'), amount: 6, smid: 'm1' });
  assert.ok(sentAlt.some((t) => t.includes('還沒有體重紀錄') && t.includes('記為今天')), `應詢問是否新增，實得 ${JSON.stringify(sentAlt)}`);
});

// ── 五、資料一致性（測試 17、18、19、20）─────────────────────────
test('修改最新體重 → 保留原日期、pets 目前體重同步、不新增 log（測試 17/18）', async () => {
  const db = seed(); env.DB = db;
  const w = await addWeight(db, 'p1', 5.8, '2026-08-03 09:00');
  const res = await applyWeightModify(db, { logId: w.logId, amount: 6, ownerId: 'u1', actorId: 'u1' });
  assert.equal(res.ok, true);
  const after = await getLog(db, w.logId);
  assert.equal(after.amount, 6, '同一筆 amount 改為 6');
  assert.equal(String(after.eventDateTime), '2026-08-03 09:00', '原日期保留');
  assert.equal((await getPet(db, 'p1')).weightKg, 6, 'pets 目前體重同步');
  const n = db.prepare("SELECT COUNT(*) c FROM logs WHERE category='weight' AND isDeleted=0").bind().first().c;
  assert.equal(n, 1, '不新增第二筆');
});
test('修改較舊體重 → pets 目前體重仍取最新那筆，不被舊值蓋掉（測試 17 延伸）', async () => {
  const db = seed(); env.DB = db;
  const older = await addWeight(db, 'p1', 5.8, '2026-08-01 09:00');
  await addWeight(db, 'p1', 5.5, '2026-08-04 09:00'); // 最新
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.5);
  await applyWeightModify(db, { logId: older.logId, amount: 6.9, ownerId: 'u1', actorId: 'u1' }); // 改的是舊那筆
  assert.equal((await getPet(db, 'p1')).weightKg, 5.5, '目前體重仍為最新的 5.5，不被舊紀錄 6.9 蓋掉');
});
test('刪除最新體重 → pets 目前體重回退上一筆未刪除體重（測試 19）', async () => {
  const db = seed(); env.DB = db;
  await addWeight(db, 'p1', 5.8, '2026-08-01 09:00');
  const latest = await addWeight(db, 'p1', 5.5, '2026-08-04 09:00');
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.5);
  await softDeleteLog(db, latest.logId, 'u1');
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.8, '回退到 5.8');
  const last = await getLatestWeightLog(db, 'p1');
  assert.equal(last.amount, 5.8);
});
test('沒有任何體重紀錄時 resync 不歸零（沿用安全規則）', async () => {
  const db = seed(); env.DB = db; // pets.weightKg 起始 5.8
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.8, '無 weight log 時保留原值、不歸零');
});
test('重複確認「記為今天」不得重複新增（冪等，測試 20）', async () => {
  const db = seed(); env.DB = db;
  const r1 = await applyWeightAddToday(db, { petId: 'p1', amount: 6, smid: 'm1', ownerId: 'u1', actorId: 'u1', nowDateTime: '2026-08-05 10:00' });
  assert.equal(r1.ok, true);
  const r2 = await applyWeightAddToday(db, { petId: 'p1', amount: 6, smid: 'm1', ownerId: 'u1', actorId: 'u1', nowDateTime: '2026-08-05 10:00' });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'dup');
  const n = db.prepare("SELECT COUNT(*) c FROM logs WHERE category='weight' AND isDeleted=0").bind().first().c;
  assert.equal(n, 1, '只建一筆');
});
test('重複確認「改成 Xkg」不得改兩次或多記（冪等，測試 20）', async () => {
  const db = seed(); env.DB = db;
  const w = await addWeight(db, 'p1', 5.8, '2026-08-03 09:00');
  await applyWeightModify(db, { logId: w.logId, amount: 6, ownerId: 'u1', actorId: 'u1' });
  await applyWeightModify(db, { logId: w.logId, amount: 6, ownerId: 'u1', actorId: 'u1' }); // 重複點
  assert.equal((await getLog(db, w.logId)).amount, 6);
  const n = db.prepare("SELECT COUNT(*) c FROM logs WHERE category='weight' AND isDeleted=0").bind().first().c;
  assert.equal(n, 1, '仍只有一筆');
});
test('不得修改其他家庭／其他貓的體重（ownerId 不符時拒絕）', async () => {
  const db = seed(); env.DB = db;
  const w = await addWeight(db, 'p1', 5.8, '2026-08-03 09:00');
  const res = await applyWeightModify(db, { logId: w.logId, amount: 6, ownerId: 'someone-else', actorId: 'someone-else' });
  assert.equal(res.ok, false); assert.equal(res.reason, 'not_found');
  assert.equal((await getLog(db, w.logId)).amount, 5.8, '未被改動');
});

// ── 部署前查核一：裸公斤貓名護欄 ──────────────────────────────
test('裸公斤護欄：不存在的貓名（小黑6公斤）→ leadingUnknown（不默默記預設貓、不建新貓）', () => {
  const l = analyzeLeading('小黑6公斤', ['炭吉', '蚵仔']);
  assert.equal(l.kind, 'leadingUnknown', '應問要記哪隻貓');
  assert.equal(l.prefix, '小黑');
  // 整句不會被當成一筆可直接落地的體重 record
  assert.notEqual(parseMessage('小黑6公斤').type, 'record');
});
test('裸公斤護欄：食物類型前綴（乾糧6公斤／罐頭6公斤）→ 維持食物、絕不當體重', () => {
  for (const s of ['乾糧6公斤', '罐頭6公斤']) {
    assert.equal(analyzeLeading(s, ['炭吉', '蚵仔']).kind, 'clean', `${s} 不應被當成選貓/不明前綴`);
    const r = parseMessage(s);
    assert.equal(r.type, 'record'); assert.equal(r.record.category, 'food', `${s} 應為食物`);
  }
});
test('裸公斤護欄：存在的貓名（炭吉6公斤）剝名後 → 體重 record', () => {
  const l = analyzeLeading('炭吉6公斤', ['炭吉', '蚵仔']);
  assert.equal(l.kind, 'named'); assert.equal(l.petName, '炭吉');
  assert.equal(parseMessage(l.rest).record.category, 'weight');
});

// ── 部署前查核二：最近一筆依 eventDateTime 排序（非 updatedAt/UUID）──
test('同一天多筆體重：最近一筆＝事件時間最晚那筆（18:00），非最後被編輯', async () => {
  const db = seed(); env.DB = db;
  const am = await addWeight(db, 'p1', 4.2, '2026-08-05 09:00');
  const pm = await addWeight(db, 'p1', 4.3, '2026-08-05 18:00');
  assert.equal((await getLatestWeightLog(db, 'p1')).logId, pm.logId, '18:00 那筆才是最近一次');
  // 修改「較早的 09:00」那筆 → updatedAt 變新，但最近一筆仍應是 18:00（證明依 eventDateTime 排序）
  await applyWeightModify(db, { logId: am.logId, amount: 4.5, ownerId: 'u1', actorId: 'u1' });
  assert.equal((await getLatestWeightLog(db, 'p1')).logId, pm.logId, '改舊紀錄後最近一筆仍為 18:00，不被 updatedAt 影響');
  assert.equal((await getPet(db, 'p1')).weightKg, 4.3, '目前體重取最新 18:00 的 4.3，不是剛編輯的 4.5');
});

// ── 部署前查核三：批次刪除（含體重）也要 resync ──────────────────
test('批次刪除（applyUndo）含體重最新那筆 → 目前體重回退上一筆', async () => {
  const db = seed(); env.DB = db;
  await addWeight(db, 'p1', 5.8, '2026-08-01 09:00');
  const latest = await addWeight(db, 'p1', 5.5, '2026-08-04 09:00');
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.5);
  // 模擬「刪除這次 N 筆」把最新體重納入批次刪除
  await applyUndo(db, [await getLog(db, latest.logId)], 'u1');
  assert.equal((await getPet(db, 'p1')).weightKg, 5.8, 'applyUndo 後目前體重回退到 5.8');
});

// ── 體重顯示精度：4.27 不得被四捨五入成 4.3（規格補測試 1–15）──────────
test('formatWeightKg：最多兩位、去尾端 0、不降精度（4/4.2/4.20/4.27/4.25）', () => {
  assert.equal(formatWeightKg(4), '4');
  assert.equal(formatWeightKg(4.2), '4.2');
  assert.equal(formatWeightKg(4.20), '4.2');
  assert.equal(formatWeightKg(4.27), '4.27');
  assert.equal(formatWeightKg(4.25), '4.25');
  assert.equal(formatWeightKg('4.27'), '4.27');
});
test('解析：蚵仔體重4.27 → 記 4.27；蚵仔改4.27公斤 → weightModify 4.27（精度不丟）', () => {
  assert.equal(isWeightAdd('體重4.27'), 4.27);
  assert.equal(isWeightAdd('體重4.20'), 4.2);
  const m = parseMessage('改4.27公斤');
  assert.equal(m.type, 'weightModify'); assert.equal(m.amount, 4.27);
});
test('新增 4.27：log.amount＝4.27、pets.weightKg＝4.27（DB 存完整小數）', async () => {
  const db = seed(); env.DB = db;
  const res = await applyWeightAddToday(db, { petId: 'p1', amount: 4.27, smid: 'm9', ownerId: 'u1', actorId: 'u1', nowDateTime: '2026-08-05 10:00' });
  assert.equal(res.ok, true);
  assert.equal((await getLog(db, res.saved.logId)).amount, 4.27, 'log.amount 保存 4.27');
  assert.equal((await getPet(db, 'p1')).weightKg, 4.27, 'pets.weightKg 同步 4.27');
});
test('LINE 新增成功卡顯示 4.27kg（不出現 4.3）', () => {
  const card = weightAddedFlex({ pet: { petName: '蚵仔' }, amount: 4.27, logId: 'x', summary: null, date: '2026-08-05' });
  const s = JSON.stringify(card);
  assert.ok(s.includes('4.27'), '卡片應含 4.27');
  assert.ok(!s.includes('4.3'), '卡片不得出現四捨五入後的 4.3');
});
test('LINE 修改確認卡顯示完整小數（最近 4.27 / 目標 4.35）', () => {
  const card = weightModifyConfirmFlex({ pet: { petName: '蚵仔' }, amount: 4.35, latest: { amount: 4.27, eventDateTime: '2026-08-03 09:00' }, keys: 'amt=4.35' });
  const s = JSON.stringify(card);
  assert.ok(s.includes('4.27') && s.includes('4.35'), '確認卡應同時保留 4.27 與 4.35');
  assert.ok(!s.includes('4.3 ') && !s.includes('4.4'), '不得四捨五入');
});
test('今日紀錄用的 describeLog 規則＝formatWeightKg（4.27→4.27kg）', () => {
  // describeLog 內部已改用 formatWeightKg；此處驗規則本身，確保今日清單顯示 4.27
  assert.equal(`體重 ${formatWeightKg(4.27)}kg`, '體重 4.27kg');
});
test('回診摘要／A4：體重 4.27 顯示 4.27（不 4.3、不 4.20）', () => {
  const mk = (latest, count) => ({ petName: '蚵仔', rangeDays: 14, daily: [], weight: { latest, unit: 'kg', points: [{ date: '2026-08-01', value: latest }, { date: '2026-08-03', value: latest }, { date: '2026-08-05', value: latest }], deltaPct: 0, count } });
  const h1 = buildA4Report(mk(4.27, 3)).html;
  assert.ok(h1.includes('4.27'), 'A4 應顯示 4.27');
  assert.ok(!h1.includes('4.3<'), 'A4 不得顯示 4.3');
  const h2 = buildA4Report(mk(4.2, 3)).html;
  assert.ok(h2.includes('4.2<') && !h2.includes('4.20'), 'A4 顯示 4.2 而非 4.20');
  const h3 = buildA4Report(mk(4, 3)).html;
  assert.ok(h3.includes('4<') && !h3.includes('4.00'), 'A4 顯示 4 而非 4.00');
});
test('修改成 4.27 後不得變 4.3；刪除最新後回退值也保留兩位小數', async () => {
  const db = seed(); env.DB = db;
  const older = await addWeight(db, 'p1', 4.05, '2026-08-01 09:00');
  const latest = await addWeight(db, 'p1', 5.0, '2026-08-04 09:00');
  await resyncPetWeight(db, 'p1');
  // 修改最新為 4.27
  await applyWeightModify(db, { logId: latest.logId, amount: 4.27, ownerId: 'u1', actorId: 'u1' });
  assert.equal((await getLog(db, latest.logId)).amount, 4.27);
  assert.equal((await getPet(db, 'p1')).weightKg, 4.27, '修改後目前體重 4.27，不是 4.3');
  // 刪除最新 → 回退到 older 4.05（兩位小數完整）
  await softDeleteLog(db, latest.logId, 'u1');
  await resyncPetWeight(db, 'p1');
  assert.equal((await getPet(db, 'p1')).weightKg, 4.05, '回退值保留 4.05');
  assert.equal(formatWeightKg((await getPet(db, 'p1')).weightKg), '4.05');
});
