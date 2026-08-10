// P0-4 護欄：新增「主食罐」「副食罐」為獨立類型（罐頭維持 0.9），兩者與罐頭都算濕食。
//  - 自然語言可辨識：主食罐35克、巔峰羊肉主食罐35克、副食罐20g…
//  - 熱量/含水預設正確；濕食桶（wetFoodG）計入；乾糧不受影響。
//  - 對到既有品牌（例如既有罐頭品牌）→ 沿用原 foodId 與原類型，不重複建立、不把既有罐頭改標成主食罐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMessage, matchFood } from '../src/parser.js';
import {
  TYPE_KCAL_DEFAULT, TYPE_WATER_DEFAULT, WET_FOOD_TYPES, FOOD_TYPES,
  isWetFoodType, deriveFoodFields, computeDailySummary
} from '../src/summary.js';
import { createPet, insertLog, listFoods } from '../src/db.js';
import { recordMultiForPet } from '../src/index.js';

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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const env = { DB: null };
const mkEvent = () => ({ replyToken: 'r', source: { userId: 'u1' }, message: { id: 'IGNORED', text: '' } });
const recOf = (t) => { const p = parseMessage(t); return p.type === 'record' ? p.record : (p.type === 'multiRecord' ? p.records[0] : null); };

test('常數：主食罐 1.0／副食罐 0.4、罐頭維持 0.9；兩者皆為濕食；FOOD_TYPES 含新類型', () => {
  assert.equal(TYPE_KCAL_DEFAULT['主食罐'], 1.0);
  assert.equal(TYPE_KCAL_DEFAULT['副食罐'], 0.4);
  assert.equal(TYPE_KCAL_DEFAULT['罐頭'], 0.9, '罐頭維持 0.9 不動');
  assert.ok(TYPE_WATER_DEFAULT['主食罐'] > 0 && TYPE_WATER_DEFAULT['副食罐'] > 0, '兩者有含水預設');
  assert.ok(WET_FOOD_TYPES.includes('主食罐') && WET_FOOD_TYPES.includes('副食罐'));
  assert.ok(isWetFoodType('主食罐') && isWetFoodType('副食罐') && isWetFoodType('罐頭'));
  assert.ok(FOOD_TYPES.includes('主食罐') && FOOD_TYPES.includes('副食罐'));
});

test('自然語言：主食罐/副食罐 被辨識為獨立類型，罐頭仍是罐頭', () => {
  assert.equal(recOf('主食罐 35').foodType, '主食罐');
  assert.equal(recOf('主食罐35克').foodType, '主食罐');
  assert.equal(recOf('主食罐35克').amount, 35);
  assert.equal(recOf('副食罐20g').foodType, '副食罐');
  assert.equal(recOf('罐頭 30').foodType, '罐頭', '一般罐頭不被改判');
  // 品名＋類型黏著
  const r = recOf('巔峰羊肉主食罐35克');
  assert.equal(r.foodType, '主食罐');
  assert.equal(r.itemName, '巔峰羊肉');
  assert.equal(r.amount, 35);
});

test('熱量/含水：主食罐依 1.0、副食罐依 0.4 估算，並標估算（無品牌自訂）', () => {
  const zhu = deriveFoodFields(35, '主食罐', null);
  assert.equal(zhu.kcal, 35, '35×1.0');
  assert.equal(zhu.estimated, true);
  const fu = deriveFoodFields(20, '副食罐', null);
  assert.equal(fu.kcal, 8, '20×0.4');
  assert.equal(fu.estimated, true);
});

test('濕食桶：主食罐/副食罐 計入 wetFoodG（固形量）、不進乾糧桶', () => {
  const s = computeDailySummary([
    { category: 'food', foodType: '主食罐', amount: 40, kcal: 40, waterMl: 31 },
    { category: 'food', foodType: '副食罐', amount: 20, kcal: 8, waterMl: 16 },
    { category: 'food', foodType: '乾糧', amount: 10, kcal: 37, waterMl: 0 }
  ]);
  assert.equal(s.dryFoodG, 10, '乾糧不受影響');
  assert.ok(s.wetFoodG > 0, '主食罐/副食罐計入濕食桶');
});

test('對到既有「罐頭」品牌 → 沿用原 foodId 與原類型（不重複建立、不改標成主食罐）', async () => {
  const db = new D1(); env.DB = db;
  const pet = await createPet(db, 'u1', { petName: '蚵仔' });
  await db.prepare("INSERT INTO food_items (foodId, ownerLineUserId, brand, displayName, foodType, kcalPerGram, waterRatio, createdAt, updatedAt) VALUES ('f-can','u1','巔峰','巔峰羊肉','罐頭',1.05,0.78,'t','t')").bind().run();
  await db.prepare("UPDATE users SET defaultPetId=? WHERE lineUserId='u1'").bind(pet.petId).run();
  // 使用者打「巔峰羊肉主食罐 35」——雖然講主食罐，但既有品牌是罐頭 → 應沿用該品牌
  const p = parseMessage('巔峰羊肉主食罐35克');
  const records = p.type === 'record' ? [p.record] : p.records;
  await recordMultiForPet(env, mkEvent(), db, {
    pet: { petId: pet.petId, petName: '蚵仔' }, records, candidates: [], unparsed: [],
    smid: 'M1', rawText: '巔峰羊肉主食罐35克', ownerId: 'u1', lineUserId: 'u1', caregiverName: '', baseUrl: ''
  });
  const foods = await listFoods(db, 'u1');
  assert.equal(foods.length, 1, '不得重複建立品項');
  assert.equal(foods[0].foodType, '罐頭', '既有品牌類型不被改');
  const log = db.prepare("SELECT * FROM logs WHERE category='food'").bind().first();
  assert.equal(log.foodId, 'f-can', '沿用原 foodId');
  assert.equal(log.foodType, '罐頭', '這筆沿用品牌原類型，不改標成主食罐');
  assert.equal(log.kcal, Math.round(35 * 1.05 * 10) / 10, '用品牌自訂每克熱量算（35×1.05＝36.8）');
});
