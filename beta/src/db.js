// D1 資料存取層：使用者、貓咪、食物、紀錄、每日總結重算、session
// 規則：所有刪除都是 isDeleted 軟刪除；logs 有任何變動就重算該日 daily_summary。

import { computeDailySummary, deriveFoodFields } from './summary.js';
import { newId, newToken, nowIso, addDays, taipeiNowDateTime } from './util.js';

// ---------- users ----------

export async function getUser(db, lineUserId) {
  return db.prepare('SELECT * FROM users WHERE lineUserId = ?').bind(lineUserId).first();
}

export async function ensureUser(db, lineUserId, displayName = '') {
  const existing = await getUser(db, lineUserId);
  if (existing) return { user: existing, created: false };

  const now = nowIso();
  await db
    .prepare('INSERT INTO users (lineUserId, displayName, defaultPetId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .bind(lineUserId, displayName, '', now, now)
    .run();
  return { user: await getUser(db, lineUserId), created: true };
}

export async function updateUser(db, lineUserId, fields) {
  const allowed = ['displayName', 'defaultPetId', 'pendingAction', 'plan', 'planExpiresAt', 'betaAccess', 'reminderHour'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(String(fields[key] ?? ''));
    }
  }
  if (!sets.length) return getUser(db, lineUserId);
  values.push(nowIso(), lineUserId);
  await db.prepare(`UPDATE users SET ${sets.join(', ')}, updatedAt = ? WHERE lineUserId = ?`).bind(...values).run();
  return getUser(db, lineUserId);
}

// ---------- pets ----------

export async function listPets(db, ownerLineUserId) {
  const { results } = await db
    .prepare('SELECT * FROM pets WHERE ownerLineUserId = ? AND isDeleted = 0 ORDER BY createdAt')
    .bind(ownerLineUserId)
    .all();
  return results || [];
}

export async function getPet(db, petId) {
  return db.prepare('SELECT * FROM pets WHERE petId = ? AND isDeleted = 0').bind(petId).first();
}

export async function createPet(db, ownerLineUserId, fields = {}) {
  const now = nowIso();
  const petId = newId();
  await db
    .prepare(
      `INSERT INTO pets (petId, ownerLineUserId, petName, species, birthday, breed, weightKg,
        conditionNote, vaccineNote, defaultVetId, isDeleted, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      petId,
      ownerLineUserId,
      String(fields.petName || '貓貓'),
      String(fields.species || '貓'),
      String(fields.birthday || ''),
      String(fields.breed || ''),
      Number(fields.weightKg || 0),
      String(fields.conditionNote || ''),
      String(fields.vaccineNote || ''),
      String(fields.defaultVetId || ''),
      now,
      now
    )
    .run();
  return getPet(db, petId);
}

// LINE 引導建檔用：只更新體重/生日/餵藥時段等基本欄位
export async function updatePetFields(db, petId, fields) {
  const sets = [];
  const values = [];
  if (fields.weightKg !== undefined) { sets.push('weightKg = ?'); values.push(Number(fields.weightKg) || 0); }
  if (fields.birthday !== undefined) { sets.push('birthday = ?'); values.push(String(fields.birthday)); }
  if (fields.goalMedSlots !== undefined) { sets.push('goalMedSlots = ?'); values.push(String(fields.goalMedSlots)); }
  if (!sets.length) return getPet(db, petId);
  sets.push('updatedAt = ?');
  values.push(nowIso());
  await db.prepare(`UPDATE pets SET ${sets.join(', ')} WHERE petId = ?`).bind(...values, petId).run();
  return getPet(db, petId);
}

// LINE 引導建檔用：建立常吃的食物（帶預設熱量水分）
export async function createFoodItem(db, ownerLineUserId, fields) {
  const now = nowIso();
  const foodId = newId();
  await db
    .prepare(
      `INSERT INTO food_items (foodId, ownerLineUserId, brand, productName, displayName, foodType,
        kcalPerGram, waterRatio, isPrescription, note, isDeleted, createdAt, updatedAt)
       VALUES (?, ?, '', '', ?, ?, ?, ?, 0, ?, 0, ?, ?)`
    )
    .bind(
      foodId,
      ownerLineUserId,
      String(fields.displayName || ''),
      String(fields.foodType || '罐頭'),
      Number(fields.kcalPerGram || 0),
      Number(fields.waterRatio || 0),
      String(fields.note || ''),
      now,
      now
    )
    .run();
  return db.prepare('SELECT * FROM food_items WHERE foodId = ?').bind(foodId).first();
}

// LINE 引導建檔用：建立保健品/藥
export async function createMedItem(db, petId, medName) {
  const now = nowIso();
  const medId = newId();
  await db
    .prepare(
      `INSERT INTO meds (medId, petId, medName, doseAmount, doseUnit, schedule, defaultTimes, instruction, note, isDeleted, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, '', '', '', '', 'LINE 引導建立', 0, ?, ?)`
    )
    .bind(medId, petId, String(medName), now, now)
    .run();
  return db.prepare('SELECT * FROM meds WHERE medId = ?').bind(medId).first();
}

// 使用者「目前操作的貓咪」：defaultPetId 優先，否則取第一隻
export async function resolveDefaultPet(db, user, pets) {
  if (!pets.length) return null;
  if (user?.defaultPetId) {
    const found = pets.find((pet) => pet.petId === user.defaultPetId);
    if (found) return found;
  }
  return pets[0];
}

// ---------- food_items ----------

export async function listFoods(db, ownerLineUserId) {
  const { results } = await db
    .prepare('SELECT * FROM food_items WHERE ownerLineUserId = ? AND isDeleted = 0 ORDER BY createdAt')
    .bind(ownerLineUserId)
    .all();
  return results || [];
}

export async function getFood(db, foodId) {
  return db.prepare('SELECT * FROM food_items WHERE foodId = ? AND isDeleted = 0').bind(foodId).first();
}

// 資料自癒（④）：設定或更新某品項的熱量公式後，回頭把「過去沒算到熱量」的紀錄補算回來。
// 設定/更新某品項的精確每克熱量後，回頭把它的舊紀錄升級成精確值。
// 涵蓋：(a) 綁這個 foodId 的紀錄（當初 kcal=0，或用「類型預設估算」出來的值）；
//       (b) 沒綁 foodId、但同類型且品名和這個品項完全相同的紀錄（當初打的名字對不到）。
// 用精確公式重算，只在「數值有變」或「還沒綁到這個品項」時才更新（已精確的略過，冪等）。
// 回傳 { healed, days } 讓呼叫端可提示使用者補了幾筆。
export async function healFoodKcal(db, food) {
  if (!food || !(Number(food.kcalPerGram) > 0)) return { healed: 0, days: 0 };
  const name = String(food.displayName || '').trim();
  const { results } = await db
    .prepare(
      `SELECT * FROM logs
       WHERE isDeleted = 0 AND category = 'food'
         AND ( foodId = ?
               OR (COALESCE(foodId, '') = '' AND foodType = ? AND itemName = ? AND ? <> '') )`
    )
    .bind(food.foodId, String(food.foodType || ''), name, name)
    .all();
  const logs = results || [];
  if (!logs.length) return { healed: 0, days: 0 };

  const affected = new Set();
  let healed = 0;
  for (const log of logs) {
    const derived = deriveFoodFields(log.amount, food.foodType || log.foodType, food);
    if (!(derived.kcal > 0)) continue;
    const kcalChanged = Math.abs(Number(log.kcal || 0) - derived.kcal) >= 0.05;
    const needsBind = String(log.foodId || '') !== String(food.foodId);
    if (!kcalChanged && !needsBind) continue; // 已經是精確值又綁好了 → 不動
    await db
      .prepare('UPDATE logs SET foodId = ?, itemName = ?, kcal = ?, waterMl = ?, updatedAt = ? WHERE logId = ?')
      .bind(food.foodId, name || String(log.itemName || ''), derived.kcal, derived.waterMl, nowIso(), log.logId)
      .run();
    affected.add(`${log.petId}|${String(log.eventDateTime).slice(0, 10)}`);
    healed += 1;
  }
  for (const key of affected) {
    const [petId, date] = key.split('|');
    await recomputeDay(db, petId, date);
  }
  return { healed, days: affected.size };
}

// ---------- 行為追蹤（輕量事件記錄，用來看留存/活化，失敗絕不影響功能）----------
let eventsReady = false;
export async function track(db, lineUserId, event, meta = '') {
  try {
    if (!eventsReady) {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           lineUserId TEXT NOT NULL DEFAULT '',
           event TEXT NOT NULL,
           meta TEXT NOT NULL DEFAULT '',
           createdAt TEXT NOT NULL
         )`
      ).run();
      eventsReady = true;
    }
    await db.prepare('INSERT INTO events (lineUserId, event, meta, createdAt) VALUES (?, ?, ?, ?)')
      .bind(String(lineUserId || ''), String(event), typeof meta === 'string' ? meta : JSON.stringify(meta), nowIso())
      .run();
  } catch (error) { /* 追蹤壞掉不能影響產品 */ }
}

// ---------- text_inputs（文字輸入的原始紀錄；獨立於正式 logs，不進任何摘要）----------
// 保存每一則文字輸入的原文＋解析結果，供分析「大家實際打什麼、卡在哪」。
// 重要容錯：這張表寫入失敗「不得」讓原本可成功的照護紀錄失敗——全程 try/catch 吞掉，
// 呼叫端也一律「先完成 logs 寫入，再記 text_inputs」，兩者不綁在同一交易。
// 保存期限：規劃保留 90 天（僅測試分析用）；本階段先不建自動清理排程，
// 之後以 purgeOldTextInputs（見下）或手動 DELETE createdAt < now-90d 清除，不預設永久保存。
let textInputsReady = false;
export async function logTextInput(db, r = {}) {
  try {
    if (!textInputsReady) {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS text_inputs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           lineUserId TEXT NOT NULL DEFAULT '',
           ownerLineUserId TEXT NOT NULL DEFAULT '',
           petId TEXT NOT NULL DEFAULT '',
           rawText TEXT NOT NULL DEFAULT '',
           parseStatus TEXT NOT NULL DEFAULT '',
           failReason TEXT NOT NULL DEFAULT '',
           sourceMessageId TEXT NOT NULL DEFAULT '',
           resolvedPetId TEXT NOT NULL DEFAULT '',
           linkedLogId TEXT NOT NULL DEFAULT '',
           parsedResult TEXT NOT NULL DEFAULT '',
           createdAt TEXT NOT NULL
         )`
      ).run();
      textInputsReady = true;
    }
    await db.prepare(
      `INSERT INTO text_inputs (lineUserId, ownerLineUserId, petId, rawText, parseStatus, failReason, sourceMessageId, resolvedPetId, linkedLogId, parsedResult, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      String(r.lineUserId || ''),
      String(r.ownerId || r.ownerLineUserId || ''),
      String(r.petId || ''),
      String(r.rawText || ''),
      String(r.parseStatus || ''),
      String(r.failReason || ''),
      String(r.sourceMessageId || ''),
      String(r.resolvedPetId || ''),
      String(r.linkedLogId || ''),
      typeof r.parsedResult === 'string' ? r.parsedResult : JSON.stringify(r.parsedResult || ''),
      nowIso()
    ).run();
  } catch (error) { /* raw 紀錄壞掉不得影響照護紀錄 */ }
}

// 清除逾期的原始文字輸入（預設保留 90 天）。本階段不自動排程，供未來排程或手動呼叫。
export async function purgeOldTextInputs(db, days = 90) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('DELETE FROM text_inputs WHERE createdAt < ?').bind(cutoff).run();
  } catch (error) { /* 清理失敗不影響產品 */ }
}

// ---------- app_kv（一般鍵值：目前存 LINE 自動換發權杖）----------
export async function appKvGet(db, key) {
  const row = await db.prepare('SELECT v FROM app_kv WHERE k = ?').bind(String(key)).first();
  return row ? row.v : null;
}

export async function appKvSet(db, key, value) {
  await db
    .prepare(
      `INSERT INTO app_kv (k, v, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updatedAt = excluded.updatedAt`
    )
    .bind(String(key), String(value ?? ''), nowIso())
    .run();
}

// 訊息冪等：第一次看到某 message.id → 原子性寫入並回 true（該處理）；
// 重送或打到其他 Worker 實例再看到同一則 → INSERT OR IGNORE 不會寫入、回 false（跳過，不重複回覆）。
export async function claimMessageOnce(db, messageId) {
  if (!messageId) return true;
  try {
    const res = await db
      .prepare('INSERT OR IGNORE INTO app_kv (k, v, updatedAt) VALUES (?, ?, ?)')
      .bind(`msg:${messageId}`, '1', nowIso())
      .run();
    return (res.meta?.changes || 0) > 0;
  } catch (error) {
    return true; // 資料庫出錯時寧可正常回覆，也不要卡住
  }
}

// 清掉舊的訊息冪等紀錄（每晚 cron 呼叫），避免 app_kv 無限成長
export async function purgeOldSeenMessages(db, olderThanIso) {
  try {
    await db.prepare(`DELETE FROM app_kv WHERE k LIKE 'msg:%' AND updatedAt < ?`).bind(olderThanIso).run();
  } catch (error) { /* 清理失敗不影響主流程 */ }
}

// 報告截圖暫存：把即時算好的 PNG 存起來，讓 LINE 內建瀏覽器能以「真圖片」長按儲存。
// id 是長亂數（能力憑證），短期有效、每晚清掉。
async function ensureShotTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS report_shots (id TEXT PRIMARY KEY, ownerLineUserId TEXT NOT NULL DEFAULT '', png TEXT NOT NULL, createdAt TEXT NOT NULL)`
  ).run();
}
export async function saveReportShot(db, ownerLineUserId, base64png) {
  await ensureShotTable(db);
  const id = `${newToken()}${newToken()}`; // 更長的亂數，難以被猜到
  await db.prepare('INSERT INTO report_shots (id, ownerLineUserId, png, createdAt) VALUES (?, ?, ?, ?)')
    .bind(id, String(ownerLineUserId || ''), String(base64png || ''), nowIso())
    .run();
  return id;
}
export async function getReportShot(db, id) {
  try {
    return await db.prepare('SELECT png FROM report_shots WHERE id = ?').bind(String(id || '')).first();
  } catch (error) { return null; }
}
export async function purgeOldShots(db, olderThanIso) {
  try { await db.prepare('DELETE FROM report_shots WHERE createdAt < ?').bind(olderThanIso).run(); } catch (error) { /* ignore */ }
}

// ---------- 資料匯出（CSV）：同樣用長亂數能力憑證、短期有效、每晚清 ----------
async function ensureExportTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS data_exports (id TEXT PRIMARY KEY, ownerLineUserId TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '', csv TEXT NOT NULL, createdAt TEXT NOT NULL)`
  ).run();
}
export async function saveDataExport(db, ownerLineUserId, filename, csv) {
  await ensureExportTable(db);
  const id = `${newToken()}${newToken()}`;
  await db.prepare('INSERT INTO data_exports (id, ownerLineUserId, filename, csv, createdAt) VALUES (?, ?, ?, ?, ?)')
    .bind(id, String(ownerLineUserId || ''), String(filename || 'export.csv'), String(csv || ''), nowIso())
    .run();
  return id;
}
export async function getDataExport(db, id) {
  try {
    return await db.prepare('SELECT filename, csv FROM data_exports WHERE id = ?').bind(String(id || '')).first();
  } catch (error) { return null; }
}
export async function purgeOldExports(db, olderThanIso) {
  try { await db.prepare('DELETE FROM data_exports WHERE createdAt < ?').bind(olderThanIso).run(); } catch (error) { /* ignore */ }
}

// 匯出用：某隻貓的全部未刪除紀錄（由舊到新）
export async function getAllLogsForPet(db, petId) {
  const { results } = await db
    .prepare('SELECT * FROM logs WHERE petId = ? AND isDeleted = 0 ORDER BY eventDateTime, createdAt')
    .bind(petId)
    .all();
  return results || [];
}

// ---------- logs ----------

// 建一筆 logs 事件的「已綁定語句」＋ logId（供 insertLog 直接 run，或放進 db.batch 做原子交易）
export function buildInsertLog(db, log, now = nowIso()) {
  const logId = log.logId || newId();
  const stmt = db
    .prepare(
      `INSERT INTO logs (logId, lineUserId, petId, eventDateTime, category, itemName, foodType, foodId,
        amount, unit, waterMl, kcal, medStatus, medSlot, doseText, medForm, beforeMeal, note, sourceMessageId,
        recordedBy, caregiverName, isBackfilled, source, isDeleted,
        createdAt, updatedAt, updatedBy, sourceTaskId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .bind(
      logId,
      String(log.lineUserId || ''),
      String(log.petId || ''),
      String(log.eventDateTime || ''),
      String(log.category || ''),
      String(log.itemName || ''),
      String(log.foodType || ''),
      String(log.foodId || ''),
      Number(log.amount || 0),
      String(log.unit || ''),
      Number(log.waterMl || 0),
      Number(log.kcal || 0),
      String(log.medStatus || ''),
      String(log.medSlot || ''),
      String(log.doseText || ''),
      String(log.medForm || ''),
      String(log.beforeMeal || ''),
      String(log.note || ''),
      String(log.sourceMessageId || ''),
      String(log.recordedBy || log.lineUserId || ''),
      String(log.caregiverName || ''),
      log.isBackfilled ? 1 : 0,
      String(log.source || ''),
      now,
      now,
      String(log.updatedBy || log.lineUserId || ''),
      String(log.sourceTaskId || '')
    );
  return { stmt, logId };
}

export async function insertLog(db, log) {
  const { stmt, logId } = buildInsertLog(db, log);
  await stmt.run();
  return getLog(db, logId);
}

export async function getLog(db, logId) {
  return db.prepare('SELECT * FROM logs WHERE logId = ?').bind(logId).first();
}

// ---------- tasks（任務＝還要做的事；已發生的事存在 logs 事件）----------

// 自動建表/加欄（沿用本專案 ensureShotTable 的做法）：只在每個 isolate 跑一次成功即止，
// 讓沒有 D1 遷移權限也能上線；全程冪等，失敗不擋請求，下次再試。
let taskSchemaReady = false;
export async function ensureTaskSchema(db) {
  if (taskSchemaReady) return;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS tasks (
        taskId TEXT PRIMARY KEY, petId TEXT NOT NULL, taskType TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', scheduledAt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', createdBy TEXT NOT NULL DEFAULT '',
        completedAt TEXT NOT NULL DEFAULT '', completedBy TEXT NOT NULL DEFAULT '',
        skippedAt TEXT NOT NULL DEFAULT '', repeatRule TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    ).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_pet ON tasks(petId, status, scheduledAt)').run();
    try {
      await db.prepare("ALTER TABLE logs ADD COLUMN sourceTaskId TEXT NOT NULL DEFAULT ''").run();
    } catch (error) { /* 欄位已存在就略過 */ }
    await db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_sourcetask ON logs(sourceTaskId) WHERE sourceTaskId != '' AND isDeleted = 0"
    ).run();
    taskSchemaReady = true;
  } catch (error) { /* 不擋請求，下次請求再嘗試建立 */ }
}

const TASK_TYPE_TO_CATEGORY = {
  medication: 'med', med: 'med', water: 'water', food: 'food',
  weight: 'weight', vomit: 'vomit', stool: 'stool', poop: 'stool'
};
function taskEventCategory(taskType) {
  const key = String(taskType || '').toLowerCase();
  return TASK_TYPE_TO_CATEGORY[key] || String(taskType || '') || 'note';
}

export async function createTask(db, task) {
  const now = nowIso();
  const taskId = task.taskId || newId();
  await db.prepare(
    `INSERT INTO tasks (taskId, petId, taskType, title, note, scheduledAt, status,
       createdBy, completedAt, completedBy, skippedAt, repeatRule, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '', '', '', ?, ?, ?)`
  ).bind(
    taskId, String(task.petId || ''), String(task.taskType || ''), String(task.title || ''),
    String(task.note || ''), String(task.scheduledAt || ''), String(task.createdBy || ''),
    String(task.repeatRule || ''), now, now
  ).run();
  return getTask(db, taskId);
}

export async function getTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE taskId = ?').bind(String(taskId || '')).first();
}

export async function listTasksForPet(db, petId, { status = '', date = '' } = {}) {
  let sql = 'SELECT * FROM tasks WHERE petId = ?';
  const args = [String(petId || '')];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (date) { sql += ' AND substr(scheduledAt, 1, 10) = ?'; args.push(date); }
  sql += ' ORDER BY scheduledAt, createdAt';
  const { results } = await db.prepare(sql).bind(...args).all();
  return results || [];
}

async function taskEvent(db, taskId) {
  return db.prepare('SELECT * FROM logs WHERE sourceTaskId = ? AND isDeleted = 0').bind(String(taskId || '')).first();
}

// 完成任務：原子交易同時「把 task 標 completed」＋「建一筆帶 sourceTaskId 的事件」。
// 冪等：已完成→回既有事件；併發/重送撞唯一索引→交易回滾後當作已完成回既有，不會重複建事件。
export async function completeTask(db, taskId, opts = {}) {
  const task = await getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'completed') {
    return { ok: true, already: true, task, event: await taskEvent(db, taskId) };
  }
  if (task.status !== 'pending') return { ok: false, reason: task.status, task }; // skipped / cancelled

  const now = nowIso();
  const when = String(opts.completedAt || taipeiNowDateTime());
  const actorId = String(opts.completedBy || task.createdBy || '');
  const category = taskEventCategory(task.taskType);
  const { stmt: insertEvent, logId } = buildInsertLog(db, {
    lineUserId: task.createdBy || actorId,
    petId: task.petId,
    eventDateTime: when,
    category,
    medStatus: category === 'med' ? '已吃' : '', // 與 computeDailySummary 一致（'已吃'＝已服藥）
    note: task.title || task.note || '',
    sourceTaskId: task.taskId,
    source: 'task',
    recordedBy: actorId,
    caregiverName: String(opts.caregiverName || ''),
    isBackfilled: 0,
    updatedBy: actorId
  }, now);

  try {
    await db.batch([
      db.prepare("UPDATE tasks SET status = 'completed', completedAt = ?, completedBy = ?, updatedAt = ? WHERE taskId = ? AND status = 'pending'")
        .bind(when, actorId, now, task.taskId),
      insertEvent
    ]);
  } catch (error) {
    // 唯一索引衝突（連點／重送／兩人同時）→ 已有一筆事件，回既有、不重複建立
    const existing = await taskEvent(db, taskId);
    if (existing) return { ok: true, already: true, task: await getTask(db, taskId), event: existing };
    throw error; // 其他錯誤（如事件建立失敗）→ 交易已回滾，task 仍為 pending
  }
  return { ok: true, already: false, task: await getTask(db, taskId), event: await getLog(db, logId) };
}

// 取消完成：task 回 pending，對應事件軟刪（保留可追溯），同一交易。
export async function uncompleteTask(db, taskId, opts = {}) {
  const task = await getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== 'completed') return { ok: true, already: true, task };
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE tasks SET status = 'pending', completedAt = '', completedBy = '', updatedAt = ? WHERE taskId = ?")
      .bind(now, task.taskId),
    db.prepare("UPDATE logs SET isDeleted = 1, updatedAt = ?, updatedBy = ? WHERE sourceTaskId = ? AND isDeleted = 0")
      .bind(now, String(opts.actorId || ''), task.taskId)
  ]);
  return { ok: true, task: await getTask(db, taskId) };
}

export async function skipTask(db, taskId) {
  const task = await getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'completed') return { ok: false, reason: 'already_completed', task };
  const now = nowIso();
  await db.prepare("UPDATE tasks SET status = 'skipped', skippedAt = ?, updatedAt = ? WHERE taskId = ?")
    .bind(now, now, task.taskId).run();
  return { ok: true, task: await getTask(db, taskId) };
}

export async function cancelTask(db, taskId) {
  const task = await getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  const now = nowIso();
  await db.prepare("UPDATE tasks SET status = 'cancelled', updatedAt = ? WHERE taskId = ?")
    .bind(now, task.taskId).run();
  return { ok: true, task: await getTask(db, taskId) };
}

// 最近 n 筆紀錄（新到舊），供 LINE「回顧」清單使用
export async function getRecentLogsByPet(db, petId, limit = 10) {
  const { results } = await db
    .prepare('SELECT * FROM logs WHERE petId = ? AND isDeleted = 0 ORDER BY eventDateTime DESC, createdAt DESC LIMIT ?')
    .bind(petId, limit)
    .all();
  return results || [];
}

export async function getLogsForDay(db, petId, date) {
  const { results } = await db
    .prepare(
      `SELECT * FROM logs
       WHERE petId = ? AND isDeleted = 0 AND substr(eventDateTime, 1, 10) = ?
       ORDER BY eventDateTime, createdAt`
    )
    .bind(petId, date)
    .all();
  return results || [];
}

export async function updateLog(db, logId, fields, updatedBy) {
  const allowedText = ['eventDateTime', 'category', 'itemName', 'foodType', 'foodId', 'unit', 'medStatus', 'medSlot', 'doseText', 'medForm', 'beforeMeal', 'note'];
  const allowedNumber = ['amount', 'waterMl', 'kcal'];
  const sets = [];
  const values = [];

  for (const key of allowedText) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(String(fields[key] ?? ''));
    }
  }
  for (const key of allowedNumber) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(Number(fields[key] || 0));
    }
  }
  if (!sets.length) return getLog(db, logId);

  values.push(nowIso(), String(updatedBy || ''), logId);
  await db.prepare(`UPDATE logs SET ${sets.join(', ')}, updatedAt = ?, updatedBy = ? WHERE logId = ?`).bind(...values).run();
  return getLog(db, logId);
}

export async function softDeleteLog(db, logId, updatedBy) {
  await db
    .prepare('UPDATE logs SET isDeleted = 1, updatedAt = ?, updatedBy = ? WHERE logId = ?')
    .bind(nowIso(), String(updatedBy || ''), logId)
    .run();
}

// ---------- daily_summary ----------

export async function recomputeDay(db, petId, date) {
  const logs = await getLogsForDay(db, petId, date);
  const summary = computeDailySummary(logs);

  await db
    .prepare(
      `INSERT INTO daily_summary (petId, date, waterMl, foodWaterMl, totalWaterMl, dryFoodG, wetFoodG,
        otherFoodG, kcal, medJson, medTakenCount, medIssueCount, vomitCount, stoolCount,
        abnormalFlags, entryCount, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(petId, date) DO UPDATE SET
        waterMl = excluded.waterMl,
        foodWaterMl = excluded.foodWaterMl,
        totalWaterMl = excluded.totalWaterMl,
        dryFoodG = excluded.dryFoodG,
        wetFoodG = excluded.wetFoodG,
        otherFoodG = excluded.otherFoodG,
        kcal = excluded.kcal,
        medJson = excluded.medJson,
        medTakenCount = excluded.medTakenCount,
        medIssueCount = excluded.medIssueCount,
        vomitCount = excluded.vomitCount,
        stoolCount = excluded.stoolCount,
        abnormalFlags = excluded.abnormalFlags,
        entryCount = excluded.entryCount,
        updatedAt = excluded.updatedAt`
    )
    .bind(
      petId,
      date,
      summary.waterMl,
      summary.foodWaterMl,
      summary.totalWaterMl,
      summary.dryFoodG,
      summary.wetFoodG,
      summary.otherFoodG,
      summary.kcal,
      JSON.stringify(summary.meds),
      summary.medTakenCount,
      summary.medIssueCount,
      summary.vomitCount,
      summary.stoolCount,
      JSON.stringify(summary.abnormalFlags),
      summary.entryCount,
      nowIso()
    )
    .run();

  return summary;
}

export async function getSummaries(db, petId, from, to) {
  const { results } = await db
    .prepare('SELECT * FROM daily_summary WHERE petId = ? AND date >= ? AND date <= ? ORDER BY date')
    .bind(petId, from, to)
    .all();
  return results || [];
}

// 近 n 天（含今天）的總結列，缺少的日期補零列
export async function getRecentSummaries(db, petId, today, days) {
  const from = addDays(today, -(days - 1));
  const rows = await getSummaries(db, petId, from, today);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const filled = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    filled.push(byDate.get(date) || emptySummaryRow(petId, date));
  }
  return filled;
}

export function emptySummaryRow(petId, date) {
  return {
    petId,
    date,
    waterMl: 0,
    foodWaterMl: 0,
    totalWaterMl: 0,
    dryFoodG: 0,
    wetFoodG: 0,
    otherFoodG: 0,
    kcal: 0,
    medJson: '[]',
    medTakenCount: 0,
    medIssueCount: 0,
    vomitCount: 0,
    stoolCount: 0,
    abnormalFlags: '[]',
    entryCount: 0,
    updatedAt: ''
  };
}

// ---------- vets / visits ----------

export async function upcomingVisits(db, petId, today) {
  const { results } = await db
    .prepare(
      `SELECT * FROM vet_visits
       WHERE petId = ? AND isDeleted = 0 AND (nextVisitDate >= ? OR visitDate >= ?)
       ORDER BY CASE WHEN nextVisitDate >= ? THEN nextVisitDate ELSE visitDate END
       LIMIT 5`
    )
    .bind(petId, today, today, today)
    .all();
  return results || [];
}

export async function latestVisit(db, petId) {
  return db
    .prepare('SELECT * FROM vet_visits WHERE petId = ? AND isDeleted = 0 ORDER BY visitDate DESC LIMIT 1')
    .bind(petId)
    .first();
}

export async function listVetsByOwner(db, ownerLineUserId) {
  const { results } = await db
    .prepare('SELECT * FROM vets WHERE ownerLineUserId = ? AND isDeleted = 0 ORDER BY createdAt')
    .bind(ownerLineUserId)
    .all();
  return results || [];
}

// ---------- sessions ----------

const SESSION_DAYS = 30;

export async function createSession(db, lineUserId) {
  const token = newToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare('INSERT INTO sessions (token, lineUserId, expiresAt, createdAt) VALUES (?, ?, ?, ?)')
    .bind(token, lineUserId, expiresAt, now)
    .run();
  return token;
}

// 滑動延長：只要有在使用就自動續期，超過 30 天沒開才會真的過期。
// 剩餘效期低於 25 天才寫回，避免每個 API 請求都多一次寫入。
const SESSION_RENEW_THRESHOLD_MS = (SESSION_DAYS - 5) * 24 * 60 * 60 * 1000;

export async function getSessionUser(db, token) {
  if (!token) return null;
  const session = await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!session) return null;
  if (String(session.expiresAt) < nowIso()) return null;

  const remainingMs = new Date(session.expiresAt).getTime() - Date.now();
  if (remainingMs < SESSION_RENEW_THRESHOLD_MS) {
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('UPDATE sessions SET expiresAt = ? WHERE token = ?').bind(expiresAt, token).run();
  }
  return session.lineUserId;
}

// ---------- 共同照護（care_members）----------
// 資料一律掛在「飼主本人（ownerLineUserId）」名下；共同照護者以自己的 LINE 加入後，
// 操作時解析到飼主，讓多人一起記錄／查看同一批貓咪。

// 這個 LINE 使用者實際要操作誰的資料：
//  - 自己有貓 → 就是自己（飼主本人，行為完全不變）
//  - 自己沒貓但是某人的共同照護者 → 那位飼主
//  - 都不是 → 自己
export async function resolveDataOwner(db, actorLineUserId) {
  if (!actorLineUserId) return actorLineUserId;
  const own = await db
    .prepare('SELECT 1 FROM pets WHERE ownerLineUserId = ? AND isDeleted = 0 LIMIT 1')
    .bind(actorLineUserId).first();
  if (own) return actorLineUserId;
  const member = await db
    .prepare("SELECT ownerLineUserId FROM care_members WHERE memberLineUserId = ? AND status = 'accepted' ORDER BY acceptedAt DESC LIMIT 1")
    .bind(actorLineUserId).first();
  return member ? member.ownerLineUserId : actorLineUserId;
}

export async function listCareMembers(db, ownerLineUserId) {
  const { results } = await db
    .prepare("SELECT * FROM care_members WHERE ownerLineUserId = ? AND status = 'accepted' ORDER BY acceptedAt")
    .bind(ownerLineUserId).all();
  return results || [];
}

// 照護圈：飼主本人 ＋ 所有已接受的共同照護者（用來互相通知）。單人時就只有飼主自己。
export async function listCareCircle(db, ownerLineUserId) {
  const members = await listCareMembers(db, ownerLineUserId);
  const ids = [ownerLineUserId, ...members.map((m) => m.memberLineUserId)];
  return [...new Set(ids.filter(Boolean))];
}

// 邀請碼：6 碼（去掉易混淆字元），存在 app_kv，7 天有效、可重複使用（方便一次找幾個人）
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export async function createCareInvite(db, ownerLineUserId) {
  const code = newInviteCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await appKvSet(db, `invite:${code}`, JSON.stringify({ ownerLineUserId, expiresAt }));
  return code;
}

export async function redeemCareInvite(db, code, memberLineUserId) {
  const raw = await appKvGet(db, `invite:${String(code || '').toUpperCase()}`);
  if (!raw) return { ok: false, reason: 'not_found' };
  let payload;
  try { payload = JSON.parse(raw); } catch { return { ok: false, reason: 'not_found' }; }
  if (!payload.ownerLineUserId) return { ok: false, reason: 'not_found' };
  if (String(payload.expiresAt) < nowIso()) return { ok: false, reason: 'expired' };
  if (payload.ownerLineUserId === memberLineUserId) return { ok: false, reason: 'self' };

  const now = nowIso();
  const existing = await db
    .prepare('SELECT memberId FROM care_members WHERE memberLineUserId = ? AND ownerLineUserId = ?')
    .bind(memberLineUserId, payload.ownerLineUserId).first();
  if (existing) {
    await db.prepare("UPDATE care_members SET status = 'accepted', role = 'caregiver', acceptedAt = ?, updatedAt = ? WHERE memberId = ?")
      .bind(now, now, existing.memberId).run();
    return { ok: true, ownerLineUserId: payload.ownerLineUserId, already: true };
  }
  await db.prepare(
    `INSERT INTO care_members (memberId, petId, ownerLineUserId, memberLineUserId, role, status, invitedAt, acceptedAt, createdAt, updatedAt)
     VALUES (?, '*', ?, ?, 'caregiver', 'accepted', ?, ?, ?, ?)`
  ).bind(newId(), payload.ownerLineUserId, memberLineUserId, now, now, now, now).run();
  return { ok: true, ownerLineUserId: payload.ownerLineUserId };
}

// ---------- 電腦登入碼（在 LINE 取碼 → 電腦網站輸入即可登入）----------
// 6 位數字、10 分鐘有效、用一次即失效。存在 app_kv。
export async function createLoginCode(db, lineUserId) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await appKvSet(db, `logincode:${code}`, JSON.stringify({ lineUserId, expiresAt }));
  return code;
}

export async function redeemLoginCode(db, code) {
  const clean = String(code || '').trim();
  if (!/^\d{6}$/.test(clean)) return null;
  const key = `logincode:${clean}`;
  const raw = await appKvGet(db, key);
  if (!raw) return null;
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload.lineUserId || String(payload.expiresAt) < nowIso()) return null;
  await db.prepare('DELETE FROM app_kv WHERE k = ?').bind(key).run(); // 一次性
  return payload.lineUserId;
}

// 使用者最近一筆未刪除的紀錄（給「改 54」「剩 20」「刪除」修正上一筆用）
export async function getLastLogByUser(db, lineUserId) {
  return db
    .prepare('SELECT * FROM logs WHERE lineUserId = ? AND isDeleted = 0 ORDER BY createdAt DESC LIMIT 1')
    .bind(lineUserId)
    .first();
}
