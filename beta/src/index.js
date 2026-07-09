// 貓貓照護管家 Beta — Cloudflare Worker 入口
// /webhook  → LINE Messaging API webhook（驗簽後直接處理、直接 reply，不需早回 ack）
// /api/*    → 照護站 REST API
// 其餘路徑 → 照護站網站（public/ 靜態資源）

import { parseMessage, matchFood, normalizeText } from './parser.js';
import { handleApi } from './api.js';
import { verifyLineSignature, replyOrPush, getProfile } from './line.js';
import {
  ensureUser, updateUser, listPets, createPet, resolveDefaultPet,
  listFoods, insertLog, recomputeDay, getRecentSummaries,
  upcomingVisits, listVetsByOwner, createSession
} from './db.js';
import {
  recordReply, todayReply, weekReply, monthReply, visitReply,
  websiteReply, helpText, welcomeText, unknownReply, invalidReply
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
  }
};

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
      }
    } catch (error) {
      console.error('event handling failed:', error);
      try {
        await replyOrPush(env, event, '系統忙碌中，這則訊息沒有記錄成功，請再傳一次 🙏');
      } catch (replyError) {
        console.error('error reply failed:', replyError);
      }
    }
  }

  return jsonResponse({ ok: true });
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
      await replyOrPush(env, event, `🐱 已建立貓咪「${intent.name}」！\n現在就可以輸入「水 20」開始記錄。\n生日、體重、疾病備註可到照護站（輸入「網站」）補齊。`);
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

    case 'invalid': {
      await replyOrPush(env, event, invalidReply(intent.reason, intent.category));
      return;
    }

    default: {
      await replyOrPush(env, event, unknownReply());
    }
  }
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
    updatedBy: lineUserId
  };

  let description = '';

  if (record.category === 'water') {
    log.waterMl = record.amount;
    description = `💧 水 ${record.amount} ml`;
  } else if (record.category === 'food') {
    const foods = await listFoods(db, lineUserId);
    const matched = matchFood(foods, record.itemName, record.foodType);
    if (matched) {
      log.foodId = matched.foodId;
      log.itemName = matched.displayName;
      log.kcal = Math.round(record.amount * Number(matched.kcalPerGram || 0) * 10) / 10;
      log.waterMl = Math.round(record.amount * Number(matched.waterRatio || 0) * 10) / 10;
      description = `🍚 ${record.foodType} ${matched.displayName} ${record.amount} g（熱量 ${log.kcal} kcal、水分 ${log.waterMl} ml）`;
    } else {
      description = `🍚 ${record.foodType}${record.itemName ? ` ${record.itemName}` : ''} ${record.amount} g`;
      hints.push('這個品項還沒設定熱量/水分公式，本筆先照原樣記錄。到照護站「設定 → 食物」新增後，之後會自動計算。');
    }
  } else if (record.category === 'med') {
    const label = [record.medSlot, record.itemName].filter(Boolean).join(' ');
    description = `💊 藥${label ? ` ${label}` : ''} ${record.medStatus}`;
  } else if (record.category === 'vomit') {
    description = `🤮 嘔吐${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'stool') {
    description = `💩 便便${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'mood') {
    description = `🐱 精神${record.note ? `：${record.note}` : ''}`;
  } else {
    description = `📝 備註：${record.note}`;
  }

  if (record.dayOffset || record.time) {
    description += `\n🕐 記錄時間：${eventDateTime}`;
  }

  await insertLog(db, log);
  const summary = await recomputeDay(db, pet.petId, eventDateTime.slice(0, 10));

  // 補登到非今天時，回覆顯示的是「該日」的累積
  await replyOrPush(env, event, recordReply(description, pet.petName, summary, hints));
}

async function handleQuery(env, event, user, pet, query, baseUrl, lineUserId) {
  const db = env.DB;
  const today = taipeiToday();

  if (query === 'website') {
    const token = await createSession(db, lineUserId);
    await replyOrPush(env, event, websiteReply(`${baseUrl}/#token=${token}`));
    return;
  }

  if (query === 'help') {
    await replyOrPush(env, event, helpText());
    return;
  }

  if (!pet) {
    await replyOrPush(env, event, '還沒有建立貓咪，先輸入「新增貓咪 名字」吧！');
    return;
  }

  if (query === 'today') {
    const summary = await recomputeDay(db, pet.petId, today);
    await replyOrPush(env, event, todayReply(pet.petName, today, summary));
    return;
  }

  if (query === 'week') {
    const rows = await getRecentSummaries(db, pet.petId, today, 7);
    await replyOrPush(env, event, weekReply(pet.petName, rows));
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
    await replyOrPush(env, event, visitReply(pet.petName, visits, vetsById));
    return;
  }

  await replyOrPush(env, event, unknownReply());
}
