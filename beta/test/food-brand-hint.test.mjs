// 產品規則：純類型／口語別名輸入（乾乾5／主食3…）＝「這類吃了 N g」，沒指定品牌。
//  - 沒有預設 → 直接記 generic 類型（用系統粗估值），不因家庭有多個品牌就強迫選、也不自動套唯一品項。
//  - 有預設 → 自動帶入預設品牌與實際熱量。
//  - 品牌選擇卡只在「打了品名／品牌卻對不到既有品項」時出現。
//  - 完成卡：generic 粗估 → 標示系統粗估值＋照護站引導；零食無熱量 → 熱量未設定；有品牌實際 kcal → 不顯示粗估 CTA。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage } from '../src/parser.js';
import { handleRecord } from '../src/index.js';
import { recordTutorial } from '../src/replies.js';
import { createPet, createFoodItem, setDefaultFood } from '../src/db.js';

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
function capture() {
  const msgs = [];
  globalThis.fetch = async (url, opts) => {
    try { const b = JSON.parse(opts?.body || '{}'); (b.messages || []).forEach((m) => msgs.push(m)); } catch {}
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { all: () => JSON.stringify(msgs) };
}
async function seed() {
  const db = new D1();
  await createPet(db, 'u1', { petName: '蚵仔' });
  const pet = db.prepare("SELECT * FROM pets WHERE petName='蚵仔'").bind().first();
  return { db, pet };
}
function foodCount(db) { return db.prepare("SELECT COUNT(*) AS n FROM logs WHERE category='food' AND isDeleted=0").bind().first().n; }
async function rec(db, pet, text) {
  const intent = parseMessage(text);
  assert.equal(intent.type, 'record', `「${text}」應為 record`);
  return handleRecord({ DB: db }, mkEvent(), pet, intent.record, 'u1', { actorId: 'u1' });
}

test('A 多品牌、無預設：乾乾5 → 不出品牌卡、直接記 generic 乾糧 5g / 約 18.5 kcal 粗估', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  assert.ok(!(res && res.disambiguated), '純類型無預設 → 不出品牌卡');
  assert.equal(res.savedLog.foodId, '', 'generic：不綁品牌');
  assert.equal(res.savedLog.kcal, 18.5, '5×3.7=18.5');
  assert.equal(foodCount(db), 1, '直接完成一筆');
  const j = cap.all();
  assert.ok(j.includes('系統粗估值'), '完成卡標示系統粗估值');
  assert.ok(j.includes('照護站'), '完成卡引導照護站');
  assert.ok(!j.includes('找不到已建立的品項'), '不得回「找不到已建立品項」');
});

test('B 空格等價：乾乾5 / 乾乾 5 / 乾糧5 / 乾糧 5 都直接記 generic（多品牌無預設）', async () => {
  for (const text of ['乾乾5', '乾乾 5', '乾糧5', '乾糧 5']) {
    const { db, pet } = await seed();
    await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
    await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
    const res = await rec(db, pet, text);
    assert.ok(!(res && res.disambiguated), `「${text}」不出品牌卡`);
    assert.equal(res.savedLog.foodId, '', `「${text}」generic`);
    assert.equal(res.savedLog.amount, 5);
    assert.equal(res.savedLog.kcal, 18.5);
  }
});

test('C 有預設（含品牌 kcal）：乾乾5 → 希爾斯 foodId、19 kcal、estimated=false，不出品牌卡', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  assert.ok(!(res && res.disambiguated));
  assert.equal(res.savedLog.foodId, hill.foodId);
  assert.equal(res.savedLog.kcal, 19);
  assert.ok(!cap.all().includes('系統粗估值'), '有品牌實際熱量 → 不顯示粗估 CTA');
});

test('D 明確品牌覆蓋預設：皇家乾糧5（預設是希爾斯）→ 用皇家 18 kcal', async () => {
  const { db, pet } = await seed();
  const hill = await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  const royal = await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  await setDefaultFood(db, 'u1', '乾糧', hill.foodId);
  const res = await rec(db, pet, '皇家乾糧5');
  assert.equal(res.savedLog.foodId, royal.foodId);
  assert.equal(res.savedLog.kcal, 18);
});

test('E 其他類型一致（多品牌無預設都記 generic 粗估）：主食3/副食3/罐罐10 不出品牌卡', async () => {
  const cases = [['主食3', '主食罐', 3, 3.0], ['副食3', '副食罐', 3, 1.2], ['罐罐10', '罐頭', 10, 9.0]];
  for (const [text, ft, amt, kcal] of cases) {
    const { db, pet } = await seed();
    await createFoodItem(db, 'u1', { displayName: `A${ft}`, foodType: ft, kcalPerGram: 1.5 });
    await createFoodItem(db, 'u1', { displayName: `B${ft}`, foodType: ft, kcalPerGram: 1.0 });
    const res = await rec(db, pet, text);
    assert.ok(!(res && res.disambiguated), `「${text}」不出品牌卡`);
    assert.equal(res.savedLog.foodId, '', `「${text}」generic`);
    assert.equal(res.savedLog.foodType, ft);
    assert.equal(res.savedLog.amount, amt);
    assert.equal(res.savedLog.kcal, kcal, `「${text}」用 ${ft} 系統粗估值`);
  }
});

test('F 零食無品牌熱量：零食1（多品項無預設）→ generic、熱量未設定、完成卡引導照護站', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: 'CIAO', foodType: '零食', kcalPerGram: 0 });
  await createFoodItem(db, 'u1', { displayName: '凍乾', foodType: '零食', kcalPerGram: 0 });
  const cap = capture();
  const res = await rec(db, pet, '零食1');
  assert.ok(!(res && res.disambiguated));
  assert.equal(res.savedLog.foodId, '');
  assert.equal(res.savedLog.kcal, 0);
  const j = cap.all();
  assert.ok(j.includes('熱量未設定'), '零食顯示熱量未設定');
  assert.ok(j.includes('照護站'));
});

test('G 品牌歧義：打了品名卻對不到既有品項 → 才出品牌選擇卡（乾糧 新牌 5）', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const res = await rec(db, pet, '乾糧 新牌 5');
  assert.ok(res && res.disambiguated, '打了品名對不到 → 出品牌選擇卡');
  assert.equal(foodCount(db), 0, '確認前不寫入');
});

test('H 0 品項：乾乾5 → generic 3.7 粗估、完成卡系統粗估值＋照護站', async () => {
  const { db, pet } = await seed();
  const cap = capture();
  const res = await rec(db, pet, '乾乾5');
  assert.equal(res.savedLog.foodId, '');
  assert.equal(res.savedLog.kcal, 18.5);
  const j = cap.all();
  assert.ok(j.includes('系統粗估值') && j.includes('照護站'));
});

test('§10 實機 regression：家庭有希爾斯乾糧＋皇家乾糧、無預設乾糧，「乾乾 5」直接記 generic，不回「找不到已建立品項」', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const cap = capture();
  const res = await rec(db, pet, '乾乾 5');
  assert.ok(!(res && res.disambiguated), '不得要求選品牌');
  assert.equal(res.savedLog.foodType, '乾糧');
  assert.equal(res.savedLog.amount, 5);
  assert.equal(res.savedLog.kcal, 18.5, '約 18.5 kcal 粗估');
  assert.ok(!cap.all().includes('找不到已建立的品項'), '不得回「找不到已建立品項」');
});

test('食物紀錄不建立新 food_item、不改預設；教學仍說「沒設定也可以先記」', async () => {
  const { db, pet } = await seed();
  await createFoodItem(db, 'u1', { displayName: '希爾斯乾糧', foodType: '乾糧', kcalPerGram: 3.8 });
  await createFoodItem(db, 'u1', { displayName: '皇家乾糧', foodType: '乾糧', kcalPerGram: 3.6 });
  const before = db.prepare('SELECT COUNT(*) AS n FROM food_items').bind().first().n;
  await rec(db, pet, '乾乾5');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM food_items').bind().first().n, before, 'generic 紀錄不得新增 food_item');
  const t = recordTutorial();
  assert.ok(/沒設定也可以先記|沒設定也能/.test(t) && !t.includes('必須先設'), '教學說沒設定也能先記、不暗示必填');
});
