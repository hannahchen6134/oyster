// 貓貓照護管家 Beta — Cloudflare Worker 入口
// /webhook  → LINE Messaging API webhook（驗簽後直接處理、直接 reply，不需早回 ack）
// /api/*    → 照護站 REST API
// 其餘路徑 → 照護站網站（public/ 靜態資源）

import { parseMessage, matchFood, normalizeText } from './parser.js';
import { handleApi } from './api.js';
import { verifyLineSignature, replyOrPush, replyOrPushFlex, replyMessages, pushText, pushMessages, getProfile } from './line.js';
import { hasAnyReminder, parseReminderSettings, buildReminderLines, reminderMessage, visitReminderMessage } from './reminders.js';
import { shortDate } from './replies.js';
import { recordFlex, todayFlex, websiteFlex, menuFlex, recordMenuFlex, weekFlex, reminderFlex, visitReminderFlex } from './flex.js';
import {
  ensureUser, updateUser, listPets, createPet, resolveDefaultPet, getPet,
  listFoods, getFood, insertLog, getLog, getLastLogByUser, softDeleteLog, updateLog,
  recomputeDay, getRecentSummaries,
  upcomingVisits, listVetsByOwner, createSession
} from './db.js';
import {
  recordReply, todayReply, weekReply, monthReply, visitReply,
  websiteReply, helpText, welcomeText, unknownReply, invalidReply,
  recordTutorial, medTutorial, onboardingText, recordPrompt, backfillGuide
} from './replies.js';
import { jsonResponse, taipeiToday, taipeiNowDateTime, addDays } from './util.js';

// LINE 重送去重（單一 isolate 內有效，Beta 足夠）
const seenMessageIds = new Map();
const SEEN_TTL_MS = 1000 * 60 * 60;

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, timestamp] of seenMessageIds) {
    if (now - timestamp > SEEN_TTL_MS) seenMessageIds.delete(id);
  }
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, now);
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, url);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'cat-care-beta', now: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },

  // 每晚 21:00（台北）檢查照護提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReminders(env));
  }
};

async function runDailyReminders(env) {
  const db = env.DB;
  const today = taipeiToday();
  const { results: pets } = await db.prepare('SELECT * FROM pets WHERE isDeleted = 0').all();

  const tomorrow = addDays(today, 1);

  for (const pet of pets || []) {
    try {
      if (!hasAnyReminder(pet) || !pet.ownerLineUserId) continue;
      const settings = parseReminderSettings(pet);

      const rows = await getRecentSummaries(db, pet.petId, today, 8);
      const lines = buildReminderLines(pet, rows);
      if (lines.length) {
        try {
          await pushMessages(env, pet.ownerLineUserId, [reminderFlex(pet, lines)]);
        } catch (flexError) {
          console.warn('reminder flex failed, fallback to text:', flexError.message);
          await pushText(env, pet.ownerLineUserId, reminderMessage(pet, lines));
        }
        console.log(JSON.stringify({ step: 'reminder_sent', petId: pet.petId, count: lines.length }));
      }

      // 明天有回診 → 今晚另外提醒一則
      if (settings.visit) {
        const { results: visits } = await db
          .prepare(
            `SELECT * FROM vet_visits WHERE petId = ? AND isDeleted = 0
             AND (visitDate = ? OR nextVisitDate = ?)`
          )
          .bind(pet.petId, tomorrow, tomorrow)
          .all();
        if (visits?.length) {
          const vets = await listVetsByOwner(db, pet.ownerLineUserId);
          const vetsById = Object.fromEntries(vets.map((vet) => [vet.vetId, vet]));
          try {
            await pushMessages(env, pet.ownerLineUserId, [visitReminderFlex(pet, visits, vetsById, shortDate(tomorrow))]);
          } catch (flexError) {
            console.warn('visit flex failed, fallback to text:', flexError.message);
            await pushText(env, pet.ownerLineUserId, visitReminderMessage(pet, visits, vetsById, shortDate(tomorrow)));
          }
          console.log(JSON.stringify({ step: 'visit_reminder_sent', petId: pet.petId }));
        }
      }
    } catch (error) {
      console.error('reminder failed:', pet.petId, error.message);
    }
  }
}

async function handleWebhook(request, env, url) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-line-signature') || '';

  if (!(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET || ''))) {
    return jsonResponse({ ok: false, message: 'Invalid signature' }, 401);
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (error) {
    return jsonResponse({ ok: false, message: 'Invalid JSON' }, 400);
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const baseUrl = String(env.APP_BASE_URL || '').trim() || url.origin;

  for (const event of events) {
    try {
      if (event.type === 'follow') {
        await handleFollow(event, env);
      } else if (event.type === 'message' && event.message?.type === 'text') {
        if (isDuplicateMessage(event.message.id)) continue;
        await handleTextMessage(event, env, baseUrl);
      } else if (event.type === 'postback') {
        await handlePostback(event, env);
      }
    } catch (error) {
      console.error('event handling failed:', error);
      try {
        await replyOrPush(env, event, '系統忙碌中，\n這筆沒有記錄成功，\n請再傳一次 🙏');
      } catch (replyError) {
        console.error('error reply failed:', replyError);
      }
    }
  }

  return jsonResponse({ ok: true });
}

// Flex 卡片按鈕：目前只有「刪除這筆」
async function handlePostback(event, env) {
  const db = env.DB;
  const lineUserId = event.source?.userId;
  const data = new URLSearchParams(String(event.postback?.data || ''));

  if (data.get('action') === 'delLog') {
    const log = await getLog(db, data.get('logId') || '');
    if (!log || log.lineUserId !== lineUserId) {
      await replyOrPush(env, event, '找不到這筆紀錄');
      return;
    }
    if (log.isDeleted) {
      await replyOrPush(env, event, '這筆已經刪除過了');
      return;
    }
    await softDeleteLog(db, log.logId, lineUserId);
    const summary = await recomputeDay(db, log.petId, String(log.eventDateTime).slice(0, 10));
    await replyOrPush(env, event, `🗑 已刪除，總結重算完成\n水分 ${summary.totalWaterMl} ml\n熱量 ${summary.kcal} kcal`);
  }
}

async function handleFollow(event, env) {
  const lineUserId = event.source?.userId;
  if (!lineUserId) return;

  const profile = await getProfile(env, lineUserId);
  const { user } = await ensureUser(env.DB, lineUserId, profile?.displayName || '');
  if (profile?.displayName && user.displayName !== profile.displayName) {
    await updateUser(env.DB, lineUserId, { displayName: profile.displayName });
  }
  await replyOrPush(env, event, welcomeText());
}

async function handleTextMessage(event, env, baseUrl) {
  const db = env.DB;
  const lineUserId = event.source?.userId;

  if (event.source?.type !== 'user' || !lineUserId) {
    await replyOrPush(env, event, 'Beta 版目前僅支援一對一聊天，請直接私訊我唷 🐾');
    return;
  }

  const { user, created } = await ensureUser(db, lineUserId);
  if (created) {
    const profile = await getProfile(env, lineUserId);
    if (profile?.displayName) await updateUser(db, lineUserId, { displayName: profile.displayName });
  }

  const pets = await listPets(db, lineUserId);

  // 多貓咪：訊息開頭是貓咪名（或 @貓咪名）時指定該貓咪
  let text = normalizeText(event.message?.text || '');
  let pet = await resolveDefaultPet(db, user, pets);
  for (const candidate of pets) {
    for (const prefix of [candidate.petName, `@${candidate.petName}`]) {
      if (text === prefix) {
        pet = candidate;
        text = '今天'; // 只打貓咪名 → 看該貓咪今天總結
        break;
      }
      if (text.startsWith(`${prefix} `)) {
        pet = candidate;
        text = text.slice(prefix.length).trim();
        break;
      }
    }
  }

  // 說明選單卡的教學子頁
  if (text === '如何記錄') {
    await replyOrPush(env, event, recordTutorial());
    return;
  }
  if (text === '如何記餵藥' || text === '如何記藥') {
    await replyOrPush(env, event, medTutorial());
    return;
  }

  const intent = parseMessage(text);

  switch (intent.type) {
    case 'addPet': {
      const existing = pets.find((p) => p.petName === intent.name);
      if (existing) {
        await replyOrPush(env, event, `「${intent.name}」已經建立過了，直接開始記錄吧！`);
        return;
      }
      const newPet = await createPet(db, lineUserId, { petName: intent.name });
      if (!pets.length) await updateUser(db, lineUserId, { defaultPetId: newPet.petId });
      await replyOrPush(env, event, `🐾 已建立貓咪「${intent.name}」！\n輸入「水 20」開始記錄。\n生日體重等資料，\n可到照護站補齊。`);
      return;
    }

    case 'record': {
      if (!pet) {
        pet = await createPet(db, lineUserId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      await handleRecord(env, event, pet, intent.record, lineUserId);
      return;
    }

    case 'query': {
      await handleQuery(env, event, user, pet, intent.query, baseUrl, lineUserId);
      return;
    }

    case 'fixLast': {
      await handleFixLast(env, event, lineUserId, intent);
      return;
    }

    case 'deleteLast': {
      await handleDeleteLast(env, event, lineUserId);
      return;
    }

    case 'recordPrompt': {
      await replyOrPush(env, event, recordPrompt(intent.kind));
      return;
    }

    case 'fixHint': {
      await replyOrPush(env, event, '修正上一筆：\n改 54（改數量）\n剩 20（沒吃完扣掉）\n刪除（整筆刪掉）');
      return;
    }

    case 'invalid': {
      await replyOrPush(env, event, invalidReply(intent.reason, intent.category));
      return;
    }

    default: {
      await replyOrPush(env, event, unknownReply());
    }
  }
}

// 上一筆的簡短描述（修正/刪除回覆用）
function describeLog(log) {
  if (log.category === 'water') return `水 ${log.amount} ml`;
  if (log.category === 'food') return `${log.foodType}${log.itemName ? ` ${log.itemName}` : ''} ${log.amount} g`;
  if (log.category === 'med') {
    const label = [log.medSlot, log.itemName].filter(Boolean).join(' ');
    return `藥${label ? ` ${label}` : ''} ${log.medStatus}`;
  }
  const names = { vomit: '嘔吐', stool: '便便', mood: '精神', note: '備註' };
  return `${names[log.category] || log.category}${log.note ? `：${log.note}` : ''}`;
}

// 「改 54」「剩 20」：修正最近一筆的數量
async function handleFixLast(env, event, lineUserId, intent) {
  const db = env.DB;
  const last = await getLastLogByUser(db, lineUserId);
  if (!last) {
    await replyOrPush(env, event, '找不到可以修改的紀錄，\n先記一筆吧！');
    return;
  }
  if (!['water', 'food'].includes(last.category)) {
    await replyOrPush(env, event, `上一筆是「${describeLog(last)}」，\n沒有數量可以改。\n輸入「刪除」可整筆刪掉。`);
    return;
  }

  let newAmount = intent.mode === 'set'
    ? intent.amount
    : Math.round((Number(last.amount) - intent.amount) * 10) / 10;
  if (newAmount < 0) newAmount = 0;

  const fields = { amount: newAmount };
  if (last.category === 'water') {
    fields.waterMl = newAmount;
  } else if (last.foodId) {
    const food = await getFood(db, last.foodId);
    if (food) {
      fields.kcal = Math.round(newAmount * Number(food.kcalPerGram || 0) * 10) / 10;
      fields.waterMl = Math.round(newAmount * Number(food.waterRatio || 0) * 10) / 10;
    }
  }

  const updated = await updateLog(db, last.logId, fields, lineUserId);
  const eventDate = String(updated.eventDateTime).slice(0, 10);
  const summary = await recomputeDay(db, updated.petId, eventDate);
  const cardPet = await getPet(db, updated.petId);

  const subParts = [];
  if (updated.kcal) subParts.push(`${updated.kcal} kcal`);
  if (updated.category === 'food' && updated.waterMl) subParts.push(`水 ${updated.waterMl} ml`);
  if (intent.mode === 'subtract') subParts.push(`已扣掉沒吃完的 ${intent.amount}`);

  const categoryKey = updated.category === 'food'
    ? (updated.foodType === '乾糧' ? 'dry' : 'wet')
    : updated.category;
  const fallbackText = recordReply(describeLog(updated), cardPet, summary, [], eventDate);
  const card = recordFlex({
    pet: cardPet, categoryKey,
    mainText: describeLog(updated),
    subText: subParts.join('・'),
    summary, date: eventDate,
    logId: updated.logId,
    title: `✓ 已更新・${cardPet?.petName || '貓貓'}`
  });
  await replyOrPushFlex(env, event, card, fallbackText);
}

// 「刪除」：刪掉最近一筆
async function handleDeleteLast(env, event, lineUserId) {
  const db = env.DB;
  const last = await getLastLogByUser(db, lineUserId);
  if (!last) {
    await replyOrPush(env, event, '沒有可以刪除的紀錄');
    return;
  }
  await softDeleteLog(db, last.logId, lineUserId);
  const summary = await recomputeDay(db, last.petId, String(last.eventDateTime).slice(0, 10));
  await replyOrPush(env, event, `🗑 已刪除上一筆\n${describeLog(last)}\n\n今日水分 ${summary.totalWaterMl} ml\n熱量 ${summary.kcal} kcal`);
}

async function handleRecord(env, event, pet, record, lineUserId) {
  const db = env.DB;
  const hints = [];

  // 事件時間：現在（台北）＋ dayOffset ＋ 指定時間
  let eventDateTime = taipeiNowDateTime();
  if (record.dayOffset) {
    eventDateTime = `${addDays(eventDateTime.slice(0, 10), record.dayOffset)} ${eventDateTime.slice(11)}`;
  }
  if (record.time) {
    eventDateTime = `${eventDateTime.slice(0, 10)} ${record.time}`;
  }

  const log = {
    lineUserId,
    petId: pet.petId,
    eventDateTime,
    category: record.category,
    itemName: record.itemName,
    foodType: record.foodType,
    foodId: '',
    amount: record.amount,
    unit: record.unit,
    waterMl: 0,
    kcal: 0,
    medStatus: record.medStatus,
    medSlot: record.medSlot,
    note: record.note,
    sourceMessageId: String(event.message?.id || ''),
    recordedBy: lineUserId,
    isBackfilled: (record.dayOffset || record.time) ? 1 : 0,
    source: 'line',
    updatedBy: lineUserId
  };

  let description = '';

  if (record.category === 'water') {
    log.waterMl = record.amount;
    description = `水 ${record.amount} ml`;
  } else if (record.category === 'food') {
    const foods = await listFoods(db, lineUserId);
    const matched = matchFood(foods, record.itemName, record.foodType);
    if (matched) {
      log.foodId = matched.foodId;
      log.itemName = matched.displayName;
      log.kcal = Math.round(record.amount * Number(matched.kcalPerGram || 0) * 10) / 10;
      log.waterMl = Math.round(record.amount * Number(matched.waterRatio || 0) * 10) / 10;
      description = `${record.foodType} ${matched.displayName} ${record.amount} g`;
    } else {
      description = `${record.foodType}${record.itemName ? ` ${record.itemName}` : ''} ${record.amount} g`;
      hints.push('這個品項還沒設定公式，\n先照原樣記錄。\n到照護站「設定→食物」\n新增後會自動算熱量。');
    }
  } else if (record.category === 'med') {
    const label = [record.medSlot, record.itemName].filter(Boolean).join(' ');
    description = `藥${label ? ` ${label}` : ''} ${record.medStatus}`;
  } else if (record.category === 'vomit') {
    description = `嘔吐${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'stool') {
    description = `便便${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'mood') {
    description = `精神${record.note ? `：${record.note}` : ''}`;
  } else {
    description = `備註：${record.note}`;
  }

  const mainText = description;
  const subParts = [];
  if (log.kcal) subParts.push(`${log.kcal} kcal`);
  if (record.category === 'food' && log.waterMl) subParts.push(`水 ${log.waterMl} ml`);
  if (record.dayOffset || record.time) {
    const eventDay = eventDateTime.slice(0, 10);
    const stamp = `記在 ${Number(eventDay.slice(5, 7))}月${Number(eventDay.slice(8, 10))}日 ${eventDateTime.slice(11)}`;
    description += `\n（${stamp}）`;
    subParts.push(stamp);
  }

  const savedLog = await insertLog(db, log);
  const eventDate = eventDateTime.slice(0, 10);
  const summary = await recomputeDay(db, pet.petId, eventDate);

  const categoryKey = record.category === 'food'
    ? (record.foodType === '乾糧' ? 'dry' : 'wet')
    : record.category;

  // 補登到非今天時，回覆顯示的是「該日」的累積
  const fallbackText = recordReply(description, pet, summary, hints, eventDate);
  const tip = record.category === 'water'
    ? '記錯了？直接輸入「改 25」'
    : record.category === 'food'
      ? '記錯輸入「改 54」・沒吃完輸入「剩 20」'
      : '';
  const card = recordFlex({
    pet, categoryKey, mainText,
    subText: subParts.join('・'),
    summary, date: eventDate,
    logId: savedLog?.logId || '',
    hints, tip
  });
  await replyOrPushFlex(env, event, card, fallbackText);
}

async function handleQuery(env, event, user, pet, query, baseUrl, lineUserId) {
  const db = env.DB;
  const today = taipeiToday();

  if (query === 'website') {
    const token = await createSession(db, lineUserId);
    const url = `${baseUrl}/#token=${token}`;
    await replyOrPushFlex(env, event, websiteFlex(url), websiteReply(url));
    return;
  }

  if (query === 'help') {
    await replyOrPushFlex(env, event, menuFlex(), helpText());
    return;
  }

  if (query === 'recordMenu') {
    await replyOrPushFlex(env, event, recordMenuFlex(), recordPrompt(''));
    return;
  }

  if (query === 'backfill') {
    await replyOrPush(env, event, backfillGuide());
    return;
  }

  if (query === 'onboarding') {
    await replyOrPush(env, event, onboardingText());
    return;
  }

  if (!pet) {
    await replyOrPush(env, event, '還沒有建立貓咪，先輸入「新增貓咪 名字」吧！');
    return;
  }

  if (query === 'today') {
    const summary = await recomputeDay(db, pet.petId, today);
    if (!summary.entryCount) {
      await replyOrPush(env, event, todayReply(pet, today, summary));
      return;
    }
    const card = todayFlex({ pet, date: today, summary, dateLabel: shortDate(today) });
    await replyOrPushFlex(env, event, card, todayReply(pet, today, summary));
    return;
  }

  if (query === 'week') {
    const rows = await getRecentSummaries(db, pet.petId, today, 7);
    await replyOrPushFlex(env, event, weekFlex(pet.petName, rows), weekReply(pet.petName, rows));
    return;
  }

  if (query === 'calendar') {
    const month = today.slice(0, 7);
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const lastDay = Math.min(daysInMonth, Number(today.slice(8, 10)));
    const rows = await getRecentSummaries(db, pet.petId, today, lastDay);
    await replyOrPush(env, event, monthReply(pet.petName, `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`, rows));
    return;
  }

  if (query === 'visit') {
    const visits = await upcomingVisits(db, pet.petId, today);
    const vets = await listVetsByOwner(db, lineUserId);
    const vetsById = Object.fromEntries(vets.map((vet) => [vet.vetId, vet]));
    const rows = await getRecentSummaries(db, pet.petId, today, 7);
    const infoText = `${visitReply(pet.petName, visits, vetsById)}\n\n完整摘要與複製功能\n請開照護站的「回診」頁`;
    try {
      await replyMessages(env, event.replyToken, [
        weekFlex(pet.petName, rows),
        { type: 'text', text: infoText }
      ]);
    } catch (error) {
      console.warn('visit summary flex failed:', error.message);
      await replyOrPush(env, event, `${weekReply(pet.petName, rows)}\n\n${infoText}`);
    }
    return;
  }

  await replyOrPush(env, event, unknownReply());
}
