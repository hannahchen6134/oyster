import { touchCustomer, auditExport, markDownload } from './customer-management.js';
import { buildAccountExport } from './account-export.js';
import { handleReportApi } from './report-sharing.js';
// 照護站 REST API（Bearer session token 授權）
// 所有資源都檢查擁有權：pet.ownerLineUserId 必須等於 session 使用者。

import { planStatus } from './plan.js';
import {
  getUser, updateUser, listPets, getPet, createPet,
  listFoods, getFood, resolveDefaultFood, setDefaultFood, clearDefaultFood, listDefaultFoods,
  insertLog, getLog, getLogsForDay, updateLog, softDeleteLog, resyncPetWeight,
  recomputeDay, getSummaries, getSessionUser, getRecentLogsByPet, getFoodTimeline, getFoodHistory,
  resolveDataOwner, createCareInvite, listCareMembers, track, healFoodKcal,
  updatePetFields, getAllLogsForPet, saveDataExport,
  createTask, getTask, listTasksForPet, completeTask, uncompleteTask, skipTask, cancelTask,
  listFoodAliases, setFoodAlias, deleteFoodAlias, ALIAS_FOODTYPES
} from './db.js';
import { displayMedStatus, displayMedSlot } from './brand.js';
import { computeDailySummary, deriveFoodFields, computeTodayBoard } from './summary.js';
import { matchFood, isAskableFoodName } from './parser.js';
import { jsonResponse, newId, nowIso, isValidDate, isValidDateTime, taipeiNowDateTime, taipeiToday } from './util.js';

// 支援「設為預設」的食物類型（各自獨立，不共用）：主食罐≠副食罐≠罐頭。
const DEFAULT_FOOD_TYPES = ['乾糧', '主食罐', '副食罐', '罐頭', '零食'];
// 「吃過的食物」時間軸可用的類型過濾（網站顯示正式名稱；口語別名只存在 LINE parser）。
const FOOD_TIMELINE_TYPES = ['主食罐', '副食罐', '罐頭', '乾糧', '零食'];

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

export async function handleApi(request, env, url, ctx) {
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

  if (resource === 'me' && method === 'GET') {
    const work=touchCustomer(db,lineUserId,'web').catch(()=>console.warn('activity_tracking_failed'));
    if(ctx?.waitUntil) ctx.waitUntil(work); else await work;
  }

  try {
    if (['care-template','care-organize','report-shares'].includes(resource)) return handleReportApi(request,env,url,lineUserId,dataOwnerId);
    // 網站行為追蹤 beacon（登入者才記；失敗不影響）
    if (resource === 'track' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      await track(db, lineUserId, String(body.event || '').slice(0, 40), body.meta || '');
      return jsonResponse({ ok: true });
    }
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

    // 今日照護看板：今天還要做什麼／完成了什麼（誰做的）／有沒有異常
    if (resource === 'today' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const date = url.searchParams.get('date') || taipeiToday();
      if (!isValidDate(date)) return jsonResponse({ ok: false, message: '日期格式錯誤' }, 400);
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const pet = await getPet(db, petId);
      const logs = await getLogsForDay(db, petId, date);
      const tasks = await listTasksForPet(db, petId, { date });
      const board = computeTodayBoard({ pet, tasks, logs, date });
      return jsonResponse({ ok: true, board });
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

    if (resource === 'weights' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const { results } = await db
        .prepare(
          `SELECT substr(eventDateTime, 1, 10) date, amount, eventDateTime
           FROM logs WHERE petId = ? AND category = 'weight' AND isDeleted = 0
           ORDER BY eventDateTime`
        )
        .bind(petId)
        .all();
      return jsonResponse({ ok: true, rows: results || [] });
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

    // 「吃過的食物」時間軸（純讀取）：實際吃過的 food logs 逐筆，最近在前；只補顯示名，不回推品牌。
    // owner 由 server resolve、petId 必須屬本家庭；days=all/0＝全部歷史、否則近 N 天；foodType 可選過濾。
    // 品項摘要（第一層）：實際吃過哪些品項，依 lastAt 由近到遠。重用 getFoodHistory（聚合、不重造）。
    if (resource === 'food-history' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const daysParam = String(url.searchParams.get('days') || '30');
      const sinceDays = (daysParam === 'all' || daysParam === '0') ? 0 : Math.min(3650, Math.max(1, Number(daysParam) || 30));
      const foodTypeParam = String(url.searchParams.get('foodType') || '');
      const foodType = FOOD_TIMELINE_TYPES.includes(foodTypeParam) ? foodTypeParam : '';
      const rows = await getFoodHistory(db, petId, { sinceDays: sinceDays || null, foodType });
      return jsonResponse({ ok: true, rows, days: sinceDays || 0 });
    }

    // 逐餐明細（第二層）：某品項（foodId）或某 generic 類型（generic=1＋foodType）的逐筆紀錄。
    if (resource === 'food-timeline' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const daysParam = String(url.searchParams.get('days') || '30');
      const sinceDays = (daysParam === 'all' || daysParam === '0') ? 0 : Math.min(3650, Math.max(1, Number(daysParam) || 30));
      const foodTypeParam = String(url.searchParams.get('foodType') || '');
      const foodType = FOOD_TIMELINE_TYPES.includes(foodTypeParam) ? foodTypeParam : '';
      const foodId = String(url.searchParams.get('foodId') || '');
      const genericOnly = url.searchParams.get('generic') === '1';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const rows = await getFoodTimeline(db, petId, { sinceDays, foodType, foodId, genericOnly, limit });
      return jsonResponse({ ok: true, rows, days: sinceDays || 0, limit });
    }

    // 給醫生的注意事項：只放需要留意的狀況——吐/疫苗/除蟲/精神/自由備註，以及「有描述」的排便排尿。
    // 不放喝水、進食、保健、用藥（那些是攝取量/例行，屬於組成與趨勢，不是注意事項）。
    // 用藥與回診不列（醫生要看的是異常，不是流水帳）。
    if (resource === 'highlights' && method === 'GET') {
      const petId = url.searchParams.get('petId') || '';
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 14));
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const today = taipeiToday();
      const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
      const { results: logs } = await db
        .prepare(
          `SELECT eventDateTime, category, itemName, amount, unit, note, isBackfilled
           FROM logs
           WHERE petId = ? AND isDeleted = 0 AND substr(eventDateTime, 1, 10) >= ?
             AND (category IN ('vomit', 'vaccine', 'deworm', 'note', 'mood')
                  OR (category IN ('stool', 'urine') AND note <> ''))
           ORDER BY eventDateTime ASC`
        )
        .bind(petId, from)
        .all();
      return jsonResponse({ ok: true, from, to: today, logs: logs || [] });
    }

    if (resource === 'export-download' && method === 'POST') {
      const body=await request.json();
      return jsonResponse({ok:await markDownload(db,lineUserId,String(body.exportId||''))});
    }
    if (resource === 'account-export' && method === 'POST') {
      if (dataOwnerId !== lineUserId) return forbidden();
      const archive=await buildAccountExport(db,lineUserId);
      const exportId=crypto.randomUUID();
      await auditExport(db,lineUserId,exportId,'JSON',archive.counts.logs,'全部貓咪');
      return jsonResponse({ ok:true, archive, exportId });
    }
    if (resource === 'export' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const petId = String(body.petId || '');
      if (!(await assertPetOwner(db, petId, dataOwnerId))) return forbidden();
      const pet = await getPet(db, petId);
      const logs = await getAllLogsForPet(db, petId);
      const csv = buildLogsCsv(logs);
      const safeName = String(pet?.petName || '貓咪').replace(/[\\/:*?"<>|\s]/g, '_');
      const filename = `喵喵照護紀錄_${safeName}_${taipeiToday()}.csv`;
      const id = await saveDataExport(db, dataOwnerId, filename, csv);
      await auditExport(db,dataOwnerId,id,'CSV',logs.length,pet?.petName||petId);
      return jsonResponse({ ok: true, url: `/export/${id}`, filename, count: logs.length });
    }

    if (resource === 'logs') {
      return handleLogs(db, request, method, resourceId, dataOwnerId, lineUserId);
    }

    if (resource === 'tasks') {
      return handleTasks(db, request, url, method, resourceId, segments[2] || '', dataOwnerId, lineUserId);
    }

    if (resource === 'labs') {
      return handleLabs(db, request, url, method, resourceId, dataOwnerId);
    }

    if (resource === 'care') {
      return handleCare(db, url, method, resourceId, dataOwnerId, lineUserId);
    }

    // 每個 foodType 的「家庭預設品項」（顯式設定，存 app_kv；不改 schema、不動 food_items）。
    // owner scope（dataOwnerId），不接受前端指定其他 owner；設定時驗證品項屬本家庭、未刪、類型相符。
    if (resource === 'default-food') {
      if (method === 'GET') {
        return jsonResponse({ ok: true, defaults: await listDefaultFoods(db, dataOwnerId, DEFAULT_FOOD_TYPES) });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const foodType = String(body.foodType || '');
        const foodId = String(body.foodId || '');
        if (!DEFAULT_FOOD_TYPES.includes(foodType)) return jsonResponse({ ok: false, message: '不支援的食物類型' }, 400);
        if (!foodId) { await clearDefaultFood(db, dataOwnerId, foodType); return jsonResponse({ ok: true, cleared: true }); }
        const food = await getFood(db, foodId); // 已排除 isDeleted
        if (!food || String(food.ownerLineUserId) !== String(dataOwnerId)) return forbidden(); // 找不到／已刪／跨家庭
        if (String(food.foodType) !== foodType) return jsonResponse({ ok: false, message: '品項類型與預設類型不符' }, 400);
        await setDefaultFood(db, dataOwnerId, foodType, foodId);
        return jsonResponse({ ok: true, foodType, foodId });
      }
      return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
    }

    // 家裡習慣的叫法（口語別名）：owner scope，只存 app_kv（不改 food_items/schema）。
    // targetType='foodType' → 值為支援類型；'foodItem' → 值為本家庭品項 foodId（server 端驗證，不接受跨家庭）。
    if (resource === 'food-aliases') {
      if (method === 'GET') {
        return jsonResponse({ ok: true, rows: await listFoodAliases(db, dataOwnerId) });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const alias = String(body.alias || '').trim();
        const targetType = String(body.targetType || '');
        const value = String(body.value || '');
        if (!isAskableFoodName(alias)) return jsonResponse({ ok: false, message: '這個叫法不適合（避免用到「今天」「體重」「喝水」這類詞，或帶數字）' }, 400);
        if (targetType === 'foodType') {
          if (!ALIAS_FOODTYPES.includes(value)) return jsonResponse({ ok: false, message: '不支援的食物類型' }, 400);
        } else if (targetType === 'foodItem') {
          const food = await getFood(db, value); // 已排除 isDeleted
          if (!food || String(food.ownerLineUserId) !== String(dataOwnerId)) return forbidden(); // 找不到／已刪／跨家庭
        } else {
          return jsonResponse({ ok: false, message: '請選擇這個叫法代表什麼' }, 400);
        }
        const saved = await setFoodAlias(db, dataOwnerId, alias, { targetType, value });
        return jsonResponse({ ok: true, alias: saved });
      }
      if (method === 'DELETE') {
        const alias = String(url.searchParams.get('alias') || '');
        if (!alias) return jsonResponse({ ok: false, message: '缺少叫法' }, 400);
        await deleteFoodAlias(db, dataOwnerId, alias);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
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

// ---------- 資料匯出：把某隻貓的紀錄轉成 CSV（試算表打得開）----------
const EXPORT_CATEGORY_LABEL = {
  water: '喝水', food: '吃飯', med: '用藥', vomit: '嘔吐',
  stool: '大便', urine: '尿尿', supplement: '營養補充', mood: '精神',
  weight: '體重', note: '備註'
};
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportFoodName(foodType, itemName) {
  const t = String(foodType || '').trim();
  const n = String(itemName || '').trim();
  if (!n) return t;
  if (!t) return n;
  return n.includes(t) ? n : `${t} ${n}`;
}
function buildLogsCsv(logs) {
  const headers = ['日期', '時間', '類別', '品項', '數量', '單位', '熱量(kcal)', '水分(ml)', '藥物狀態', '時段', '備註'];
  const lines = [headers.map(csvCell).join(',')];
  for (const log of logs) {
    const dt = String(log.eventDateTime || '');
    const item = log.category === 'food' ? exportFoodName(log.foodType, log.itemName) : (log.itemName || '');
    lines.push([
      dt.slice(0, 10),
      dt.slice(11, 16),
      EXPORT_CATEGORY_LABEL[log.category] || log.category || '',
      item,
      log.amount ?? '',
      log.unit || '',
      log.kcal ?? '',
      log.waterMl ?? '',
      displayMedStatus(log.medStatus),
      displayMedSlot(log.medSlot),
      log.note || ''
    ].map(csvCell).join(','));
  }
  // 加 BOM，Excel 開啟中文才不會亂碼
  return '﻿' + lines.join('\r\n');
}

// ---------- 共同照護（邀請碼、成員清單、移除）----------
async function handleCare(db, url, method, resourceId, ownerId, actorId) {
  if (resourceId === 'invite' && method === 'POST') {
    const code = await createCareInvite(db, ownerId);
    try { await track(db, ownerId, 'invite_created'); } catch (e) { /* ignore */ }
    return jsonResponse({ ok: true, code });
  }
  if (resourceId === 'members' && method === 'GET') {
    const members = await listCareMembers(db, ownerId);
    const ownerUser = await getUser(db, ownerId);
    const rows = [];
    for (const m of members) {
      const u = await getUser(db, m.memberLineUserId);
      rows.push({ memberLineUserId: m.memberLineUserId, name: (u && u.displayName) || '照護者', acceptedAt: m.acceptedAt });
    }
    return jsonResponse({
      ok: true,
      owner: { name: (ownerUser && ownerUser.displayName) || '飼主' },
      members: rows,
      isOwner: actorId === ownerId
    });
  }
  if (resourceId === 'member' && method === 'DELETE') {
    if (actorId !== ownerId) return forbidden(); // 只有飼主本人可移除共同照護者
    const memberLineUserId = url.searchParams.get('memberLineUserId') || '';
    await db.prepare('DELETE FROM care_members WHERE ownerLineUserId = ? AND memberLineUserId = ?')
      .bind(ownerId, memberLineUserId).run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ ok: false, message: 'Not found' }, 404);
}

async function assertPetOwner(db, petId, lineUserId) {
  if (!petId) return false;
  const pet = await getPet(db, petId);
  return Boolean(pet && pet.ownerLineUserId === lineUserId);
}

// ---------- tasks（任務；完成後在 logs 建立可追溯事件）----------

async function handleTasks(db, request, url, method, taskId, action, ownerId, actorId) {
  // 列出某隻貓的任務：/api/tasks?petId=&date=&status=
  if (method === 'GET' && !taskId) {
    const petId = String(url.searchParams.get('petId') || '');
    if (!(await assertPetOwner(db, petId, ownerId))) return forbidden();
    const rows = await listTasksForPet(db, petId, {
      status: String(url.searchParams.get('status') || ''),
      date: String(url.searchParams.get('date') || '')
    });
    return jsonResponse({ ok: true, tasks: rows });
  }

  // 新增任務：POST /api/tasks
  if (method === 'POST' && !taskId) {
    const body = await request.json().catch(() => ({}));
    const petId = String(body.petId || '');
    if (!(await assertPetOwner(db, petId, ownerId))) return forbidden();
    const task = await createTask(db, {
      petId,
      taskType: String(body.taskType || ''),
      title: String(body.title || ''),
      note: String(body.note || ''),
      scheduledAt: String(body.scheduledAt || ''),
      createdBy: actorId
    });
    return jsonResponse({ ok: true, task });
  }

  // 對單一任務的動作：POST /api/tasks/:id/(complete|uncomplete|skip|cancel)
  if (method === 'POST' && taskId) {
    const task = await getTask(db, taskId);
    if (!task) return jsonResponse({ ok: false, message: '找不到這個任務' }, 404);
    if (!(await assertPetOwner(db, task.petId, ownerId))) return forbidden();

    let result;
    if (action === 'complete') result = await completeTask(db, taskId, { completedBy: actorId });
    else if (action === 'uncomplete') result = await uncompleteTask(db, taskId, { actorId });
    else if (action === 'skip') result = await skipTask(db, taskId);
    else if (action === 'cancel') result = await cancelTask(db, taskId);
    else return jsonResponse({ ok: false, message: '不支援的任務動作' }, 400);

    if (!result.ok) return jsonResponse({ ok: false, message: `任務狀態不允許此操作（${result.reason}）` }, 409);
    return jsonResponse(result);
  }

  return jsonResponse({ ok: false, message: '不支援的請求' }, 405);
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
      // 來源標記：完整表單＝web、今天頁快速盤點按＝web-quick。
      // 只接受這兩個網站來源；line／task 由伺服端各自流程設定，不吃前端傳入，避免被冒充。
      source: ['web', 'web-quick'].includes(String(body.source || '')) ? String(body.source) : 'web',
      updatedBy: actorId
    });

    const saved = await insertLog(db, log);
    // 食物另外加的水（例：泡罐頭的水）→ 另記一筆喝水，計入當日補水（比照 LINE）
    const addedWaterMl = category === 'food' ? Number(body.addedWaterMl || 0) : 0;
    if (addedWaterMl > 0) {
      await insertLog(db, {
        lineUserId, petId, eventDateTime,
        category: 'water', itemName: '', foodType: '', foodId: '',
        amount: addedWaterMl, unit: 'ml', waterMl: addedWaterMl, kcal: 0,
        medStatus: '', medSlot: '', doseText: '', medForm: '', beforeMeal: '',
        note: '罐頭加水',
        recordedBy: actorId, isBackfilled: log.isBackfilled, source: 'web', updatedBy: actorId
      });
    }
    // 記體重時同步更新貓咪目前體重（每公斤喝水量、熱量目標都靠這個）——
    // 用 resync 依「最新未刪除體重」回算，補記舊日期也不會把目前體重錯設成舊值。
    if (category === 'weight') {
      await resyncPetWeight(db, petId);
    }
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
    // 體重是健康資料：伺服端也守一道，拒收空值/0/負數/非數字，絕不把 amount 清成 0（前端已擋，這裡防繞過）
    if (existing.category === 'weight' && 'amount' in body) {
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n <= 0) return jsonResponse({ ok: false, message: '體重須為大於 0 的數字' }, 400);
    }

    const merged = await applyDerivedFields(db, { ...existing, ...body });
    const updated = await updateLog(db, logId, merged, actorId);

    // 編輯食物時同步「泡罐頭的水」那筆喝水（addedWaterMl 有帶才動；>0 更新/新建、=0 移除）
    if (existing.category === 'food' && 'addedWaterMl' in body) {
      const aw = Number(body.addedWaterMl || 0);
      const linked = await db.prepare(
        `SELECT * FROM logs WHERE petId = ? AND category = 'water' AND note = '罐頭加水' AND isDeleted = 0 AND eventDateTime = ? LIMIT 1`
      ).bind(existing.petId, existing.eventDateTime).first();
      if (aw > 0) {
        if (linked) await updateLog(db, linked.logId, { amount: aw, waterMl: aw, eventDateTime: updated.eventDateTime }, actorId);
        else await insertLog(db, {
          lineUserId: existing.lineUserId, petId: existing.petId, eventDateTime: updated.eventDateTime,
          category: 'water', itemName: '', foodType: '', foodId: '', amount: aw, unit: 'ml', waterMl: aw, kcal: 0,
          medStatus: '', medSlot: '', doseText: '', medForm: '', beforeMeal: '', note: '罐頭加水',
          recordedBy: actorId, isBackfilled: updated.isBackfilled, source: 'web', updatedBy: actorId
        });
      } else if (linked) {
        await softDeleteLog(db, linked.logId, actorId);
      }
    }

    const oldDate = String(existing.eventDateTime).slice(0, 10);
    const newDate = String(updated.eventDateTime).slice(0, 10);
    const summary = await recomputeDay(db, existing.petId, newDate);
    if (oldDate !== newDate) await recomputeDay(db, existing.petId, oldDate);
    // 網站改體重數字後，同步回算目前體重（先前缺這步，改完趨勢對、目前體重卻沒跟著動）
    if (existing.category === 'weight') await resyncPetWeight(db, existing.petId);
    return jsonResponse({ ok: true, log: updated, summary });
  }

  if (method === 'DELETE') {
    await softDeleteLog(db, logId, lineUserId);
    const summary = await recomputeDay(db, existing.petId, String(existing.eventDateTime).slice(0, 10));
    // 刪除體重後回退到上一筆未刪除體重（先前缺這步，刪最新體重後目前體重仍停在被刪的值）
    if (existing.category === 'weight') await resyncPetWeight(db, existing.petId);
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
      food = matchFood(foods, result.itemName, result.foodType); // ①句中明確品牌優先
      if (!food && !String(result.itemName || '').trim()) {
        food = await resolveDefaultFood(db, result.lineUserId, result.foodType); // ②家庭該類型預設品項
        if (!food) {
          const sameType = foods.filter((item) => !item.isDeleted && item.foodType === result.foodType);
          if (sameType.length === 1) food = sameType[0]; // ③該類型唯一品項
        }
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

  // 一次存一份摘要：覆蓋同一天既有的項目
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

  // 刪除某一天的整份摘要：DELETE /api/labs/date?petId=&date=
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
    // ④ 食物填了熱量公式 → 回頭補算過去沒算到熱量的紀錄
    let healed = 0;
    if (spec.table === 'food_items') {
      try { ({ healed } = await healFoodKcal(db, row)); } catch (error) { console.error('healFoodKcal failed:', error.message); }
    }
    return jsonResponse({ ok: true, row, healed });
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
    // ④ 食物公式被更新（例如補上/改了每克熱量）→ 回頭補算過去沒算到熱量的紀錄
    let healed = 0;
    if (spec.table === 'food_items') {
      try { ({ healed } = await healFoodKcal(db, row)); } catch (error) { console.error('healFoodKcal failed:', error.message); }
    }
    return jsonResponse({ ok: true, row, healed });
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
