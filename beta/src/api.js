// 照護站 REST API（Bearer session token 授權）
// 所有資源都檢查擁有權：pet.ownerLineUserId 必須等於 session 使用者。

import { planStatus } from './plan.js';
import {
  getUser, updateUser, listPets, getPet, createPet,
  listFoods, getFood,
  insertLog, getLog, getLogsForDay, updateLog, softDeleteLog,
  recomputeDay, getSummaries, getSessionUser, getRecentLogsByPet,
  resolveDataOwner
} from './db.js';
import { computeDailySummary, deriveFoodFields } from './summary.js';
import { matchFood } from './parser.js';
import { jsonResponse, newId, nowIso, isValidDate, isValidDateTime, taipeiNowDateTime } from './util.js';

const RESOURCES = {
  pets: {
    table: 'pets',
    idColumn: 'petId',
    ownerColumn: 'ownerLineUserId',
    fields: {
      petName: 'text', species: 'text', birthday: 'text', breed: 'text',
      weightKg: 'number', chipNumber: 'text', conditionNote: 'text', vaccineNote: 'text', defaultVetId: 'text',
      goalWaterMl: 'number', goalKcal: 'number', goalMedSlots: 'text', reminderJson: 'text'
    },
    required: ['petName']
  },
  foods: {
    table: 'food_items',
    idColumn: 'foodId',
    ownerColumn: 'ownerLineUserId',
    fields: {
      brand: 'text', productName: 'text', displayName: 'text', foodType: 'text',
      kcalPerGram: 'number', waterRatio: 'number', isPrescription: 'number', note: 'text'
    },
    required: ['displayName']
  },
  meds: {
    table: 'meds',
    idColumn: 'medId',
    petColumn: 'petId',
    fields: {
      petId: 'text', medName: 'text', doseAmount: 'number', doseUnit: 'text',
      schedule: 'text', defaultTimes: 'text', instruction: 'text', note: 'text'
    },
    required: ['petId', 'medName']
  },
  vets: {
    table: 'vets',
    idColumn: 'vetId',
    ownerColumn: 'ownerLineUserId',
    fields: {
      hospitalName: 'text', doctorName: 'text', phone: 'text', address: 'text', note: 'text'
    },
    required: ['hospitalName']
  },
  visits: {
    table: 'vet_visits',
    idColumn: 'visitId',
    petColumn: 'petId',
    fields: {
      petId: 'text', vetId: 'text', visitDate: 'text', visitTime: 'text', reason: 'text',
      doctorInstruction: 'text', nextVisitDate: 'text', note: 'text'
    },
    required: ['petId']
  }
};

export async function handleApi(request, env, url) {
  const db = env.DB;
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const lineUserId = await getSessionUser(db, token);
  if (!lineUserId) return jsonResponse({ ok: false, message: '這個照護站連結已過期。請回 LINE 輸入「照護站」取得新的專屬連結，你的既有照護資料不會因連結過期而消失。' }, 401);
  // 共同照護者以自己的 LINE 登入，資料解析到飼主本人；飼主本人時 dataOwnerId === lineUserId，行為不變。
  const dataOwnerId = await resolveDataOwner(db, lineUserId);

  const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const resource = segments[0] || '';
  const resourceId = segments[1] || '';
  const method = request.method;

  try {
    if (resource === 'me') {
      if (method === 'GET') {
        const user = await getUser(db, lineUserId);
        const pets = await listPets(db, dataOwnerId);
        return jsonResponse({ ok: true, user, pets, plan: planStatus(user), isCaregiver: dataOwnerId !== lineUserId });
      }
      if (method === 'PUT') {
        const body = await request.json();
        const user = await updateUser(db, lineUserId, body || {});
        return jsonResponse({ ok: true, user });
      }
    }

    if (resource === 'day' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const date = url.searchParams.get('date') || '';
      if (!isValidDate(date)) return jsonResponse({ ok: false, message: '日期格式錯誤' }, 400);
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const logs = await getLogsForDay(db, petId, date);
      return jsonResponse({ ok: true, date, logs, summary: computeDailySummary(logs) });
    }

    if (resource === 'summary' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      if (!isValidDate(from) || !isValidDate(to)) return jsonResponse({ ok: false, message: '日期格式錯誤' }, 400);
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const rows = await getSummaries(db, petId, from, to);
      return jsonResponse({ ok: true, rows });
    }

    if (resource === 'month' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const month = url.searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ ok: false, message: '月份格式錯誤' }, 400);
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const rows = await getSummaries(db, petId, `${month}-01`, `${month}-31`);
      const { results: visits } = await db
        .prepare(
          `SELECT * FROM vet_visits WHERE petId = ? AND isDeleted = 0
           AND (substr(visitDate, 1, 7) = ? OR substr(nextVisitDate, 1, 7) = ?)`
        )
        .bind(petId, month, month)
        .all();
      return jsonResponse({ ok: true, rows, visits: visits || [] });
    }

    if (resource === 'recent' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const logs = await getRecentLogsByPet(db, petId, limit);
      return jsonResponse({ ok: true, logs });
    }

    if (resource === 'logs') {
      return handleLogs(db, request, method, resourceId, dataOwnerId, lineUserId);
    }

    if (resource === 'labs') {
      return handleLabs(db, request, url, method, resourceId, dataOwnerId);
    }

    if (RESOURCES[resource]) {
      return handleCrud(db, RESOURCES[resource], request, url, method, resourceId, dataOwnerId);
    }

    return jsonResponse({ ok: false, message: 'Not found' }, 404);
  } catch (error) {
    console.error('API error:', url.pathname, error);
    return jsonResponse({ ok: false, message: error.message || '伺服器錯誤' }, 500);
  }
}

function forbidden() {
  return jsonResponse({ ok: false, message: '沒有權限存取這筆資料' }, 403);
}

async function assertPetOwner(db, petId, lineUserId) {
  if (!petId) return false;
  const pet = await getPet(db, petId);
  return Boolean(pet && pet.ownerLineUserId === lineUserId);
}

// ---------- logs（新增/修改/刪除都要重算 daily_summary）----------

async function handleLogs(db, request, method, logId, lineUserId, actorId = lineUserId) {
  if (method === 'POST') {
    const body = await request.json();
    const petId = String(body.petId || '');
    if (!(await assertPetOwner(db, petId, lineUserId))) return forbidden();

    const category = String(body.category || '');
    if (!category) return jsonResponse({ ok: false, message: '缺少紀錄類別' }, 400);

    let eventDateTime = String(body.eventDateTime || '');
    if (!eventDateTime) eventDateTime = taipeiNowDateTime();
    if (!isValidDateTime(eventDateTime)) return jsonResponse({ ok: false, message: '時間格式須為 YYYY-MM-DD HH:MM' }, 400);

    const log = await applyDerivedFields(db, {
      lineUserId,
      petId,
      eventDateTime,
      category,
      itemName: String(body.itemName || ''),
      foodType: String(body.foodType || ''),
      foodId: String(body.foodId || ''),
      amount: Number(body.amount || 0),
      unit: String(body.unit || ''),
      waterMl: Number(body.waterMl || 0),
      kcal: Number(body.kcal || 0),
      medStatus: String(body.medStatus || ''),
      medSlot: String(body.medSlot || ''),
      doseText: String(body.doseText || ''),
      medForm: String(body.medForm || ''),
      beforeMeal: String(body.beforeMeal || ''),
      note: String(body.note || ''),
      recordedBy: actorId,
      isBackfilled: eventDateTime.slice(0, 10) === taipeiNowDateTime().slice(0, 10) ? 0 : 1,
      source: 'web',
      updatedBy: actorId
    });

    const saved = await insertLog(db, log);
    const summary = await recomputeDay(db, petId, eventDateTime.slice(0, 10));
    return jsonResponse({ ok: true, log: saved, summary });
  }

  if (!logId) return jsonResponse({ ok: false, message: '缺少紀錄 ID' }, 400);
  const existing = await getLog(db, logId);
  if (!existing || existing.isDeleted) return jsonResponse({ ok: false, message: '找不到這筆紀錄' }, 404);
  if (!(await assertPetOwner(db, existing.petId, lineUserId))) return forbidden();

  if (method === 'PUT') {
    const body = await request.json();
    if ('eventDateTime' in body && !isValidDateTime(String(body.eventDateTime || ''))) {
      return jsonResponse({ ok: false, message: '時間格式須為 YYYY-MM-DD HH:MM' }, 400);
    }

    const merged = await applyDerivedFields(db, { ...existing, ...body });
    const updated = await updateLog(db, logId, merged, actorId);

    const oldDate = String(existing.eventDateTime).slice(0, 10);
    const newDate = String(updated.eventDateTime).slice(0, 10);
    const summary = await recomputeDay(db, existing.petId, newDate);
    if (oldDate !== newDate) await recomputeDay(db, existing.petId, oldDate);
    return jsonResponse({ ok: true, log: updated, summary });
  }

  if (method === 'DELETE') {
    await softDeleteLog(db, logId, lineUserId);
    const summary = await recomputeDay(db, existing.petId, String(existing.eventDateTime).slice(0, 10));
    return jsonResponse({ ok: true, summary });
  }

  return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
}

// 依類別自動補齊 waterMl / kcal：
// - water：waterMl = amount
// - food：waterMl 依品項水分比例（罐頭/濕食未設定時預設 80%），
//         kcal 只在有設定公式的品項計算，且用原始克數
async function applyDerivedFields(db, log) {
  const result = { ...log };
  if (result.category === 'water') {
    result.waterMl = Number(result.amount || 0);
    result.unit = 'ml';
  }
  if (result.category === 'food') {
    let food = result.foodId ? await getFood(db, result.foodId) : null;
    // 沒指定公式時，比照 LINE：先用品名比對常吃的食物，再用「該類型唯一公式」自動套用，
    // 這樣在網站只選了「乾糧／罐頭」也能算出熱量，不會顯示 0。
    if (!food) {
      const foods = await listFoods(db, result.lineUserId);
      food = matchFood(foods, result.itemName, result.foodType);
      if (!food && !String(result.itemName || '').trim()) {
        const sameType = foods.filter((item) => !item.isDeleted && item.foodType === result.foodType);
        if (sameType.length === 1) food = sameType[0];
      }
      if (food) result.foodId = food.foodId; // 綁定公式，之後編輯或重算才會持續正確
    }
    if (food) {
      if (!result.itemName) result.itemName = food.displayName;
      if (!result.foodType) result.foodType = food.foodType;
    }
    const derived = deriveFoodFields(result.amount, result.foodType, food);
    result.kcal = derived.kcal;
    result.waterMl = derived.waterMl;
    result.unit = 'g';
  }
  return result;
}

// ---------- labs（血檢：同一天多個項目，一次整份存）----------

async function handleLabs(db, request, url, method, resourceId, lineUserId) {
  if (method === 'GET') {
    const petId = url.searchParams.get('petId') || '';
    if (!(await assertPetOwner(db, petId, lineUserId))) return forbidden();
    const { results } = await db
      .prepare('SELECT * FROM labs WHERE petId = ? AND isDeleted = 0 ORDER BY testDate, itemName')
      .bind(petId)
      .all();
    return jsonResponse({ ok: true, rows: results || [] });
  }

  // 一次存一份報告：覆蓋同一天既有的項目
  if (method === 'POST' && resourceId === 'bulk') {
    const body = await request.json();
    const petId = String(body.petId || '');
    const testDate = String(body.testDate || '');
    if (!(await assertPetOwner(db, petId, lineUserId))) return forbidden();
    if (!isValidDate(testDate)) return jsonResponse({ ok: false, message: '日期格式錯誤' }, 400);

    const now = nowIso();
    await db
      .prepare('UPDATE labs SET isDeleted = 1, updatedAt = ? WHERE petId = ? AND testDate = ?')
      .bind(now, petId, testDate)
      .run();

    const items = Array.isArray(body.items) ? body.items : [];
    let saved = 0;
    for (const item of items) {
      const itemName = String(item.itemName || '').trim();
      const value = Number(item.value);
      if (!itemName || !Number.isFinite(value)) continue;
      await db
        .prepare(
          `INSERT INTO labs (labId, petId, testDate, itemName, value, unit, refLow, refHigh, note, isDeleted, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .bind(
          newId(), petId, testDate, itemName, value,
          String(item.unit || ''), Number(item.refLow || 0), Number(item.refHigh || 0),
          String(item.note || ''), now, now
        )
        .run();
      saved += 1;
    }
    return jsonResponse({ ok: true, saved });
  }

  // 刪除某一天的整份報告：DELETE /api/labs/date?petId=&date=
  if (method === 'DELETE' && resourceId === 'date') {
    const petId = url.searchParams.get('petId') || '';
    const date = url.searchParams.get('date') || '';
    if (!(await assertPetOwner(db, petId, lineUserId))) return forbidden();
    await db
      .prepare('UPDATE labs SET isDeleted = 1, updatedAt = ? WHERE petId = ? AND testDate = ?')
      .bind(nowIso(), petId, date)
      .run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
}

// ---------- 泛用 CRUD（pets / foods / meds / vets / visits）----------

async function handleCrud(db, spec, request, url, method, resourceId, lineUserId) {
  if (method === 'GET') {
    if (spec.ownerColumn) {
      const { results } = await db
        .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.ownerColumn} = ? AND isDeleted = 0 ORDER BY createdAt`)
        .bind(lineUserId)
        .all();
      return jsonResponse({ ok: true, rows: results || [] });
    }
    // pet 子資源（meds / visits）：?petId=
    const petId = url.searchParams.get('petId') || '';
    if (!(await assertPetOwner(db, petId, lineUserId))) return forbidden();
    const { results } = await db
      .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.petColumn} = ? AND isDeleted = 0 ORDER BY createdAt`)
      .bind(petId)
      .all();
    return jsonResponse({ ok: true, rows: results || [] });
  }

  if (method === 'POST') {
    const body = await request.json();
    for (const key of spec.required) {
      const value = body[key];
      if (value === undefined || value === null || String(value).trim() === '') {
        return jsonResponse({ ok: false, message: `缺少必填欄位：${key}` }, 400);
      }
    }
    if (spec.petColumn) {
      if (!(await assertPetOwner(db, String(body.petId || ''), lineUserId))) return forbidden();
    }

    if (spec.table === 'pets') {
      const pet = await createPet(db, lineUserId, body);
      return jsonResponse({ ok: true, row: pet });
    }

    const id = newId();
    const now = nowIso();
    const columns = [spec.idColumn];
    const values = [id];
    if (spec.ownerColumn) {
      columns.push(spec.ownerColumn);
      values.push(lineUserId);
    }
    for (const [key, kind] of Object.entries(spec.fields)) {
      columns.push(key);
      values.push(kind === 'number' ? Number(body[key] || 0) : String(body[key] ?? ''));
    }
    columns.push('isDeleted', 'createdAt', 'updatedAt');
    values.push(0, now, now);

    await db
      .prepare(`INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .bind(...values)
      .run();
    const row = await db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idColumn} = ?`).bind(id).first();
    return jsonResponse({ ok: true, row });
  }

  if (!resourceId) return jsonResponse({ ok: false, message: '缺少資源 ID' }, 400);
  const existing = await db
    .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idColumn} = ? AND isDeleted = 0`)
    .bind(resourceId)
    .first();
  if (!existing) return jsonResponse({ ok: false, message: '找不到資料' }, 404);
  const owned = spec.ownerColumn
    ? existing[spec.ownerColumn] === lineUserId
    : await assertPetOwner(db, existing[spec.petColumn], lineUserId);
  if (!owned) return forbidden();

  if (method === 'PUT') {
    const body = await request.json();
    const sets = [];
    const values = [];
    for (const [key, kind] of Object.entries(spec.fields)) {
      if (!(key in body)) continue;
      if (key === 'petId') continue; // 不允許把資料搬到別隻貓咪
      sets.push(`${key} = ?`);
      values.push(kind === 'number' ? Number(body[key] || 0) : String(body[key] ?? ''));
    }
    if (sets.length) {
      values.push(nowIso(), resourceId);
      await db
        .prepare(`UPDATE ${spec.table} SET ${sets.join(', ')}, updatedAt = ? WHERE ${spec.idColumn} = ?`)
        .bind(...values)
        .run();
    }
    const row = await db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idColumn} = ?`).bind(resourceId).first();
    return jsonResponse({ ok: true, row });
  }

  if (method === 'DELETE') {
    await db
      .prepare(`UPDATE ${spec.table} SET isDeleted = 1, updatedAt = ? WHERE ${spec.idColumn} = ?`)
      .bind(nowIso(), resourceId)
      .run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
}
