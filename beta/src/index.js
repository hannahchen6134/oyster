// 貓貓照護管家 Beta — Cloudflare Worker 入口
// /webhook  → LINE Messaging API webhook（驗簽後直接處理、直接 reply，不需早回 ack）
// /api/*    → 照護站 REST API
// 其餘路徑 → 照護站網站（public/ 靜態資源）

import { parseMessage, matchFood, normalizeText } from './parser.js';
import { deriveFoodFields } from './summary.js';
import { handleApi } from './api.js';
import { verifyLineSignature, replyOrPush, replyOrPushFlex, replyMessages, pushText, pushMessages, getProfile } from './line.js';
import { hasAnyReminder, parseReminderSettings, buildReminderLines, reminderMessage, visitReminderMessage } from './reminders.js';
import { shortDate } from './replies.js';
import { recordFlex, todayFlex, websiteFlex, menuFlex, recordMenuFlex, weekFlex, reminderFlex, visitReminderFlex, welcomeFlex } from './flex.js';
import {
  ensureUser, updateUser, listPets, createPet, resolveDefaultPet, getPet, updatePetFields, createFoodItem,
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
// 快速回覆按鈕：fill 會把文字填進輸入框、msg 直接送出
function qrFill(label, fill) {
  return { type: 'action', action: { type: 'postback', label, data: 'action=fill', inputOption: 'openKeyboard', fillInMessage: fill } };
}
function qrMsg(label, textMsg) {
  return { type: 'action', action: { type: 'message', label, text: textMsg } };
}

async function handlePostback(event, env) {
  const db = env.DB;
  const lineUserId = event.source?.userId;
  const data = new URLSearchParams(String(event.postback?.data || ''));

  if (data.get('action') === 'fillFood' || data.get('action') === 'fill') return; // 只是把文字填進輸入框，不需回覆

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
  try {
    const card = welcomeFlex();
    card.quickReply = { items: [
      qrFill('🐱 幫貓貓建檔', '新增貓咪 '),
      qrMsg('先看看怎麼用', '安心上手')
    ] };
    await replyMessages(env, event.replyToken, [card]);
  } catch (error) {
    console.warn('welcome flex failed, fallback to text:', error.message);
    await replyOrPush(env, event, welcomeText());
  }
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
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: `🐾 已幫「${intent.name}」建立檔案！\n\n順手補兩筆基本資料嗎？\n點下面的按鈕就能填，\n之後隨時可以改。`,
          quickReply: { items: [
            qrFill('記體重', '體重 '),
            qrFill('記生日', '生日 '),
            qrMsg('下一步：常吃的食物', '設定食物'),
            qrMsg('先開始記錄', '紀錄')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, `🐾 已建立貓咪「${intent.name}」！\n輸入「水 20」開始記錄。\n生日體重等資料，\n可到照護站補齊。`);
      }
      return;
    }

    case 'petField': {
      if (!pet) {
        try {
          await replyMessages(env, event.replyToken, [{
            type: 'text',
            text: '先幫貓貓建立檔案，\n再記體重生日哦！',
            quickReply: { items: [qrFill('🐱 幫貓貓建檔', '新增貓咪 ')] }
          }]);
        } catch (error) {
          await replyOrPush(env, event, '先輸入「新增貓咪 名字」建立檔案哦！');
        }
        return;
      }
      if (intent.field === 'birthday' && !intent.value) {
        await replyOrPush(env, event, '生日這樣記：\n生日 2020-01-01\n（年-月-日）');
        return;
      }
      await updatePetFields(db, pet.petId, { [intent.field]: intent.value });
      const isWeight = intent.field === 'weightKg';
      const doneText = isWeight
        ? `已記下${pet.petName}的體重 ${intent.value} kg 🐾`
        : `已記下${pet.petName}的生日 ${intent.value} 🐾`;
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: doneText,
          quickReply: { items: [
            isWeight ? qrFill('記生日', '生日 ') : qrFill('記體重', '體重 '),
            qrMsg('下一步：常吃的食物', '設定食物'),
            qrMsg('開始記錄', '紀錄')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, doneText);
      }
      return;
    }

    case 'foodSetupMenu': {
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: '先建常吃的食物，\n之後記錄會自動算熱量水分。\n\n點類型後打名字送出，\n想更準可以加每克熱量，\n例如：設定罐頭 主食罐 1.1',
          quickReply: { items: [
            qrFill('罐頭', '設定罐頭 '),
            qrFill('乾糧', '設定乾糧 '),
            qrFill('濕食', '設定濕食 '),
            qrFill('零食', '設定零食 '),
            qrMsg('跳過，下一步', '設定餵藥')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, '建常吃的食物：\n設定罐頭 主食罐\n設定乾糧 品名 3.7');
      }
      return;
    }

    case 'foodSetup': {
      const foods = await listFoods(db, lineUserId);
      if (foods.some((food) => food.displayName === intent.name)) {
        await replyOrPush(env, event, `「${intent.name}」已經建立過了，直接記錄就可以。`);
        return;
      }
      // 預設值：罐頭/濕食 1.0 kcal/g、80% 水分；乾糧 3.7、8%；零食 3.0
      const isWet = intent.foodType === '罐頭' || intent.foodType === '濕食';
      const defaults = {
        kcalPerGram: isWet ? 1.0 : (intent.foodType === '乾糧' ? 3.7 : 3.0),
        waterRatio: isWet ? 0.8 : (intent.foodType === '乾糧' ? 0.08 : 0)
      };
      const kcalPerGram = intent.kcalPerGram > 0 ? intent.kcalPerGram : defaults.kcalPerGram;
      await createFoodItem(db, lineUserId, {
        displayName: intent.name,
        foodType: intent.foodType,
        kcalPerGram,
        waterRatio: defaults.waterRatio,
        note: intent.kcalPerGram > 0 ? '' : 'LINE 引導建立（預設值）'
      });
      const doneText = [
        `已建立「${intent.name}」（${intent.foodType}）🐾`,
        `每克 ${kcalPerGram} kcal・水分 ${Math.round(defaults.waterRatio * 100)}%`,
        intent.kcalPerGram > 0 ? '' : '（預設值，照護站「設定→常吃的食物」可微調）'
      ].filter(Boolean).join('\n');
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: doneText,
          quickReply: { items: [
            qrMsg('再建一個', '設定食物'),
            qrMsg('下一步：餵藥時段', '設定餵藥'),
            qrMsg('開始記錄', '紀錄')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, doneText);
      }
      return;
    }

    case 'medSetupMenu': {
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: `${pet ? pet.petName : '貓貓'}每天需要餵藥嗎？\n選了時段之後，\n今日確認和晚上提醒\n都會幫你看著。`,
          quickReply: { items: [
            qrMsg('早', '餵藥時段 早'),
            qrMsg('早晚', '餵藥時段 早晚'),
            qrMsg('早中晚', '餵藥時段 早中晚'),
            qrMsg('只有晚上', '餵藥時段 晚'),
            qrMsg('不用餵藥', '餵藥時段 不用')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, '設定餵藥時段：\n餵藥時段 早晚\n（或「餵藥時段 不用」）');
      }
      return;
    }

    case 'medSlots': {
      if (!pet) {
        await replyOrPush(env, event, '先輸入「新增貓咪 名字」建立檔案哦！');
        return;
      }
      await updatePetFields(db, pet.petId, { goalMedSlots: JSON.stringify(intent.slots) });
      const doneText = intent.slots.length
        ? `好，每天會幫你確認\n${intent.slots.join('、')}的藥 🐾\n\n都準備好了！\n${pet.petName}的照護就交給我們一起。`
        : `好，先不設定餵藥。\n\n都準備好了！\n${pet.petName}的照護就交給我們一起。`;
      try {
        await replyMessages(env, event.replyToken, [{
          type: 'text',
          text: doneText,
          quickReply: { items: [
            qrMsg('開始記錄', '紀錄'),
            qrFill('再新增一隻貓', '新增貓咪 '),
            qrMsg('開啟照護站', '照護站')
          ] }
        }]);
      } catch (error) {
        await replyOrPush(env, event, doneText);
      }
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
      // 記吃飯：列出自己建好的品項（快速回覆），點了自動填進輸入框，補克數送出即可
      if (intent.kind === 'food') {
        const foods = await listFoods(db, lineUserId);
        if (foods.length && event.replyToken) {
          const items = foods.slice(0, 13).map((food) => ({
            type: 'action',
            action: {
              type: 'postback',
              label: `${food.displayName}（${food.foodType}）`.slice(0, 20),
              data: 'action=fillFood',
              inputOption: 'openKeyboard',
              fillInMessage: `${food.foodType} ${food.displayName} `
            }
          }));
          try {
            await replyMessages(env, event.replyToken, [{
              type: 'text',
              text: '想記哪一個品項？\n點了會自動填進輸入框，\n補上克數送出就記好。\n不在清單的直接打\n「罐頭 品名 30g」也可以。',
              quickReply: { items }
            }]);
            return;
          } catch (error) {
            console.error('foodPick quickReply failed', error);
          }
        }
      }
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
  } else if (last.category === 'food') {
    const food = last.foodId ? await getFood(db, last.foodId) : null;
    const derived = deriveFoodFields(newAmount, last.foodType, food);
    fields.kcal = derived.kcal;
    fields.waterMl = derived.waterMl;
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
      const derived = deriveFoodFields(record.amount, record.foodType, matched);
      log.kcal = derived.kcal;
      log.waterMl = derived.waterMl;
      description = `${record.foodType} ${matched.displayName} ${record.amount} g`;
    } else {
      const derived = deriveFoodFields(record.amount, record.foodType, null);
      log.waterMl = derived.waterMl;
      description = `${record.foodType}${record.itemName ? ` ${record.itemName}` : ''} ${record.amount} g`;
      hints.push('這個品項還沒設定熱量公式，\n熱量先未計入。\n到照護站「設定→常吃的食物」\n新增後會自動計算。');
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
