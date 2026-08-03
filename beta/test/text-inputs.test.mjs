// text_inputs（原始文字輸入紀錄）與容錯測試：用 node:sqlite 建記憶體 DB 跑真正的 db.js。
// 重點：partial 正確落 raw；raw 寫入失敗不得影響/重複正式 logs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { logTextInput, insertLog } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
class Stmt {
  constructor(sdb, sql) { this.sdb = sdb; this.sql = sql; this.params = []; }
  bind(...args) { this.params = args.map(norm); return this; }
  run() { const info = this.sdb.prepare(this.sql).run(...this.params); return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }; }
  first() { const row = this.sdb.prepare(this.sql).get(...this.params); return row ?? null; }
  all() { const rows = this.sdb.prepare(this.sql).all(...this.params); return { results: rows }; }
}
class D1 {
  constructor() { this.sdb = new DatabaseSync(':memory:'); this.sdb.exec(SCHEMA); }
  prepare(sql) { return new Stmt(this.sdb, sql); }
}
function countLogs(db, category) {
  return db.prepare('SELECT COUNT(*) c FROM logs WHERE category = ? AND isDeleted = 0').bind(category).first().c;
}
function countRaw(db) {
  return db.prepare('SELECT COUNT(*) c FROM text_inputs').bind().first().c;
}

test('partial 會落一筆 raw（parseStatus=partial、resolvedPetId=蚵仔），不進 logs', async () => {
  const db = new D1();
  await logTextInput(db, {
    lineUserId: 'u1', ownerId: 'u1', petId: 'p1', rawText: '蚵仔希爾斯罐頭23g',
    parseStatus: 'partial', failReason: 'unknown_food_expression', sourceMessageId: 'm1',
    resolvedPetId: 'p1', linkedLogId: '', parsedResult: JSON.stringify({ recognizedPetName: '蚵仔', rest: '希爾斯罐頭 23g' })
  });
  const rows = db.prepare('SELECT * FROM text_inputs').bind().all().results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parseStatus, 'partial');
  assert.equal(rows[0].failReason, 'unknown_food_expression');
  assert.equal(rows[0].resolvedPetId, 'p1');
  assert.equal(rows[0].linkedLogId, '');
  assert.equal(countLogs(db, 'water'), 0); // partial 不建立正式 log
});

test('容錯：raw 寫入失敗不得影響、也不得重複正式 logs（水20 仍只有一筆）', async () => {
  const db = new D1();
  // 正常喝水紀錄先成功寫入（模擬「水20」）
  await insertLog(db, {
    lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-08-03 11:00', category: 'water',
    amount: 20, unit: 'ml', waterMl: 20, source: 'line', recordedBy: 'u1', updatedBy: 'u1'
  });
  assert.equal(countLogs(db, 'water'), 1);

  // 模擬 text_inputs 寫入失敗：db.prepare 直接丟例外
  const brokenDb = { prepare() { throw new Error('boom: text_inputs unavailable'); } };
  await assert.doesNotReject(async () => {
    await logTextInput(brokenDb, { lineUserId: 'u1', petId: 'p1', rawText: '水20', parseStatus: 'record' });
  });

  // 正式 log 不受影響、且沒有重複
  assert.equal(countLogs(db, 'water'), 1);
});

test('容錯：logTextInput 內部例外被吞掉，回傳不丟出', async () => {
  const brokenDb = { prepare() { throw new Error('boom'); } };
  await assert.doesNotReject(() => logTextInput(brokenDb, { rawText: 'x', parseStatus: 'unknown' }));
});

test('多筆 raw 各自獨立寫入，不會互相覆蓋或去重', async () => {
  const db = new D1();
  await logTextInput(db, { lineUserId: 'u1', rawText: '蚵仔希爾斯罐頭23g', parseStatus: 'partial' });
  await logTextInput(db, { lineUserId: 'u1', rawText: '水20', parseStatus: 'record' });
  assert.equal(countRaw(db), 2);
});
