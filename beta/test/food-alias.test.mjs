// 家庭「口語別名」＝家裡習慣的叫法（肉→罐頭、小藍罐→某品項）。存 app_kv，不改 schema/food_items。
//  - alias→foodType 沿用 defaultFood/generic/粗估；alias→foodItem 直接套品牌實際熱量。
//  - 每次 server 端重新驗證（失效/跨家庭不套）；刪除/修改即時生效；保留詞不得建立別名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, isAskableFoodName } from '../src/parser.js';
import { handleRecord } from '../src/index.js';
import {
  createPet, createFoodItem, setDefaultFood, getFood,
  setFoodAlias, getFoodAlias, deleteFoodAlias, resolveFoodAlias, listFoodAliases, normalizeAliasKey
} from '../src/db.js';

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
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'X', text: '' } });
function capture() { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); }
async function seed(owner = 'u1') { const db = new D1(); await createPet(db, owner, { petName: '蚵仔' }); const pet = db.prepare('SELECT * FROM pets WHERE petName=?').bind('蚵仔').first(); return { db, pet }; }
// 模擬 item_lookup 命中家庭別名後，handler 會用什麼 record 呼叫 handleRecord
async function recordViaAlias(db, pet, owner, itemName, amount) {
  const a = await resolveFoodAlias(db, owner, itemName);
  if (!a) return { asked: isAskableFoodName(itemName) };
  const rec = a.kind === 'foodItem'
    ? { category: 'food', foodType: a.food.foodType, itemName: a.food.displayName, amount, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '' }
    : { category: 'food', foodType: a.foodType, itemName: '', amount, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '' };
  const res = await handleRecord({ DB: db }, mkEvent(), pet, rec, owner, { actorId: owner });
  return { res, alias: a };
}

test('A alias→foodType：肉→罐頭；肉5／肉 5／肉5克 都記成罐頭 5g（generic，無預設）', async () => {
  const { db, pet } = await seed(); capture();
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  // 各種空格都對到同一把 key，itemName 一律是「肉」
  for (const txt of ['肉5', '肉 5', '肉5克', '肉 5 g']) assert.equal(parseMessage(txt).itemName, '肉', `「${txt}」itemName=肉`);
  assert.equal(normalizeAliasKey('肉 '), normalizeAliasKey('肉'));
  const { res } = await recordViaAlias(db, pet, 'u1', '肉', 5);
  assert.equal(res.savedLog.foodType, '罐頭');
  assert.equal(res.savedLog.amount, 5);
  assert.equal(res.savedLog.foodId, '', 'generic：不綁品牌');
  assert.equal(res.savedLog.kcal, 4.5, '5×0.9 粗估');
});

test('B alias→foodType ＋ defaultFood：肉→罐頭、預設罐頭=天然密碼 → 肉5＝天然密碼、品牌熱量', async () => {
  const { db, pet } = await seed(); capture();
  const natural = await createFoodItem(db, 'u1', { displayName: '天然密碼', foodType: '罐頭', kcalPerGram: 1.2 });
  await setDefaultFood(db, 'u1', '罐頭', natural.foodId);
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  const { res } = await recordViaAlias(db, pet, 'u1', '肉', 5);
  assert.equal(res.savedLog.foodId, natural.foodId, '套用預設品項');
  assert.equal(res.savedLog.kcal, 6, '5×1.2 品牌熱量');
});

test('C alias→foodType 無預設：肉→罐頭 → generic 罐頭、0.9 粗估', async () => {
  const { db, pet } = await seed(); capture();
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  const { res } = await recordViaAlias(db, pet, 'u1', '肉', 10);
  assert.equal(res.savedLog.foodId, '');
  assert.equal(res.savedLog.kcal, 9, '10×0.9');
});

test('D alias→foodItem：小藍罐→巔峰羊 foodId → 小藍罐35 直接套品牌熱量', async () => {
  const { db, pet } = await seed(); capture();
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '罐頭', kcalPerGram: 1.5 });
  await setFoodAlias(db, 'u1', '小藍罐', { targetType: 'foodItem', value: peak.foodId });
  const a = await resolveFoodAlias(db, 'u1', '小藍罐');
  assert.equal(a.kind, 'foodItem'); assert.equal(a.food.foodId, peak.foodId);
  const { res } = await recordViaAlias(db, pet, 'u1', '小藍罐', 35);
  assert.equal(res.savedLog.foodId, peak.foodId);
  assert.equal(res.savedLog.kcal, 52.5, '35×1.5');
});

test('E 失效 foodItem alias：品項已刪／不存在 → resolveFoodAlias 回 null（安全 fallback，不用別家）', async () => {
  const { db, pet } = await seed(); capture();
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '罐頭', kcalPerGram: 1.5 });
  await setFoodAlias(db, 'u1', '小藍罐', { targetType: 'foodItem', value: peak.foodId });
  db.prepare('UPDATE food_items SET isDeleted=1 WHERE foodId=?').bind(peak.foodId).run();
  assert.equal(await resolveFoodAlias(db, 'u1', '小藍罐'), null, '已刪品項 → 不套用');
  // 不存在的 foodId
  await setFoodAlias(db, 'u1', '幽靈', { targetType: 'foodItem', value: 'no-such-id' });
  assert.equal(await resolveFoodAlias(db, 'u1', '幽靈'), null);
});

test('E2 跨家庭 foodItem：別家的 foodId 當作 alias target → 不得套用', async () => {
  const { db } = await seed('u1');
  await createPet(db, 'u2', { petName: '別家貓' });
  const other = await createFoodItem(db, 'u2', { displayName: '別家罐', foodType: '罐頭', kcalPerGram: 1.1 });
  await setFoodAlias(db, 'u1', '偷', { targetType: 'foodItem', value: other.foodId }); // u1 指到 u2 的品項
  assert.equal(await resolveFoodAlias(db, 'u1', '偷'), null, '跨家庭 foodId → null');
});

test('F 不同家庭別名互不干擾：A 家肉→罐頭，B 家沒設 → B 家「肉」無別名', async () => {
  const { db } = await seed('u1');
  await createPet(db, 'u2', { petName: '珍珠' });
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  assert.ok(await resolveFoodAlias(db, 'u1', '肉'), 'A 家有');
  assert.equal(await resolveFoodAlias(db, 'u2', '肉'), null, 'B 家不得套 A 家別名');
});

test('G 刪除別名：肉→罐頭 刪掉後，肉 不再有 mapping（但變回「可詢問」）', async () => {
  const { db } = await seed();
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  await deleteFoodAlias(db, 'u1', '肉');
  assert.equal(await resolveFoodAlias(db, 'u1', '肉'), null);
  assert.equal(isAskableFoodName('肉'), true, '刪除後回到第一次未知 → 可再問');
});

test('H 修改別名：肉 原=罐頭 → 改=主食罐，後續用新對應', async () => {
  const { db } = await seed();
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '主食罐' });
  const a = await resolveFoodAlias(db, 'u1', '肉');
  assert.equal(a.foodType, '主食罐');
  const list = await listFoodAliases(db, 'u1');
  assert.equal(list.length, 1, '同一叫法只留一筆（覆蓋）');
  assert.equal(list[0].alias, '肉'); assert.equal(list[0].displayTarget, '主食罐');
});

test('listFoodAliases：foodItem 顯示品項名並標示有效；壞掉的 foodType 標無效', async () => {
  const { db } = await seed();
  const peak = await createFoodItem(db, 'u1', { displayName: '巔峰羊', foodType: '罐頭', kcalPerGram: 1.5 });
  await setFoodAlias(db, 'u1', '小藍罐', { targetType: 'foodItem', value: peak.foodId });
  await setFoodAlias(db, 'u1', '飯飯', { targetType: 'foodType', value: '乾糧' });
  const list = await listFoodAliases(db, 'u1');
  const byAlias = Object.fromEntries(list.map((x) => [x.alias, x]));
  assert.equal(byAlias['小藍罐'].displayTarget, '巔峰羊'); assert.equal(byAlias['小藍罐'].valid, true);
  assert.equal(byAlias['飯飯'].displayTarget, '乾糧'); assert.equal(byAlias['飯飯'].valid, true);
});

// §24 首次未知叫法：記住 vs 這次而已
test('§24 首次未知：無別名時可詢問；「這次而已」不存別名、「記住」才寫入', async () => {
  const { db, pet } = await seed(); capture();
  assert.equal(await resolveFoodAlias(db, 'u1', '肉'), null, '一開始沒有別名');
  assert.equal(isAskableFoodName('肉'), true, '→ 會問「肉是指什麼」');
  // 這次而已：直接記罐頭 5，不寫別名
  await handleRecord({ DB: db }, mkEvent(), pet, { category: 'food', foodType: '罐頭', itemName: '', amount: 5, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '' }, 'u1', { actorId: 'u1' });
  assert.equal(await getFoodAlias(db, 'u1', '肉'), null, '「這次而已」不保存別名');
  // 記住：寫入別名，之後直接對應
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  assert.equal((await resolveFoodAlias(db, 'u1', '肉')).foodType, '罐頭');
});

// §25 負向：保留詞不得成為可詢問的食物叫法；食物類型＋數字仍是新增紀錄
test('§25 負向：今天35／體重35／喝水30／藥35／最近30／嘔吐 不得當叫法；主食3／乾乾5 仍是紀錄', async () => {
  for (const n of ['今天', '體重', '喝水', '水', '藥', '最近', '嘔吐', '紀錄', '記錄']) {
    assert.equal(isAskableFoodName(n), false, `「${n}」不可當食物叫法`);
  }
  assert.equal(parseMessage('主食3').type, 'record');
  assert.equal(parseMessage('乾乾5').type, 'record');
  assert.equal(parseMessage('喝水30').record.category, 'water');
  assert.equal(parseMessage('體重35').record.category, 'weight');
  assert.equal(parseMessage('嘔吐3次').record.category, 'vomit');
});
