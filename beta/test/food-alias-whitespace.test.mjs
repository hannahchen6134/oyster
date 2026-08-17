// Regression：家庭別名「肉→罐頭」對空格數量／半形全形空白／克/g 單位必須完全等價（沿用既有 normalization）。
//  - 已設定：七種寫法 parse＋resolve＋amount 一致。
//  - 未設定：所有寫法都走同一個「肉是指什麼？」安全詢問（isAskableFoodName＋item_lookup，不會有的問有的 unknown）。
//  - 有 defaultFood：所有寫法套到同一個 default foodId。
//  - 不破壞既有食物類型輸入；保留詞不得成為食物別名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, isAskableFoodName } from '../src/parser.js';
import { handleRecord } from '../src/index.js';
import { createPet, createFoodItem, setDefaultFood, setFoodAlias, resolveFoodAlias } from '../src/db.js';

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
async function seed() { const db = new D1(); await createPet(db, 'u1', { petName: '蚵仔' }); const pet = db.prepare('SELECT * FROM pets WHERE petName=?').bind('蚵仔').first(); return { db, pet }; }

// 半形空格、雙空格、全形空格（　）、克、g —— 全部應等價
const MEAT_VARIANTS = ['肉5', '肉 5', '肉  5', '肉　5', '肉5克', '肉 5 克', '肉5g', '肉 5 g'];

// 記錄一次別名輸入（模擬 item_lookup 命中家庭 foodType 別名後 handler 建的 record）
async function recordViaFoodTypeAlias(db, pet, itemName, amount) {
  const a = await resolveFoodAlias(db, 'u1', itemName);
  assert.ok(a && a.kind === 'foodType', 'should resolve to a foodType alias');
  return handleRecord({ DB: db }, mkEvent(), pet, {
    category: 'food', foodType: a.foodType, itemName: '', amount, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: ''
  }, 'u1', { actorId: 'u1' });
}

test('1 已設定 肉→罐頭：七種空格寫法 parse 全等價（item=肉、amount=5、item_lookup）', () => {
  for (const v of MEAT_VARIANTS) {
    const r = parseMessage(v);
    assert.equal(r.type, 'item_lookup_candidate', `「${v}」應走 item_lookup`);
    assert.equal(r.itemName, '肉', `「${v}」itemName=肉`);
    assert.equal(r.amount, 5, `「${v}」amount=5`);
    assert.equal(r.unit, 'g', `「${v}」unit=g`);
  }
});

test('1b 已設定 肉→罐頭：每種寫法 resolve＋記錄結果一致（罐頭 generic 5g / 4.5 kcal）', async () => {
  for (const v of MEAT_VARIANTS) {
    const { db, pet } = await seed(); capture();
    await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
    const r = parseMessage(v); // 取得 normalize 後的 itemName/amount
    const res = await recordViaFoodTypeAlias(db, pet, r.itemName, r.amount);
    assert.equal(res.savedLog.foodType, '罐頭', `「${v}」→ 罐頭`);
    assert.equal(res.savedLog.amount, 5, `「${v}」→ 5g`);
    assert.equal(res.savedLog.foodId, '', `「${v}」→ generic`);
    assert.equal(res.savedLog.kcal, 4.5, `「${v}」→ 5×0.9 粗估`);
  }
});

test('2 未設定 肉：所有寫法都走同一個安全詢問（可 ask＋item_lookup，不會有的問有的 unknown）', async () => {
  const { db } = await seed();
  for (const v of MEAT_VARIANTS) {
    const r = parseMessage(v);
    assert.equal(r.type, 'item_lookup_candidate', `「${v}」統一走 item_lookup`);
    assert.equal(r.itemName, '肉');
    assert.equal(await resolveFoodAlias(db, 'u1', r.itemName), null, `「${v}」未設定→無別名`);
    assert.equal(isAskableFoodName(r.itemName), true, `「${v}」→ 會問「肉是指什麼」`);
  }
});

test('3 已設定 肉→罐頭 且有 defaultFood 罐頭：所有寫法套同一個 default foodId', async () => {
  const { db, pet } = await seed(); capture();
  const natural = await createFoodItem(db, 'u1', { displayName: '天然密碼', foodType: '罐頭', kcalPerGram: 1.2 });
  await setDefaultFood(db, 'u1', '罐頭', natural.foodId);
  await setFoodAlias(db, 'u1', '肉', { targetType: 'foodType', value: '罐頭' });
  for (const v of MEAT_VARIANTS) {
    const r = parseMessage(v);
    const res = await recordViaFoodTypeAlias(db, pet, r.itemName, r.amount);
    assert.equal(res.savedLog.foodId, natural.foodId, `「${v}」→ 同一 default foodId`);
    assert.equal(res.savedLog.kcal, 6, `「${v}」→ 5×1.2`);
  }
});

test('4 不破壞既有食物類型輸入：乾乾5／乾乾 5／罐罐5／主食3／副食3 仍是 record', () => {
  const cases = [['乾乾5', '乾糧', 5], ['乾乾 5', '乾糧', 5], ['罐罐5', '罐頭', 5], ['主食3', '主食罐', 3], ['副食3', '副食罐', 3]];
  for (const [txt, ft, amt] of cases) {
    const r = parseMessage(txt);
    assert.equal(r.type, 'record', `「${txt}」仍是 record`);
    assert.equal(r.record.foodType, ft, `「${txt}」→ ${ft}`);
    assert.equal(r.record.amount, amt);
  }
});

test('5 保留詞不得當食物別名：今天5／體重5／喝水5／藥5 不進「肉是指什麼」流程', () => {
  // 今天5：非食物；體重5/喝水5/藥5：各自類別或非可問食物
  assert.equal(isAskableFoodName('今天'), false);
  assert.equal(isAskableFoodName('體重'), false);
  assert.equal(isAskableFoodName('喝水'), false);
  assert.equal(isAskableFoodName('藥'), false);
  // 體重5→體重、喝水5→喝水、藥5→用藥；今天5→非 record（不會被當食物別名候選）
  assert.equal(parseMessage('體重5').record.category, 'weight');
  assert.equal(parseMessage('喝水5').record.category, 'water');
  assert.equal(parseMessage('藥5').record.category, 'med');
  assert.notEqual(parseMessage('今天5').type, 'record');
});
