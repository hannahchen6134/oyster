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
import { recordFlex, todayFlex, websiteFlex, menuFlex, recordMenuFlex, weekFlex, monthFlex, reminderFlex, visitReminderFlex, welcomeFlex, onboardCard, menuCell, exampleCard, petDataFlex, deletedCard } from './flex.js';
import { isBetaAllowed, normalizeCode, gateText } from './plan.js';
import {
  ensureUser, updateUser, listPets, createPet, resolveDefaultPet, getPet, updatePetFields, createFoodItem, createMedItem,
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
  const tomorrow = addDays(today, 1);
  const { results: pets } = await db.prepare('SELECT * FROM pets WHERE isDeleted = 0').all();

  // 以「飼主」為單位合併：一晚最多一次推播（LINE 一次推播計一則，可帶最多 5 張卡）
  const byOwner = new Map();
  for (const pet of pets || []) {
    if (!pet.ownerLineUserId || !hasAnyReminder(pet)) continue;
    if (!byOwner.has(pet.ownerLineUserId)) byOwner.set(pet.ownerLineUserId, []);
    byOwner.get(pet.ownerLineUserId).push(pet);
  }

  for (const [ownerId, ownerPets] of byOwner) {
    try {
      const messages = [];
      const textFallbacks = [];

      // 照護提醒：多貓合併成一張卡（每行標貓咪名）
      const petLines = [];
      for (const pet of ownerPets) {
        const rows = await getRecentSummaries(db, pet.petId, today, 8);
        const lines = buildReminderLines(pet, rows);
        if (lines.length) petLines.push({ pet, lines });
      }
      if (petLines.length === 1) {
        messages.push(reminderFlex(petLines[0].pet, petLines[0].lines));
        textFallbacks.push(reminderMessage(petLines[0].pet, petLines[0].lines));
      } else if (petLines.length > 1) {
        const merged = petLines.flatMap(({ pet, lines }) => lines.map((line) => `【${pet.petName}】${line}`));
        const groupPet = { petName: `${petLines.length} 隻貓貓` };
        messages.push(reminderFlex(groupPet, merged));
        textFallbacks.push(reminderMessage(groupPet, merged));
      }

      // 回診提醒：併進同一次推播
      let vetsById = null;
      for (const pet of ownerPets) {
        if (!parseReminderSettings(pet).visit) continue;
        const { results: visits } = await db
          .prepare(
            `SELECT * FROM vet_visits WHERE petId = ? AND isDeleted = 0
             AND (visitDate = ? OR nextVisitDate = ?)`
          )
          .bind(pet.petId, tomorrow, tomorrow)
          .all();
        if (!visits?.length) continue;
        if (!vetsById) {
          const vets = await listVetsByOwner(db, ownerId);
          vetsById = Object.fromEntries(vets.map((vet) => [vet.vetId, vet]));
        }
        messages.push(visitReminderFlex(pet, visits, vetsById, shortDate(tomorrow)));
        textFallbacks.push(visitReminderMessage(pet, visits, vetsById, shortDate(tomorrow)));
      }

      if (!messages.length) continue;
      try {
        await pushMessages(env, ownerId, messages.slice(0, 5));
      } catch (flexError) {
        console.warn('reminder flex failed, fallback to text:', flexError.message);
        await pushText(env, ownerId, textFallbacks.join('\n\n'));
      }
      console.log(JSON.stringify({ step: 'reminder_sent', cards: messages.length }));
    } catch (error) {
      console.error('reminder push failed:', error.message);
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
        await handlePostback(event, env, baseUrl);
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
// ---------- 引導流程卡（一張卡一件事，全部大按鈕；自由輸入用 pendingAction 等待） ----------

function stepMedCard(petName, step = '') {
  return onboardCard({
    step,
    title: `${petName}每天需要餵藥嗎？`,
    subtitle: '選了之後，今日確認和晚上提醒都會幫你看著',
    rows: [
      [menuCell('早', '一天一次', '餵藥時段 早'), menuCell('早晚', '一天兩次', '餵藥時段 早晚')],
      [menuCell('早中晚', '一天三次', '餵藥時段 早中晚'), menuCell('只有晚上', '一天一次', '餵藥時段 晚')],
      [menuCell('不用餵藥', '之後可以再設定', '餵藥時段 不用')]
    ],
    alt: '每天需要餵藥嗎？'
  });
}

function stepFoodCard(step = '第 2 步・共 3 步', subtitle = '可以建好幾種，乾乾和罐罐都建更好用') {
  return onboardCard({
    step,
    title: '最常吃哪一種？',
    subtitle,
    rows: [
      [menuCell('罐頭', '主食罐/副食罐', '設定罐頭'), menuCell('乾糧', '飼料', '設定乾糧')],
      [menuCell('濕食', '餐包/鮮食', '設定濕食'), menuCell('零食', '凍乾/肉泥', '設定零食')]
    ],
    skip: { label: '先跳過，之後再建', send: '稍後再說' },
    alt: '最常吃哪一種食物？'
  });
}

function medAskCard(petName, step = '第 3 步・共 3 步') {
  return onboardCard({
    step,
    title: `${petName}有固定吃的保健品或藥嗎？`,
    subtitle: '先記一種就好，名字用自己記得的',
    rows: [
      [menuCell('有，幫我記一個', '例如 心臟藥、益生菌', '記保健品')],
      [menuCell('沒有', '之後需要再設定', '餵藥時段 不用')]
    ],
    alt: '有固定吃的保健品或藥嗎？'
  });
}

function doneCard(petName) {
  return onboardCard({
    title: '都準備好了',
    subtitle: `現在試試看：直接打「水 60」，就幫${petName}記下第一筆`,
    rows: [
      [menuCell('照著打打看', '不會打？點這裡', '範例', true)],
      [menuCell('快速紀錄', '點按鈕記錄', '紀錄'), menuCell('今日確認', '看今天狀況', '今天')],
      [menuCell('補充貓咪資料', '晶片・疾病・疫苗', '補資料'), menuCell('開啟照護站', '月曆・回診・設定', '照護站')]
    ],
    hint: '晶片、疾病、疫苗、醫院醫生等詳細資料，點「補充貓咪資料」直接到設定頁填',
    alt: '都準備好了！'
  });
}

function namePromptCard() {
  return onboardCard({
    step: '第 1 步・共 3 步',
    title: '貓貓叫什麼名字？',
    subtitle: '直接打名字送出就好',
    skip: { label: '稍後再說', send: '稍後再說' },
    alt: '貓貓叫什麼名字？'
  });
}

// 年齡（歲）→ 概略生日（以台北今天往回推 N 年）
function birthdayFromAge(age) {
  const today = taipeiToday();
  return `${Number(today.slice(0, 4)) - age}${today.slice(4)}`;
}

// 引導建立食物：預設值（罐頭/濕食 1.0 kcal/g・80% 水分；乾糧 3.7・8%；零食 3.0）
async function createGuidedFood(db, lineUserId, foodType, name, kcalIn) {
  const isWet = foodType === '罐頭' || foodType === '濕食';
  const defaults = {
    kcalPerGram: isWet ? 1.0 : (foodType === '乾糧' ? 3.7 : 3.0),
    waterRatio: isWet ? 0.8 : (foodType === '乾糧' ? 0.08 : 0)
  };
  const kcalPerGram = kcalIn > 0 ? kcalIn : defaults.kcalPerGram;
  await createFoodItem(db, lineUserId, {
    displayName: name,
    foodType,
    kcalPerGram,
    waterRatio: defaults.waterRatio,
    note: kcalIn > 0 ? '' : 'LINE 引導建立（預設值）'
  });
  return { kcalPerGram, waterRatio: defaults.waterRatio, usedDefault: !(kcalIn > 0) };
}

function foodDoneCard(name, foodType, info) {
  return onboardCard({
    title: `已建立「${name}」`,
    subtitle: `${foodType}・每克 ${info.kcalPerGram} kcal・水分 ${Math.round(info.waterRatio * 100)}%${info.usedDefault ? '（預設值，照護站可微調）' : ''}`,
    rows: [
      [menuCell('再建一種', '乾乾罐罐都建更好用', '設定食物'), menuCell('下一步：保健品/藥', '有在吃的話', '設定保健品')]
    ],
    alt: `已建立「${name}」`
  });
}

// 等待中的自由輸入（名字/體重/生日/食物名/克數）；回 true 表示已處理
async function handlePending(env, event, { db, user, pet, pets, lineUserId, text }) {
  const pending = user.pendingAction;
  const clear = () => updateUser(db, lineUserId, { pendingAction: '' });

  if (['跳過', '先跳過', '稍後再說', '取消'].includes(text)) {
    await clear();
    if (pending === 'petname' && !pets.length) {
      await replyOrPushFlex(env, event, onboardCard({
        title: '好，先自己逛逛',
        subtitle: '想開始時輸入「安心上手」，我都在',
        rows: [[menuCell('安心上手', '上手小教學', '安心上手'), menuCell('開啟照護站', '看看長什麼樣子', '照護站')]]
      }), '好，想開始時輸入「安心上手」');
    } else {
      await replyOrPushFlex(env, event, doneCard(pet?.petName || '貓貓'), '好，隨時打「水 60」開始記錄');
    }
    return true;
  }

  const asIntent = parseMessage(text);

  if (pending === 'petname') {
    if (asIntent.type !== 'unknown' || text.length > 12 || !text) { await clear(); return false; }
    let newPet = pets.find((p) => p.petName === text);
    if (!newPet) {
      newPet = await createPet(db, lineUserId, { petName: text });
      if (!pets.length) await updateUser(db, lineUserId, { defaultPetId: newPet.petId });
    }
    await clear();
    await replyOrPushFlex(env, event, stepFoodCard(), `已幫「${newPet.petName}」建立檔案！先建常吃的食物：輸入「設定罐頭」「設定乾糧」等`);
    return true;
  }

  if (pending === 'weight' && pet) {
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:kg|公斤)?$/i);
    if (!m) { await clear(); return false; }
    await updatePetFields(db, pet.petId, { weightKg: Number(m[1]) });
    await clear();
    await replyOrPushFlex(env, event, onboardCard({
      title: `已記下${pet.petName}的體重 ${m[1]} kg`,
      rows: [[menuCell('記年齡', '大約幾歲', '記年齡'), menuCell('完成', '開始使用', '完成設定')]]
    }), `已記下體重 ${m[1]} kg`);
    return true;
  }

  if (pending === 'birthday' && pet) {
    const age = text.match(/^(\d{1,2})\s*歲?$/);
    const d = text.match(/^(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})日?$/);
    if (!age && !d) {
      if (asIntent.type !== 'unknown') { await clear(); return false; }
      await replyOrPush(env, event, '直接打大約幾歲就可以，例如 5\n（知道生日也可以打 2020-01-01；「跳過」可略過）');
      return true;
    }
    const value = age
      ? birthdayFromAge(Number(age[1]))
      : `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
    await updatePetFields(db, pet.petId, { birthday: value });
    await clear();
    await replyOrPushFlex(env, event, onboardCard({
      title: age ? `已記下${pet.petName}約 ${age[1]} 歲` : `已記下${pet.petName}的生日`,
      subtitle: age ? `生日先記為 ${value}，照護站可調整` : value,
      rows: [[menuCell('記體重', '例如 4.2', '記體重'), menuCell('完成', '開始使用', '完成設定')]]
    }), age ? `已記下約 ${age[1]} 歲` : `已記下生日 ${value}`);
    return true;
  }

  if (pending.startsWith('food:')) {
    if (asIntent.type !== 'unknown') { await clear(); return false; }
    const foodType = pending.slice(5);
    const m = text.match(/^(.+?)(?:\s+([0-9.]+))?$/);
    const name = (m ? m[1] : '').trim();
    const kcalIn = m && m[2] ? Number(m[2]) : 0;
    if (!name || name.length > 15) { await clear(); return false; }
    await clear();
    const foods = await listFoods(db, lineUserId);
    if (foods.some((food) => food.displayName === name)) {
      await replyOrPushFlex(env, event, foodDoneCard(name, foodType, { kcalPerGram: '—', waterRatio: 0, usedDefault: false }), `「${name}」已經建立過了`);
      return true;
    }
    const info = await createGuidedFood(db, lineUserId, foodType, name, kcalIn);
    await replyOrPushFlex(env, event, foodDoneCard(name, foodType, info), `已建立「${name}」（${foodType}）`);
    return true;
  }

  if (pending === 'medname' && pet) {
    if (asIntent.type !== 'unknown' || !text || text.length > 15) { await clear(); return false; }
    await createMedItem(db, pet.petId, text);
    await clear();
    await replyOrPushFlex(env, event, onboardCard({
      title: `「${text}」多久吃一次？`,
      subtitle: '選了之後，今日確認和晚上提醒都會幫你看著',
      rows: [
        [menuCell('早', '一天一次', '餵藥時段 早'), menuCell('早晚', '一天兩次', '餵藥時段 早晚')],
        [menuCell('早中晚', '一天三次', '餵藥時段 早中晚'), menuCell('只有晚上', '一天一次', '餵藥時段 晚')]
      ],
      skip: { label: '不固定，先這樣', send: '餵藥時段 不用' },
      alt: `「${text}」多久吃一次？`
    }), `已記下「${text}」，多久吃一次？（輸入：餵藥時段 早晚）`);
    return true;
  }

  if (pending.startsWith('amount|')) {
    const base = pending.slice(7);
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|克|公克|ml|毫升)?$/i);
    if (!m) { await clear(); return false; }
    await clear();
    const intent2 = parseMessage(`${base} ${m[1]}`);
    if (intent2.type === 'record' && pet) {
      await handleRecord(env, event, pet, intent2.record, lineUserId, { fromButton: true });
      return true;
    }
    return false;
  }

  // 點嘔吐/排便/精神/備註 → 直接打描述就記好
  if (pending.startsWith('note|') && pet) {
    const cat = pending.slice(5);
    // 若使用者直接打了可解析的紀錄（例如「吐了」），交回正常流程
    if (asIntent.type === 'record') { await clear(); return false; }
    await clear();
    await handleRecord(env, event, pet, {
      category: cat, amount: 0, unit: '', foodType: '', medStatus: '', medSlot: '',
      itemName: cat === 'supplement' ? text : '',
      note: cat === 'supplement' ? '' : text
    }, lineUserId, { fromButton: true });
    return true;
  }

  await clear();
  return false;
}

async function handlePostback(event, env, baseUrl) {
  const db = env.DB;
  const lineUserId = event.source?.userId;
  const data = new URLSearchParams(String(event.postback?.data || ''));
  const action = data.get('action');

  if (action === 'fillFood' || action === 'fill') return; // 只是把文字填進輸入框，不需回覆

  // 月曆點某一天 → 回那天的總結卡
  if (action === 'calDay') {
    const date = data.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const { user } = await ensureUser(db, lineUserId);
    const pets = await listPets(db, lineUserId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const summary = await recomputeDay(db, pet.petId, date);
    if (!summary.entryCount) {
      await replyOrPush(env, event, `${shortDate(date)}（${pet.petName}）\n這天沒有紀錄。`);
      return;
    }
    await replyOrPushFlex(env, event, todayFlex({ pet, date, summary, dateLabel: shortDate(date) }), todayReply(pet, date, summary));
    return;
  }

  // 月曆切換月份（不超過本月，最多回溯 24 個月）
  if (action === 'calMonth') {
    const month = data.get('month') || '';
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const { user } = await ensureUser(db, lineUserId);
    const pets = await listPets(db, lineUserId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const today = taipeiToday();
    const thisMonth = today.slice(0, 7);
    const floor = `${Number(thisMonth.slice(0, 4)) - 2}-${thisMonth.slice(5, 7)}`;
    let target = month;
    if (target > thisMonth) target = thisMonth;
    if (target < floor) target = floor;
    const year = Number(target.slice(0, 4));
    const mon = Number(target.slice(5, 7));
    const daysInMonth = new Date(year, mon, 0).getDate();
    const lastDate = target === thisMonth ? today : `${target}-${String(daysInMonth).padStart(2, '0')}`;
    const rows = await getRecentSummaries(db, pet.petId, lastDate, Number(lastDate.slice(8, 10)));
    const monthLabel = `${year} 年 ${mon} 月`;
    await replyOrPushFlex(env, event, monthFlex(pet.petName, target, rows, today), monthReply(pet.petName, monthLabel, rows));
    return;
  }

  if (action === 'delLog') {
    try {
      const log = await getLog(db, data.get('logId') || '');
      if (log && log.lineUserId === lineUserId && !log.isDeleted) {
        await softDeleteLog(db, log.logId, lineUserId);
        await recomputeDay(db, log.petId, String(log.eventDateTime).slice(0, 10));
      }
    } catch (error) {
      console.error('delLog failed:', error);
    }
    // 不論結果都回一張安心卡（避免使用者卡住沒反應）
    const token = await createSession(db, lineUserId);
    const url = `${baseUrl}/#token=${token}`;
    await replyOrPushFlex(env, event, deletedCard(url),
      '已刪除剛剛的資料囉。若要再調整，請開啟照護站。');
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
  if (!isBetaAllowed(user)) {
    await replyOrPush(env, event, gateText());
    return;
  }
  await replyOrPushFlex(env, event, welcomeFlex(), welcomeText());
}

async function handleTextMessage(event, env, baseUrl) {
  const db = env.DB;
  const lineUserId = event.source?.userId;

  if (event.source?.type !== 'user' || !lineUserId) {
    await replyOrPush(env, event, 'Beta 版目前僅支援一對一聊天，請直接私訊我唷');
    return;
  }

  const { user, created } = await ensureUser(db, lineUserId);
  if (created) {
    const profile = await getProfile(env, lineUserId);
    if (profile?.displayName) await updateUser(db, lineUserId, { displayName: profile.displayName });
  }

  const pets = await listPets(db, lineUserId);
  let text = normalizeText(event.message?.text || '');

  // 封閉測試門檻：未解鎖者只能輸入邀請碼，看不到任何產品內容
  if (!isBetaAllowed(user)) {
    const code = String(env.INVITE_CODE || '__closed_beta__').trim();
    if (normalizeCode(text) === normalizeCode(code)) {
      await updateUser(db, lineUserId, { betaAccess: 1 });
      await replyOrPushFlex(env, event, welcomeFlex(), welcomeText());
      return;
    }
    await replyOrPush(env, event, gateText());
    return;
  }

  // 多貓咪：訊息開頭是貓咪名（或 @貓咪名）時指定該貓咪
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

  // 引導流程等待中的自由輸入（名字/體重/生日/食物名/克數）
  if (user.pendingAction) {
    const consumed = await handlePending(env, event, { db, user, pet, pets, lineUserId, text });
    if (consumed) return;
  }

  const intent = parseMessage(text);

  switch (intent.type) {
    case 'addPet': {
      const existing = pets.find((p) => p.petName === intent.name);
      if (existing) {
        await replyOrPushFlex(env, event, doneCard(existing.petName), `「${intent.name}」已經建立過了，直接開始記錄吧！`);
        return;
      }
      const newPet = await createPet(db, lineUserId, { petName: intent.name });
      if (!pets.length) await updateUser(db, lineUserId, { defaultPetId: newPet.petId });
      await replyOrPushFlex(env, event, stepFoodCard(), `已幫「${intent.name}」建立檔案！先建常吃的食物：輸入「設定罐頭」「設定乾糧」等`);
      return;
    }

    case 'exampleMenu': {
      await replyOrPushFlex(env, event, exampleCard(), '照著打打看：\n水 60（記喝水）\n罐頭 30（記食物）\n藥 早 已吃\n吐了');
      return;
    }

    case 'petDataLink': {
      const token = await createSession(db, lineUserId);
      const url = `${baseUrl}/#token=${token}&go=pet`;
      await replyOrPushFlex(env, event, petDataFlex(url), `補充貓咪資料（晶片/疾病/疫苗）：\n${url}`);
      return;
    }

    case 'petNamePrompt': {
      await updateUser(db, lineUserId, { pendingAction: 'petname' });
      await replyOrPushFlex(env, event, namePromptCard(), '貓貓叫什麼名字？直接打名字送出就好');
      return;
    }

    case 'petFieldPrompt': {
      if (!pet) {
        await updateUser(db, lineUserId, { pendingAction: 'petname' });
        await replyOrPushFlex(env, event, namePromptCard(), '先幫貓貓建檔：直接打名字送出就好');
        return;
      }
      const isWeight = intent.field === 'weightKg';
      await updateUser(db, lineUserId, { pendingAction: isWeight ? 'weight' : 'birthday' });
      await replyOrPushFlex(env, event, onboardCard({
        title: isWeight ? `${pet.petName}的體重是？` : `${pet.petName}大約幾歲？`,
        subtitle: isWeight ? '直接打數字就好，例如 4.2' : '直接打數字就好，例如 5（知道生日也可以打 2020-01-01）',
        skip: { label: '跳過這題', send: '跳過' },
        alt: isWeight ? '體重是？' : '大約幾歲？'
      }), isWeight ? '直接打體重數字就好，例如 4.2' : '直接打大約幾歲，例如 5');
      return;
    }

    case 'petExtraMenu': {
      if (!pet) {
        await updateUser(db, lineUserId, { pendingAction: 'petname' });
        await replyOrPushFlex(env, event, namePromptCard(), '先幫貓貓建檔：直接打名字送出就好');
        return;
      }
      await replyOrPushFlex(env, event, onboardCard({
        title: '補充基本資料',
        subtitle: '選填，之後在照護站也都能改',
        rows: [[menuCell('記體重', '例如 4.2', '記體重'), menuCell('記年齡', '大約幾歲', '記年齡')]],
        alt: '補充基本資料'
      }), '輸入「記體重」或「記生日」');
      return;
    }

    case 'petField': {
      if (!pet) {
        await updateUser(db, lineUserId, { pendingAction: 'petname' });
        await replyOrPushFlex(env, event, namePromptCard(), '先幫貓貓建檔：直接打名字送出就好');
        return;
      }
      if (intent.field === 'birthday' && !intent.value) {
        await replyOrPush(env, event, '生日這樣記：\n生日 2020-01-01\n（或「年齡 5」記大約歲數）');
        return;
      }
      const field = intent.field === 'age' ? 'birthday' : intent.field;
      const value = intent.field === 'age' ? birthdayFromAge(intent.value) : intent.value;
      await updatePetFields(db, pet.petId, { [field]: value });
      const isWeight = field === 'weightKg';
      await replyOrPushFlex(env, event, onboardCard({
        title: isWeight ? `已記下${pet.petName}的體重 ${value} kg` : `已記下${pet.petName}的生日`,
        subtitle: isWeight ? '' : String(value),
        rows: [[
          isWeight ? menuCell('記年齡', '大約幾歲', '記年齡') : menuCell('記體重', '例如 4.2', '記體重'),
          menuCell('完成', '開始使用', '完成設定')
        ]],
        alt: '已記下'
      }), isWeight ? `已記下體重 ${value} kg` : `已記下生日 ${value}`);
      return;
    }

    case 'foodSetupMenu': {
      await replyOrPushFlex(env, event, stepFoodCard('', '建好之後，記錄會自動算熱量和水分'), '建常吃的食物：輸入「設定罐頭」「設定乾糧」等');
      return;
    }

    case 'foodSetupPrompt': {
      await updateUser(db, lineUserId, { pendingAction: `food:${intent.foodType}` });
      await replyOrPushFlex(env, event, onboardCard({
        title: `這個${intent.foodType}叫什麼名字？`,
        subtitle: '不用完整名字，用自己記得的就好，例如：腎罐、G1乾乾（想更準可加每克熱量：腎罐 1.1）',
        skip: { label: '跳過這題', send: '跳過' },
        alt: `這個${intent.foodType}叫什麼？`
      }), `這個${intent.foodType}叫什麼名字？直接打名字送出`);
      return;
    }

    case 'foodSetup': {
      const foods = await listFoods(db, lineUserId);
      if (foods.some((food) => food.displayName === intent.name)) {
        await replyOrPushFlex(env, event, doneCard(pet?.petName || '貓貓'), `「${intent.name}」已經建立過了，直接記錄就可以。`);
        return;
      }
      const info = await createGuidedFood(db, lineUserId, intent.foodType, intent.name, intent.kcalPerGram);
      await replyOrPushFlex(env, event, foodDoneCard(intent.name, intent.foodType, info), `已建立「${intent.name}」（${intent.foodType}）`);
      return;
    }

    case 'medAskMenu': {
      await replyOrPushFlex(env, event, medAskCard(pet ? pet.petName : '貓貓'), '有固定吃的保健品或藥嗎？輸入「記保健品」或「餵藥時段 不用」');
      return;
    }

    case 'medNamePrompt': {
      if (!pet) {
        await updateUser(db, lineUserId, { pendingAction: 'petname' });
        await replyOrPushFlex(env, event, namePromptCard(), '先幫貓貓建檔：直接打名字送出就好');
        return;
      }
      await updateUser(db, lineUserId, { pendingAction: 'medname' });
      await replyOrPushFlex(env, event, onboardCard({
        title: '叫什麼名字呢？',
        subtitle: '用自己記得的就好，例如：心臟藥、益生菌、腎臟保健粉',
        skip: { label: '跳過這題', send: '跳過' },
        alt: '保健品/藥叫什麼名字？'
      }), '保健品/藥叫什麼名字？直接打名字送出');
      return;
    }

    case 'medSetupMenu': {
      await replyOrPushFlex(env, event, stepMedCard(pet ? pet.petName : '貓貓', ''), '設定餵藥時段：輸入「餵藥時段 早晚」或「餵藥時段 不用」');
      return;
    }

    case 'medSlots': {
      if (!pet) {
        await updateUser(db, lineUserId, { pendingAction: 'petname' });
        await replyOrPushFlex(env, event, namePromptCard(), '先幫貓貓建檔：直接打名字送出就好');
        return;
      }
      await updatePetFields(db, pet.petId, { goalMedSlots: JSON.stringify(intent.slots) });
      await replyOrPushFlex(env, event, doneCard(pet.petName), intent.slots.length
        ? `收到，每天會幫你確認${intent.slots.join('、')}的藥。都準備好了，隨時打「水 60」開始記錄！`
        : '好，都準備好了！隨時打「水 60」開始記錄');
      return;
    }

    case 'skipStep': {
      if (pet) await replyOrPushFlex(env, event, doneCard(pet.petName), '好，隨時打「水 60」開始記錄');
      else await replyOrPushFlex(env, event, welcomeFlex(), welcomeText());
      return;
    }

    case 'setupDone': {
      await replyOrPushFlex(env, event, doneCard(pet?.petName || '貓貓'), '都準備好了！隨時打「水 60」開始記錄');
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
      const k = intent.kind;
      // 喝水：點了直接打數字就好
      if (k === 'water') {
        await updateUser(db, lineUserId, { pendingAction: 'amount|水' });
        await replyOrPush(env, event, '喝了多少 ml？\n直接打數字就好，例如 20');
        return;
      }
      // 吃飯：列出自己建好的品項，點了再打克數
      if (k === 'food') {
        const foods = await listFoods(db, lineUserId);
        if (foods.length) {
          const cells = foods.slice(0, 8).map((food) =>
            menuCell(String(food.displayName).slice(0, 10), food.foodType, `${food.foodType} ${food.displayName}`));
          const rows = [];
          for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
          rows.push([menuCell('建新的品項', '常吃的先建檔', '設定食物')]);
          await replyOrPushFlex(env, event, onboardCard({
            title: '想記哪一個品項？',
            subtitle: '點了再打幾克，就記好了',
            rows,
            hint: '不在清單的直接打「罐頭 品名 30g」也可以',
            alt: '想記哪一個品項？'
          }), recordPrompt('food'));
          return;
        }
        await updateUser(db, lineUserId, { pendingAction: 'amount|罐頭' });
        await replyOrPush(env, event, '吃了幾克？\n直接打數字就好，例如 30\n（先當罐頭記，之後可在照護站改）');
        return;
      }
      // 用藥：給快捷鈕，免打字
      if (k === 'med') {
        await replyOrPushFlex(env, event, onboardCard({
          title: '這次的藥？',
          subtitle: '點一下就記好',
          rows: [
            [menuCell('早・已吃', '', '藥 早 已吃'), menuCell('晚・已吃', '', '藥 晚 已吃')],
            [menuCell('中午・已吃', '', '藥 中午 已吃'), menuCell('沒餵到', '', '藥 沒餵到')]
          ],
          alt: '這次的藥？'
        }), '記餵藥：藥 早 已吃 / 藥 晚 已吃 / 藥 沒餵到');
        return;
      }
      // 嘔吐/排便/精神/備註：點了直接打描述
      const notePrompts = {
        vomit: '怎麼了？簡單描述就好\n（例如：黃色液體）\n不想寫直接打「吐了」也行',
        stool: '大便情況？簡單描述\n（例如：軟便、正常）\n或直接打「大便」',
        urine: '尿尿正常嗎？可補描述\n（例如：量少、顏色深）\n或直接打「尿尿」',
        supplement: '補充了什麼？\n（例如：益生菌、化毛膏）',
        mood: '今天精神如何？\n（例如：活力好、懶懶的）',
        note: '想記什麼？直接打字就好'
      };
      if (notePrompts[k]) {
        await updateUser(db, lineUserId, { pendingAction: `note|${k}` });
        await replyOrPush(env, event, notePrompts[k]);
        return;
      }
      await replyOrPush(env, event, recordPrompt(k));
      return;
    }

    case 'fixHint': {
      await replyOrPush(env, event, '修正上一筆：\n改 54（改數量）\n剩 20（沒吃完扣掉）\n刪除（整筆刪掉）');
      return;
    }

    case 'invalid': {
      if (intent.reason === 'missing_amount' && intent.category === 'food' && pet) {
        await updateUser(db, lineUserId, { pendingAction: `amount|${text}` });
        await replyOrPush(env, event, '幾克呢？直接打數字就好');
        return;
      }
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

async function handleRecord(env, event, pet, record, lineUserId, opts = {}) {
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
    // 沒寫品名時，若該類型只建了一種品項就自動套用（例如乾糧只有一種 → 直接用它的公式）
    let matched = matchFood(foods, record.itemName, record.foodType);
    if (!matched && !record.itemName) {
      const sameType = foods.filter((food) => food.foodType === record.foodType);
      if (sameType.length === 1) matched = sameType[0];
    }
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
  } else if (record.category === 'urine') {
    description = `尿尿${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'supplement') {
    description = `營養補充${record.itemName ? `：${record.itemName}` : ''}`;
  } else if (record.category === 'mood') {
    description = `精神${record.note ? `：${record.note}` : ''}`;
  } else {
    description = `備註：${record.note}`;
  }

  // 罐頭另外加水：主文字標注，並在下方另計一筆喝水，讓當天總水分正確
  const addedWaterMl = record.category === 'food' ? Number(record.addedWaterMl) || 0 : 0;
  if (addedWaterMl > 0) description += `（另加水 ${addedWaterMl} ml）`;

  const mainText = description;
  const subParts = [];
  if (log.kcal) subParts.push(`${log.kcal} kcal`);
  if (record.category === 'food' && log.waterMl) subParts.push(`含水 ${log.waterMl} ml`);
  if (addedWaterMl > 0) subParts.push(`另計加水 ${addedWaterMl} ml`);
  if (record.dayOffset || record.time) {
    const eventDay = eventDateTime.slice(0, 10);
    const stamp = `記在 ${Number(eventDay.slice(5, 7))}月${Number(eventDay.slice(8, 10))}日 ${eventDateTime.slice(11)}`;
    description += `\n（${stamp}）`;
    subParts.push(stamp);
  }

  const savedLog = await insertLog(db, log);
  // 罐頭另外加的水 → 另存一筆喝水（沿用已驗證的喝水計算，不動食物固形/熱量公式）
  if (addedWaterMl > 0) {
    await insertLog(db, {
      lineUserId,
      petId: pet.petId,
      eventDateTime,
      category: 'water',
      itemName: '',
      foodType: '',
      foodId: '',
      amount: addedWaterMl,
      unit: 'ml',
      waterMl: addedWaterMl,
      kcal: 0,
      medStatus: '',
      medSlot: '',
      note: '罐頭加水',
      sourceMessageId: String(event.message?.id || ''),
      recordedBy: lineUserId,
      isBackfilled: log.isBackfilled,
      source: 'line',
      updatedBy: lineUserId
    });
  }
  const eventDate = eventDateTime.slice(0, 10);
  const summary = await recomputeDay(db, pet.petId, eventDate);

  const categoryKey = record.category === 'food'
    ? (record.foodType === '乾糧' ? 'dry' : 'wet')
    : record.category;

  // 補登到非今天時，回覆顯示的是「該日」的累積
  const fallbackText = recordReply(description, pet, summary, hints, eventDate);
  let tip = record.category === 'water'
    ? '記錯了？直接輸入「改 25」'
    : record.category === 'food'
      ? '記錯輸入「改 54」・沒吃完輸入「剩 20」'
      : '';
  if (opts.fromButton) {
    const amt = record.amount;
    const shortcut = record.category === 'water' ? `水 ${amt}`
      : record.category === 'food' ? `${record.foodType} ${log.itemName || ''} ${amt}`.replace(/\s+/g, ' ').trim()
      : record.category === 'med' ? `藥 ${[record.medSlot, record.medStatus].filter(Boolean).join(' ')}`.trim()
      : record.category === 'vomit' ? '吐了'
      : record.category === 'stool' ? '便便'
      : record.category === 'urine' ? '尿尿'
      : record.category === 'supplement' ? (record.itemName ? `營養補充 ${record.itemName}` : '營養補充')
      : record.category === 'mood' ? (record.note ? `精神 ${record.note}` : '精神')
      : (record.note ? `備註 ${record.note}` : '');
    if (shortcut) tip = `💡 下次更快：直接打「${shortcut}」`;
  }
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
    const lastDay = Number(today.slice(8, 10));
    const rows = await getRecentSummaries(db, pet.petId, today, lastDay);
    const monthLabel = `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
    await replyOrPushFlex(env, event, monthFlex(pet.petName, month, rows, today), monthReply(pet.petName, monthLabel, rows));
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
