// 任務／事件閉環測試：用 node:sqlite 建記憶體 DB，包成 D1 介面，跑真正的 db.js 邏輯。
// 重點驗證：完成→建一筆可追溯事件、連點/重送/併發不重複、取消完成、多貓不混、原子性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createTask, getTask, listTasksForPet, completeTask, uncompleteTask, skipTask, cancelTask,
  insertLog, getLog, buildInsertLog
} from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

// node:sqlite 只吃 null/number/bigint/string/Uint8Array → 轉換 boolean/undefined
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// 把 node:sqlite 包成 Cloudflare D1 的 prepare().bind().run()/first()/all() + batch()
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
  batch(stmts) {
    this.sdb.exec('BEGIN');
    try { const out = stmts.map((s) => s.run()); this.sdb.exec('COMMIT'); return out; }
    catch (e) { this.sdb.exec('ROLLBACK'); throw e; }
  }
}

function freshDb() {
  const db = new D1();
  // 兩隻貓，供多貓不混測試
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p1','u1','蚵仔','t','t')").bind().run();
  db.prepare("INSERT INTO pets (petId, ownerLineUserId, petName, createdAt, updatedAt) VALUES ('p2','u1','麻糬','t','t')").bind().run();
  return db;
}
function activeEventsFor(db, taskId) {
  return db.prepare('SELECT * FROM logs WHERE sourceTaskId = ? AND isDeleted = 0').bind(taskId).all().results;
}

test('pending 任務可完成，並建立一筆連回任務的事件', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'medication', title: '保肝藥', scheduledAt: '2026-07-30 20:00', createdBy: 'u1' });
  assert.equal(task.status, 'pending');

  const r = await completeTask(db, task.taskId, { completedBy: 'u2', completedAt: '2026-07-30 20:03' });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.task.status, 'completed');
  assert.equal(r.task.completedAt, '2026-07-30 20:03');
  assert.equal(r.task.completedBy, 'u2');
  assert.ok(r.event, '應建立事件');
  assert.equal(r.event.sourceTaskId, task.taskId);
  assert.equal(r.event.petId, 'p1');
  assert.equal(r.event.eventDateTime, '2026-07-30 20:03');
  assert.equal(r.event.recordedBy, 'u2');
  assert.equal(r.event.category, 'med');
  assert.equal(r.event.medStatus, 'done');
  assert.equal(r.event.source, 'task');
});

test('連點兩次完成，只建立一筆事件（第二次回 already）', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'water', title: '餵水', createdBy: 'u1' });
  const r1 = await completeTask(db, task.taskId, { completedBy: 'u1' });
  const r2 = await completeTask(db, task.taskId, { completedBy: 'u1' });
  assert.equal(r1.already, false);
  assert.equal(r2.already, true);
  assert.equal(activeEventsFor(db, task.taskId).length, 1);
});

test('重送請求（多次呼叫）仍只有一筆事件', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'weight', title: '量體重', createdBy: 'u1' });
  for (let i = 0; i < 5; i++) await completeTask(db, task.taskId, { completedBy: 'u1' });
  assert.equal(activeEventsFor(db, task.taskId).length, 1);
});

test('不同貓的任務不會混淆', async () => {
  const db = freshDb();
  const t1 = await createTask(db, { petId: 'p1', taskType: 'medication', title: '藥', createdBy: 'u1' });
  const t2 = await createTask(db, { petId: 'p2', taskType: 'medication', title: '藥', createdBy: 'u1' });
  const r1 = await completeTask(db, t1.taskId, { completedBy: 'u1' });
  const r2 = await completeTask(db, t2.taskId, { completedBy: 'u1' });
  assert.equal(r1.event.petId, 'p1');
  assert.equal(r2.event.petId, 'p2');
  assert.equal(activeEventsFor(db, t1.taskId).length, 1);
  assert.equal(activeEventsFor(db, t2.taskId).length, 1);
});

test('直接記錄的事件不需要 sourceTaskId（預設空字串）', async () => {
  const db = freshDb();
  const log = await insertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-07-30 09:00', category: 'water', waterMl: 30, recordedBy: 'u1', source: 'web' });
  assert.equal(log.sourceTaskId, '');
});

test('事件建立失敗（撞既有事件）時，任務不會錯誤變成 completed', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'medication', title: '藥', createdBy: 'u1' });
  // 先手動塞一筆同 sourceTaskId 的有效事件 → 之後完成任務的 INSERT 會撞唯一索引、整筆交易回滾
  const { stmt } = buildInsertLog(db, { lineUserId: 'u1', petId: 'p1', eventDateTime: '2026-07-30 20:00', category: 'med', sourceTaskId: task.taskId, source: 'task', recordedBy: 'u1' });
  stmt.run();

  const r = await completeTask(db, task.taskId, { completedBy: 'u2' });
  // 交易回滾 → 任務仍為 pending，且事件只有原本那一筆
  const after = await getTask(db, task.taskId);
  assert.equal(after.status, 'pending', '任務不應變 completed');
  assert.equal(activeEventsFor(db, task.taskId).length, 1);
  assert.equal(r.already, true);
});

test('取消完成：任務回 pending，事件軟刪，且可重新完成', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'medication', title: '藥', createdBy: 'u1' });
  await completeTask(db, task.taskId, { completedBy: 'u1' });
  assert.equal(activeEventsFor(db, task.taskId).length, 1);

  const un = await uncompleteTask(db, task.taskId, { actorId: 'u1' });
  assert.equal(un.task.status, 'pending');
  assert.equal(un.task.completedBy, '');
  assert.equal(activeEventsFor(db, task.taskId).length, 0, '事件應被軟刪');

  // 可重新完成（新事件），舊軟刪事件仍在（可追溯）
  const re = await completeTask(db, task.taskId, { completedBy: 'u2' });
  assert.equal(re.ok, true);
  assert.equal(re.already, false);
  assert.equal(activeEventsFor(db, task.taskId).length, 1);
  const allRows = db.prepare('SELECT * FROM logs WHERE sourceTaskId = ?').bind(task.taskId).all().results;
  assert.equal(allRows.length, 2, '一筆軟刪、一筆有效，保留可追溯');
});

test('略過的任務不建立事件、也不能再被完成', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'medication', title: '藥', createdBy: 'u1' });
  const sk = await skipTask(db, task.taskId);
  assert.equal(sk.task.status, 'skipped');
  assert.ok(sk.task.skippedAt);
  const r = await completeTask(db, task.taskId, { completedBy: 'u1' });
  assert.equal(r.ok, false);
  assert.equal(activeEventsFor(db, task.taskId).length, 0);
});

test('取消任務後不再出現在 pending 清單', async () => {
  const db = freshDb();
  const task = await createTask(db, { petId: 'p1', taskType: 'water', title: '餵水', scheduledAt: '2026-07-30 18:00', createdBy: 'u1' });
  await cancelTask(db, task.taskId);
  const pending = await listTasksForPet(db, 'p1', { status: 'pending' });
  assert.equal(pending.length, 0);
  const all = await listTasksForPet(db, 'p1');
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'cancelled');
});

test('找不到的任務回 not_found', async () => {
  const db = freshDb();
  const r = await completeTask(db, 'nope', { completedBy: 'u1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});
