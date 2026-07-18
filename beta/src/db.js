// D1 資料存取層：使用者、貓咪、食物、紀錄、每日總結重算、session
// 規則：所有刪除都是 isDeleted 軟刪除；logs 有任何變動就重算該日 daily_summary。

import { computeDailySummary } from './summary.js';
import { newId, newToken, nowIso, addDays } from './util.js';

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

// ---------- logs ----------

export async function insertLog(db, log) {
  const now = nowIso();
  const logId = log.logId || newId();
  await db
    .prepare(
      `INSERT INTO logs (logId, lineUserId, petId, eventDateTime, category, itemName, foodType, foodId,
        amount, unit, waterMl, kcal, medStatus, medSlot, doseText, medForm, beforeMeal, note, sourceMessageId,
        recordedBy, caregiverName, isBackfilled, source, isDeleted,
        createdAt, updatedAt, updatedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
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
      String(log.updatedBy || log.lineUserId || '')
    )
    .run();
  return getLog(db, logId);
}

export async function getLog(db, logId) {
  return db.prepare('SELECT * FROM logs WHERE logId = ?').bind(logId).first();
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
