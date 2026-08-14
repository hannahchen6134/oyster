// 每個 foodType 的「家庭預設品項」（照護站顯式設定，存 app_kv；不改 schema、不動 food_items）。
// LINE 記錄優先序：①句中明確品牌 > ②家庭該類型預設 > ③該類型唯一品項 > ④多品項確認卡 > ⑤系統預設/未知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { handleRecord } from '../src/index.js';
import {
  createPet, createFoodItem, getFood, softDeleteLog,
  getDefaultFoodId, setDefaultFood, clearDefaultFood, resolveDefaultFood, listDefaultFoods
} from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// app_kv 由 migration 建立（不在 schema.sql）；預設品項存這裡，測試需一併套用該 migration。
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

async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}
// 用 parseMessage 產生 record，再交 handleRecord（＝真實 LINE 流程），回傳這次寫入的食物 log（若有）。
async function logText(db, pet, text) {
  const intent = parseMessage(text);
  assert.equal(intent.type, 'record', `「${text}」應解析為 record，實得 ${intent.type}`);
  const res = await handleRecord({ DB: db }, mkEvent(), pet, intent.record, 'u1', { actorId: 'u1' });
  return res;
}
function foodLogs(db) {
  return db.prepare("SELECT * FROM logs WHERE category='food' AND isDeleted=0 ORDER BY createdAt").bind().all().results;
}

test('A 設定預設：setDefaultFood 正確保存 foodId，listDefaultFoods 讀得到', async () => {
  const { db } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  assert.equal(await getDefaultFoodId(db, 'u1', '乾糧'), hill.foodId);
  assert.deepEqual(await listDefaultFoods(db, 'u1', ['乾糧', '主食罐']), { '乾糧': hill.foodId });
});

test('B 極簡紀錄：設希爾斯為預設後，乾乾1/乾糧1/乾糧 1/乾乾    1 全部套希爾斯、kcal=3.8、estimated=false', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  for (const t of ['乾乾1', '乾糧1', '乾糧 1', '乾乾    1']) {
    const res = await logText(db, pet, t);
    const log = await getFood(db, res.savedLog.foodId);
    assert.equal(res.savedLog.foodId, hill.foodId, `「${t}」應套希爾斯 foodId`);
    assert.equal(res.savedLog.foodType, '乾糧');
    assert.equal(res.savedLog.amount, 1);
    assert.equal(res.savedLog.kcal, 3.8, `「${t}」kcal 應為品牌 3.8（非 3.7 粗估）`);
    assert.ok(log && log.foodId === hill.foodId);
  }
});

test('C 品牌明確輸入優先：預設=希爾斯，但「皇家乾糧1」必須用皇家', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  const res = await logText(db, pet, '皇家乾糧1');
  assert.equal(res.savedLog.foodId, royal.foodId, '句中明確品牌 > 預設');
  assert.equal(res.savedLog.kcal, 3.6);
});

test('D 切換預設：希爾斯 → 皇家後，乾乾1 直接用皇家', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  await setDefaultFood(db, 'u1', '乾糧', royal.foodId); // 直接取代，不需先取消
  const res = await logText(db, pet, '乾乾1');
  assert.equal(res.savedLog.foodId, royal.foodId);
});

test('E 取消預設：清掉後有兩個乾糧品項 → 乾乾1 直接記 generic（不出確認卡、不猜品牌）', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  await clearDefaultFood(db, 'u1', '乾糧');
  assert.equal(await getDefaultFoodId(db, 'u1', '乾糧'), '');
  const res = await logText(db, pet, '乾乾1');
  assert.ok(!(res && res.disambiguated), '純類型輸入無預設 → 不出確認卡');
  assert.equal(res.savedLog.foodId, '', 'generic：不綁品牌');
  assert.equal(res.savedLog.kcal, 3.7, '用系統乾糧粗估 3.7');
  assert.equal(foodLogs(db).length, 1, '直接完成一筆 generic 紀錄');
});

test('F 單一品項、無預設：乾乾1 記 generic（不自動套唯一品項；自動帶品牌只由預設負責）', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const res = await logText(db, pet, '乾乾1');
  assert.ok(!(res && res.disambiguated));
  assert.equal(res.savedLog.foodId, '', '沒明確品牌／沒預設 → 不猜品項');
  assert.equal(res.savedLog.kcal, 3.7);
});

test('G 系統預設 fallback：沒預設、沒有任何乾糧品項 → 乾乾1 用 3.7、estimated（foodId 空）', async () => {
  const { db, pet } = await seed();
  const res = await logText(db, pet, '乾乾1');
  assert.equal(res.savedLog.foodId, '', '沒有品項 → 不綁 foodId');
  assert.equal(res.savedLog.kcal, 3.7, '用系統乾糧預設 3.7');
});

test('H 失效預設：app_kv 指向已刪品項 → 不套用、走 generic（不猜其他品項）', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  // 直接把預設品項標記刪除（模擬失效）
  db.prepare('UPDATE food_items SET isDeleted = 1 WHERE foodId = ?').bind(hill.foodId).run();
  assert.equal(await resolveDefaultFood(db, 'u1', '乾糧'), null, '失效預設 → 視為沒設定');
  const res = await logText(db, pet, '乾乾1');
  assert.equal(res.savedLog.foodId, '', '失效預設又沒明確品牌 → generic，不改套皇家');
  assert.equal(res.savedLog.kcal, 3.7);
});

test('I 跨家庭：A 家 app_kv 不得套用到 B 家（resolveDefaultFood 以 owner scope 驗證）', async () => {
  const { db } = await seed();
  const aFood = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await setDefaultFood(db, 'u1', '乾糧', aFood.foodId);
  // B 家（u2）用同一 foodId 查 → 必須拿不到（跨家庭）
  assert.equal(await resolveDefaultFood(db, 'u2', '乾糧'), null);
  // 即使 u2 的 app_kv 被塞了 A 家 foodId，resolveDefaultFood 仍以品項的 ownerLineUserId 擋掉
  await setDefaultFood(db, 'u2', '乾糧', aFood.foodId);
  assert.equal(await resolveDefaultFood(db, 'u2', '乾糧'), null, '品項 owner≠u2 → 不得套用');
});

test('J 不同類型獨立：預設乾糧=希爾斯、主食罐=巔峰羊 → 乾乾3 用希爾斯、主食3 用巔峰羊', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '主食罐', kcalPerGram: 1.2 });
  // 另各補一個同類型品項，確保不是靠「唯一品項」而是靠預設
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await createFoodItem(db, 'u1', { displayName: '喜倍', foodType: '主食罐', kcalPerGram: 1.0 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  await setDefaultFood(db, 'u1', '主食罐', peak.foodId);
  assert.equal((await logText(db, pet, '乾乾3')).savedLog.foodId, hill.foodId);
  assert.equal((await logText(db, pet, '主食3')).savedLog.foodId, peak.foodId);
});

test('K food_items 資料不變：設定／切換／取消預設前後，品項欄位完全一致', async () => {
  const { db } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const snap = () => JSON.stringify(db.prepare('SELECT foodId, brand, productName, displayName, foodType, kcalPerGram, isDeleted FROM food_items ORDER BY foodId').bind().all().results);
  const before = snap();
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  await setDefaultFood(db, 'u1', '乾糧', royal.foodId);
  await clearDefaultFood(db, 'u1', '乾糧');
  assert.equal(snap(), before, '設定/切換/取消預設不得改動任何 food_items 欄位');
});
