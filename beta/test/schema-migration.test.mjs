// 冪等 runtime ALTER 驗證：以「舊版 schema」建立資料庫（沒有 servedAmount／leftoverAmount／
// kcalEstimated 三個新欄位），跑既有的 ensureTaskSchema 流程，確認三欄安全建立、舊資料保留、
// 且可重複執行不報錯（模擬多個 request 各自第一次觸發 ALTER）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ensureTaskSchema, _resetTaskSchemaReadyForTest } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

// 把目前 schema.sql 還原成「加這三欄之前」的舊版：移除三個新欄位定義（連同尾逗號處理）。
function oldSchema() {
  return SCHEMA
    // logs.servedAmount／leftoverAmount（含上方註解行與前一欄尾逗號，避免留下 ",)"）
    .replace(/,\n\s*-- P0-2 食物調整：[^\n]*\n\s*servedAmount REAL,\n\s*leftoverAmount REAL/, '')
    // daily_summary.kcalEstimated（含上方兩行註解）；後面還有 updatedAt，故只移除本欄與註解
    .replace(/\n\s*-- P0-3：當日總熱量[^\n]*\n\s*-- 可為 NULL[^\n]*\n\s*kcalEstimated INTEGER,/, '');
}

function cols(sdb, table) {
  return sdb.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

test('舊 schema 還原正確：三個新欄位確實不存在（前置條件）', () => {
  const sql = oldSchema();
  assert.ok(!/servedAmount/.test(sql), 'servedAmount 應被移除');
  assert.ok(!/leftoverAmount/.test(sql), 'leftoverAmount 應被移除');
  assert.ok(!/kcalEstimated/.test(sql), 'kcalEstimated 應被移除');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec(sql); // 舊 schema 必須能建起來（沒有殘留逗號等語法錯）
  assert.ok(!cols(sdb, 'logs').includes('servedAmount'));
  assert.ok(!cols(sdb, 'logs').includes('leftoverAmount'));
  assert.ok(!cols(sdb, 'daily_summary').includes('kcalEstimated'));
});

test('ensureTaskSchema 於舊資料庫安全補上三欄、保留既有資料、可重複執行不報錯', async () => {
  const sdb = new DatabaseSync(':memory:');
  sdb.exec(oldSchema());
  // 塞入「舊資料」：食物品項、logs、daily_summary（皆為舊 schema 下合法的列）
  const t = '2026-01-01T00:00:00.000Z';
  sdb.prepare(`INSERT INTO food_items (foodId, ownerLineUserId, brand, productName, displayName, foodType, kcalPerGram, waterRatio, isPrescription, note, isDeleted, createdAt, updatedAt)
    VALUES ('f-can','u1','巔峰','羊肉主食罐','巔峰羊肉','罐頭',1.05,0.78,0,'',0,?,?)`).run(t, t);
  sdb.prepare(`INSERT INTO logs (logId, lineUserId, petId, eventDateTime, category, itemName, foodType, foodId, amount, unit, waterMl, kcal, createdAt, updatedAt)
    VALUES ('l1','u1','p1','2026-01-01 09:00','food','巔峰羊肉','罐頭','f-can',40,'g',31,42,?,?)`).run(t, t);
  sdb.prepare(`INSERT INTO daily_summary (petId, date, kcal, entryCount, updatedAt) VALUES ('p1','2026-01-01',42,1,?)`).run(t);

  // db 介面（沿用其它測試的最小 D1 shim）
  function norm(v) { if (v === undefined || v === null) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
  const db = {
    prepare(sql) {
      return {
        params: [],
        bind(...a) { this.params = a.map(norm); return this; },
        async run() { const i = sdb.prepare(sql).run(...this.params); return { meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; },
        async first() { return sdb.prepare(sql).get(...this.params) ?? null; },
        async all() { return { results: sdb.prepare(sql).all(...this.params) }; }
      };
    }
  };

  _resetTaskSchemaReadyForTest(); // 確保本次 ensure 是「第一次」，會真的跑 ALTER
  await ensureTaskSchema(db);

  // 三欄應已補上
  assert.ok(cols(sdb, 'logs').includes('servedAmount'), 'logs.servedAmount 已建立');
  assert.ok(cols(sdb, 'logs').includes('leftoverAmount'), 'logs.leftoverAmount 已建立');
  assert.ok(cols(sdb, 'daily_summary').includes('kcalEstimated'), 'daily_summary.kcalEstimated 已建立');

  // kcalEstimated 為可 NULL（既有列加欄後為 NULL＝未知，不被回填 0）
  const dsRow = sdb.prepare("SELECT kcalEstimated FROM daily_summary WHERE date='2026-01-01'").get();
  assert.equal(dsRow.kcalEstimated, null, '既有 daily_summary 加欄後為 NULL（不得被回填成 0）');

  // 舊資料仍在、未被更動
  assert.equal(sdb.prepare("SELECT COUNT(*) c FROM food_items").get().c, 1, 'food_items 保留');
  const food = sdb.prepare("SELECT * FROM food_items WHERE foodId='f-can'").get();
  assert.equal(food.displayName, '巔峰羊肉'); assert.equal(food.kcalPerGram, 1.05); assert.equal(food.foodType, '罐頭');
  assert.equal(sdb.prepare("SELECT COUNT(*) c FROM logs").get().c, 1, 'logs 保留');
  assert.equal(sdb.prepare("SELECT foodId FROM logs WHERE logId='l1'").get().foodId, 'f-can', 'logs.foodId 關聯保留');

  // 再跑一次 ensure（模擬第二個 request 第一次觸發）：ALTER 撞既有欄 → 內部 try/catch 吞掉，不報錯、資料不變
  _resetTaskSchemaReadyForTest();
  await assert.doesNotReject(ensureTaskSchema(db), '重複執行 ensure 不得報錯（冪等）');
  assert.equal(sdb.prepare("SELECT COUNT(*) c FROM food_items").get().c, 1, '重跑後 food_items 仍在');
  assert.equal(sdb.prepare("SELECT COUNT(*) c FROM logs").get().c, 1, '重跑後 logs 仍在');
});
