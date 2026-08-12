// 超口語食物別名 + 簡略調整語法：
//  1) 明確食物別名（主食／副食／乾乾／罐罐）＋正數 → 直接當克數記錄，foodType 明確不需再問。
//  2) 別名＋明確動詞（減／扣／減掉／減去）＋正數 → 直接 subtract（安全定位：唯一才執行、多筆確認）。
//  3) 別名＋「-」＋正數（無動詞）＝過度簡略 → possibleSubtract：先短確認、不直接改資料。
//  4) 空白數量完全不影響判斷（normalization 集中處理）；語意不明確者（3／主3／今天3／-3）不得直接建紀錄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { createPet, insertLog, getLog } from '../src/db.js';
import { handleFoodAdjust } from '../src/index.js';

// ───────────────────────── 純 parser 測試（無 DB）─────────────────────────

// 同一組不同空白版本必須產生「完全相同」的 parsed result（空白不得成為解析條件）
function assertAllEqual(inputs, label) {
  const results = inputs.map((x) => parseMessage(x));
  const base = JSON.stringify(results[0]);
  for (let i = 1; i < inputs.length; i++) {
    assert.equal(JSON.stringify(results[i]), base, `${label}：「${inputs[i]}」應與「${inputs[0]}」等價，實得 ${JSON.stringify(results[i])}`);
  }
  return results[0];
}

test('直接記錄：主食＋數字（各種空白等價）→ 主食罐 Ng', () => {
  const r = assertAllEqual(['主食3', '主食 3', '主食   3'], '主食3');
  assert.equal(r.type, 'record');
  assert.equal(r.record.foodType, '主食罐');
  assert.equal(r.record.amount, 3);
  assert.equal(r.record.unit, 'g');
});

test('直接記錄：副食／乾乾／罐罐＋數字（含各種空白）', () => {
  const fu = assertAllEqual(['副食3', '副食  3'], '副食3');
  assert.equal(fu.record.foodType, '副食罐');
  assert.equal(fu.record.amount, 3);
  const gan = assertAllEqual(['乾乾3', '乾乾   3'], '乾乾3');
  assert.equal(gan.record.foodType, '乾糧');
  assert.equal(gan.record.amount, 3);
  const guan = assertAllEqual(['罐罐40', '罐罐 40'], '罐罐40');
  assert.equal(guan.record.foodType, '罐頭');
  assert.equal(guan.record.amount, 40);
});

test('直接記錄：帶單位 g／克 各種空白全部等價（主食罐 3g）', () => {
  const r = assertAllEqual(['主食3', '主食3g', '主食 3 g', '主食3克', '主食 3 克'], '主食3+單位');
  assert.equal(r.record.foodType, '主食罐');
  assert.equal(r.record.amount, 3);
  assert.equal(r.record.unit, 'g');
});

test('subtract：別名＋明確動詞＋正數 → foodAdjust subtract confirm=false（空白等價）', () => {
  const cases = [
    { inputs: ['乾乾減5', '乾乾 減 5', '乾乾   減   5'], foodType: '乾糧', amount: 5 },
    { inputs: ['乾乾減5克'], foodType: '乾糧', amount: 5 },
    { inputs: ['主食扣3', '主食 扣 3'], foodType: '主食罐', amount: 3 },
    { inputs: ['副食減2', '副食減 2'], foodType: '副食罐', amount: 2 },
    { inputs: ['罐罐減10', '罐罐 扣 10'], foodType: '罐頭', amount: 10 }
  ];
  for (const c of cases) {
    for (const x of c.inputs) {
      const r = parseMessage(x);
      assert.equal(r.type, 'foodAdjust', `「${x}」應為 foodAdjust，實得 ${r.type}`);
      assert.equal(r.mode, 'subtract');
      assert.equal(r.confirm, false, `「${x}」有明確動詞 → 不需確認`);
      assert.equal(r.foodType, c.foodType, `「${x}」foodType`);
      assert.equal(r.amount, c.amount, `「${x}」amount`);
    }
  }
});

test('subtract：完整名稱仍維持（乾糧／主食罐／副食罐／罐頭 減 N）', () => {
  const cases = [
    ['乾糧減5克', '乾糧', 5], ['主食罐減3克', '主食罐', 3], ['副食罐扣2克', '副食罐', 2], ['罐頭減10克', '罐頭', 10]
  ];
  for (const [x, foodType, amount] of cases) {
    const r = parseMessage(x);
    assert.equal(r.type, 'foodAdjust', x);
    assert.equal(r.mode, 'subtract');
    assert.equal(r.confirm, false);
    assert.equal(r.foodType, foodType);
    assert.equal(r.amount, amount);
  }
});

test('possibleSubtract：別名＋「-」＋正數（無動詞）→ confirm=true，三種空白版本一致', () => {
  const r = assertAllEqual(['主食-3', '主食 -3', '主食 - 3'], '主食-3');
  assert.equal(r.type, 'foodAdjust');
  assert.equal(r.mode, 'subtract');
  assert.equal(r.confirm, true, '沒有明確動詞 → 必須進短確認流程');
  assert.equal(r.foodType, '主食罐');
  assert.equal(r.amount, 3);
});

test('possibleSubtract：乾乾-5／副食-2／罐罐-10 都是 confirm=true', () => {
  for (const [x, foodType, amount] of [['乾乾-5', '乾糧', 5], ['副食-2', '副食罐', 2], ['罐罐-10', '罐頭', 10]]) {
    const r = parseMessage(x);
    assert.equal(r.type, 'foodAdjust', x);
    assert.equal(r.confirm, true, `${x} 應需確認`);
    assert.equal(r.foodType, foodType);
    assert.equal(r.amount, amount);
  }
});

test('負向：語意不明確者不得直接建立食物紀錄，也不得成為 foodAdjust', () => {
  // 這些既不能是 record（直接建紀錄），也不能是 foodAdjust（直接／確認調整）
  for (const x of ['3', '35', '主3', '副3', '今天3', '吃3', '-3', '今天-3', '35-3', '主食-', '主食-abc', '體重-3']) {
    const r = parseMessage(x);
    assert.notEqual(r.type, 'record', `「${x}」不得直接建立食物紀錄，實得 ${JSON.stringify(r)}`);
    assert.notEqual(r.type, 'foodAdjust', `「${x}」不得直接進調整，實得 ${JSON.stringify(r)}`);
  }
});

// ───────────────────────── handler 行為測試（含 DB）─────────────────────────

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8');
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

// 攔截 LINE reply/push 內容，讓測試可斷言「有沒有真的送出確認卡文字」
function captureReplies() {
  const texts = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => { if (m.text) texts.push(m.text); }); } catch {}
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { texts, restore() { globalThis.fetch = orig; } };
}

async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}
async function addFood(db, pet, { itemName = '', foodType = '主食罐', amount = 30, when = '2026-08-10 09:00' } = {}) {
  return insertLog(db, { lineUserId: 'u1', petId: pet.petId, eventDateTime: when, category: 'food', foodType, itemName, foodId: '', amount, unit: 'g', kcal: Math.round(amount * 0.9), recordedBy: 'u1', source: 'line', updatedBy: 'u1' });
}
const env = { DB: null };

test('handleFoodAdjust：明確動詞＋唯一同類型候選 → 直接扣減（主食罐 30→27）', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { foodType: '主食罐', amount: 30 });
  await handleFoodAdjust(env, mkEvent(), pet, { type: 'foodAdjust', foodType: '主食罐', mode: 'subtract', amount: 3, confirm: false }, 'u1');
  assert.equal((await getLog(db, log.logId)).amount, 27, '有明確動詞＋唯一候選 → 直接扣 3');
});

test('possibleSubtract（confirm=true）：唯一候選也不直接改，先出短確認卡', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const log = await addFood(db, pet, { foodType: '主食罐', amount: 30 });
  const cap = captureReplies();
  await handleFoodAdjust(env, mkEvent(), pet, { type: 'foodAdjust', foodType: '主食罐', mode: 'subtract', amount: 3, confirm: true }, 'u1');
  cap.restore();
  assert.equal((await getLog(db, log.logId)).amount, 30, 'confirm=true 不得直接 update log');
  assert.ok(cap.texts.join('').includes('你是要把最近一筆主食罐扣 3 克嗎'), `應送出短確認卡，實得：${cap.texts.join(' | ')}`);
});

test('多筆合理候選（即使有明確動詞）→ 不亂猜、不直接改，出選餐確認卡', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const a = await addFood(db, pet, { foodType: '主食罐', amount: 30, when: '2026-08-10 08:00' });
  const b = await addFood(db, pet, { foodType: '主食罐', amount: 25, when: '2026-08-10 18:00' });
  const cap = captureReplies();
  await handleFoodAdjust(env, mkEvent(), pet, { type: 'foodAdjust', foodType: '主食罐', mode: 'subtract', amount: 5, confirm: false }, 'u1');
  cap.restore();
  assert.equal((await getLog(db, a.logId)).amount, 30, '多筆候選 → 不自動改任何一筆');
  assert.equal((await getLog(db, b.logId)).amount, 25);
  assert.ok(cap.texts.join('').includes('你要調整哪一筆'), `應出選餐卡，實得：${cap.texts.join(' | ')}`);
});

test('只碰對應 foodType：主食罐調整不得動到同貓的乾糧紀錄', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const dry = await addFood(db, pet, { foodType: '乾糧', amount: 20, when: '2026-08-10 07:00' });
  const main = await addFood(db, pet, { foodType: '主食罐', amount: 30, when: '2026-08-10 09:00' });
  await handleFoodAdjust(env, mkEvent(), pet, { type: 'foodAdjust', foodType: '主食罐', mode: 'subtract', amount: 4, confirm: false }, 'u1');
  assert.equal((await getLog(db, main.logId)).amount, 26, '主食罐被扣 4');
  assert.equal((await getLog(db, dry.logId)).amount, 20, '乾糧完全不受影響');
});

test('找不到該類型的近期紀錄 → 提示找不到、不動任何資料', async () => {
  const { db, pet } = await seed(); env.DB = db;
  const dry = await addFood(db, pet, { foodType: '乾糧', amount: 20 });
  const cap = captureReplies();
  await handleFoodAdjust(env, mkEvent(), pet, { type: 'foodAdjust', foodType: '主食罐', mode: 'subtract', amount: 3, confirm: false }, 'u1');
  cap.restore();
  assert.equal((await getLog(db, dry.logId)).amount, 20, '找不到主食罐 → 不誤改乾糧');
  assert.ok(cap.texts.join('').includes('找不到可以調整的主食罐紀錄'), `應提示找不到，實得：${cap.texts.join(' | ')}`);
});
