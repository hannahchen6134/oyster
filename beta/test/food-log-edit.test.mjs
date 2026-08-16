// 從 LINE「吃過的食物」時間軸選一筆直接修改／刪除（§16 A–L）。
//  - 每筆帶 logId；改份量／改品牌／刪除都只針對該 logId，server 端每次重新驗證（存在／未刪／food／本家庭）。
//  - 改份量維持 served/leftover 一致；改品牌用該品項每克熱量重算並重算當日；generic 只有使用者主動點才補品牌。
//  - food_items 前後完全不變；跨家庭／非 food／已刪 logId 一律拒絕。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  loadEditableFoodLog, reconcileServedOnSet, applyLogAmountEdit, applyFoodBrandChange
} from '../src/index.js';
import { foodTimelineFlex, foodEditMenuFlex, foodBrandPickFlex } from '../src/flex.js';
import {
  createPet, createFoodItem, insertLog, softDeleteLog, getLog, getFoodTimeline, recomputeDay, getSummaries
} from '../src/db.js';
import { taipeiToday, addDays } from '../src/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...a) { this.params = a.map(norm); return this; }
  run() { const i = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
  first() { return this.sdb.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.sdb.prepare(this.sql).all(...this.params) }; }
}
class D1 { constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); } prepare(s) { return new Stmt(this.sdb, s); } }

async function mkPet(db, owner, name) { await createPet(db, owner, { petName: name }); return db.prepare('SELECT * FROM pets WHERE petName=?').bind(name).first(); }
async function addFood(db, { owner = 'u1', petId, itemName = '', foodType, foodId = '', amount, daysAgo = 0, hm = '18:00', served = null, leftover = null }) {
  const log = await insertLog(db, {
    lineUserId: owner, petId, eventDateTime: `${addDays(taipeiToday(), -daysAgo)} ${hm}`, category: 'food',
    foodType, itemName, foodId, amount, unit: 'g', kcal: 0, recordedBy: owner, source: 'line', updatedBy: owner
  });
  if (served != null || leftover != null) db.prepare('UPDATE logs SET servedAmount=?, leftoverAmount=? WHERE logId=?').bind(served, leftover, log.logId).run();
  return getLog(db, log.logId);
}
const foodItemsSnapshot = (db) => JSON.stringify(db.prepare('SELECT foodId, brand, displayName, foodType, kcalPerGram, isDeleted FROM food_items ORDER BY foodId').bind().all().results);
const dayKcal = async (db, petId) => (await getSummaries(db, petId, addDays(taipeiToday(), -1), taipeiToday())).reduce((t, r) => t + Number(r.kcal || 0), 0);

test('A timeline 帶 logId：foodTimelineFlex 每筆「修改」postback 指向正確 logId', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const a = await addFood(db, { petId: pet.petId, itemName: '巔峰羊', foodType: '罐頭', amount: 35, daysAgo: 0, hm: '18:30' });
  const b = await addFood(db, { petId: pet.petId, itemName: '惜時雞', foodType: '罐頭', amount: 30, daysAgo: 1, hm: '19:10' });
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30 });
  assert.ok(rows.every((r) => r.logId), 'getFoodTimeline 每筆有 logId');
  const flex = foodTimelineFlex({ rows, petName: '蚵仔', label: '罐頭', range: '最近 30 天', siteUrl: 'https://x' });
  const json = JSON.stringify(flex);
  assert.ok(json.includes(`action=foodEdit&logId=${rows[0].logId}`), '第一筆修改指向自己的 logId');
  assert.ok(json.includes(`action=foodEdit&logId=${rows[1].logId}`), '第二筆修改指向自己的 logId');
  assert.equal(rows[0].logId, a.logId); assert.equal(rows[1].logId, b.logId);
});

test('B 改份量：希爾斯乾糧 5g → 8g，kcal 依每克熱量重算、當日重算', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const log = await addFood(db, { petId: pet.petId, foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  await recomputeDay(db, pet.petId, taipeiToday());
  const { updated, summary } = await applyLogAmountEdit(db, log, 8, 'u1');
  assert.equal(updated.amount, 8);
  assert.equal(updated.kcal, 30.4, '8×3.8=30.4');
  assert.equal(summary.kcal, 30.4, '當日摘要 kcal 已重算');
  assert.equal(await dayKcal(db, pet.petId), 30.4, 'daily_summary 落地 30.4');
});

test('C 剩食紀錄改份量：served=10、leftover=5、amount=5 → 改實吃 8 → served=10、leftover=2、amount=8', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const log = await addFood(db, { petId: pet.petId, itemName: '巔峰羊', foodType: '罐頭', amount: 5, served: 10, leftover: 5, daysAgo: 0 });
  const { updated } = await applyLogAmountEdit(db, log, 8, 'u1');
  assert.equal(updated.amount, 8);
  assert.equal(updated.servedAmount, 10, '保留原餵量 10');
  assert.equal(updated.leftoverAmount, 2, '剩餘＝10−8=2');
  // 純函式邊界：新實吃 > 原餵量 → 不造假原餵量、清剩食追蹤；無原餵量 → 不動
  assert.deepEqual(reconcileServedOnSet({ category: 'food', servedAmount: 10 }, 8), { servedAmount: 10, leftoverAmount: 2 });
  assert.deepEqual(reconcileServedOnSet({ category: 'food', servedAmount: 10 }, 12), { servedAmount: 0, leftoverAmount: 0 });
  assert.deepEqual(reconcileServedOnSet({ category: 'food', servedAmount: null }, 8), {});
});

test('D 改品牌：generic 乾糧 5g → 希爾斯 → foodId/類型/kcal 正確，且不建立 food_item', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const before = foodItemsSnapshot(db);
  const log = await addFood(db, { petId: pet.petId, foodId: '', itemName: '', foodType: '乾糧', amount: 5, daysAgo: 0 });
  assert.equal(log.foodId, '', '改之前是 generic（無品牌）');
  const { updated } = await applyFoodBrandChange(db, log, hill, 'u1');
  assert.equal(updated.foodId, hill.foodId, 'foodId=希爾斯');
  assert.equal(updated.foodType, '乾糧');
  assert.equal(updated.itemName, '希爾斯乾糧');
  assert.equal(updated.kcal, 19, '5×3.8=19（品牌實際熱量）');
  assert.equal(foodItemsSnapshot(db), before, 'food_items 不得新增／變更');
});

test('E 明確品牌改另一品牌：希爾斯 → 皇家，foodId/kcal 更新', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const log = await addFood(db, { petId: pet.petId, foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  const { updated } = await applyFoodBrandChange(db, log, royal, 'u1');
  assert.equal(updated.foodId, royal.foodId);
  assert.equal(updated.kcal, 18, '5×3.6=18');
});

test('F 刪除：soft delete → 時間軸不再顯示、當日摘要不再計入', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const log0 = await addFood(db, { petId: pet.petId, foodId: hill.foodId, foodType: '乾糧', amount: 10, daysAgo: 0 });
  const { updated: log } = await applyLogAmountEdit(db, log0, 10, 'u1'); // 落地 kcal＝10×3.8=38＋重算當日
  assert.equal(await dayKcal(db, pet.petId), 38, '刪除前 10×3.8=38');
  await softDeleteLog(db, log.logId, 'u1');
  await recomputeDay(db, pet.petId, taipeiToday());
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30 });
  assert.equal(rows.length, 0, '時間軸不再顯示已刪除');
  assert.equal(await dayKcal(db, pet.petId), 0, '當日摘要不再計入');
});

test('G 跨家庭 logId：B 家 log → loadEditableFoodLog 對 A 家 owner 回 null（拒絕）', async () => {
  const db = new D1();
  const petB = await mkPet(db, 'u2', '別家貓');
  const bLog = await addFood(db, { owner: 'u2', petId: petB.petId, foodType: '乾糧', amount: 9, daysAgo: 0 });
  assert.equal(await loadEditableFoodLog(db, bLog.logId, 'u1'), null, 'A 家不得載入 B 家的 log');
  assert.ok(await loadEditableFoodLog(db, bLog.logId, 'u2'), '本家庭可載入');
});

test('H 非 food log：喝水 logId → loadEditableFoodLog 回 null', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const water = await insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: `${taipeiToday()} 10:00`, category: 'water', amount: 30, unit: 'ml', waterMl: 30, recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
  assert.equal(await loadEditableFoodLog(db, water.logId, 'u1'), null, '喝水不是 food → 拒絕');
});

test('I 已刪除 log：不可再修改（loadEditableFoodLog 回 null）', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const log = await addFood(db, { petId: pet.petId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  await softDeleteLog(db, log.logId, 'u1');
  assert.equal(await loadEditableFoodLog(db, log.logId, 'u1'), null, '已刪除 → 不可再改');
});

test('J 多貓：改一隻貓的 log 不影響另一隻，petId 保持不變', async () => {
  const db = new D1();
  const a = await mkPet(db, 'u1', '蚵仔'); const b = await mkPet(db, 'u1', '珍珠');
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const la = await addFood(db, { petId: a.petId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  const lb = await addFood(db, { petId: b.petId, foodType: '乾糧', amount: 7, daysAgo: 0 });
  const { updated } = await applyFoodBrandChange(db, la, royal, 'u1');
  assert.equal(updated.petId, a.petId, '仍是蚵仔的 log');
  assert.equal((await getLog(db, lb.logId)).foodId, '', '珍珠那筆不受影響');
});

test('K generic 不被自動補品牌：只有主動 applyFoodBrandChange 才變 foodId', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const log = await addFood(db, { petId: pet.petId, foodId: '', foodType: '乾糧', amount: 5, daysAgo: 0 });
  // 只是讀時間軸／重算，不得自動補品牌
  await recomputeDay(db, pet.petId, taipeiToday());
  const rows = await getFoodTimeline(db, pet.petId, { sinceDays: 30 });
  assert.equal(rows[0].name, '乾糧', '讀取仍是 generic 類型，不猜品牌');
  assert.equal((await getLog(db, log.logId)).foodId, '', '未主動改品牌前 foodId 仍空');
  await applyFoodBrandChange(db, log, hill, 'u1');
  assert.equal((await getLog(db, log.logId)).foodId, hill.foodId, '使用者主動點才補品牌');
});

test('L food_items 不變：改歷史 log 前後 food_items row/brand/kcalPerGram 全不變', async () => {
  const db = new D1(); const pet = await mkPet(db, 'u1', '蚵仔');
  const hill = await createFoodItem(db, 'u1', { brand: '希爾斯', displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { brand: '皇家', displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const before = foodItemsSnapshot(db);
  const log = await addFood(db, { petId: pet.petId, foodId: hill.foodId, foodType: '乾糧', amount: 5, daysAgo: 0 });
  await applyLogAmountEdit(db, log, 8, 'u1');
  await applyFoodBrandChange(db, await getLog(db, log.logId), royal, 'u1');
  assert.equal(foodItemsSnapshot(db), before, '兩種修改後 food_items 完全不變');
});

test('選單／改品牌卡：不露 logId 給使用者、只列同類型品項、每顆綁 foodBrandSet', async () => {
  const menu = JSON.stringify(foodEditMenuFlex({ logId: 'L1', name: '希爾斯乾糧', whenLabel: '8/16 09:20', eatenText: '實吃 5g', siteUrl: 'https://x' }));
  assert.ok(menu.includes('action=editAmount&logId=L1') && menu.includes('action=foodBrandAsk&logId=L1') && menu.includes('action=delAsk&logId=L1'), '三個動作綁同一 logId');
  // 給使用者看的文字不出現 logId 字樣（postback data 內含屬正常，displayText/label 不得洩漏）
  const menuObj = foodEditMenuFlex({ logId: 'L1', name: '希爾斯乾糧', whenLabel: '8/16 09:20', eatenText: '實吃 5g', siteUrl: 'https://x' });
  const texts = JSON.stringify(menuObj.contents).match(/"text":"[^"]*"/g) || [];
  assert.ok(!texts.some((t) => t.includes('L1')), '可見文字不露 logId');

  const foods = [
    { foodId: 'f1', displayName: '希爾斯乾糧', foodType: '乾糧', isDeleted: 0 },
    { foodId: 'f2', displayName: '皇家乾糧', foodType: '乾糧', isDeleted: 0 }
  ];
  const pick = JSON.stringify(foodBrandPickFlex({ logId: 'L1', foodType: '乾糧', currentName: '乾糧', foods, siteUrl: 'https://x' }));
  assert.ok(pick.includes('action=foodBrandSet&logId=L1&foodId=f1') && pick.includes('action=foodBrandSet&logId=L1&foodId=f2'), '每款綁 foodBrandSet＋自己的 foodId');
});
