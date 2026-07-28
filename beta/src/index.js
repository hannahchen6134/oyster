// 貓貓照護管家 Beta — Cloudflare Worker 入口
// /webhook  → LINE Messaging API webhook（驗簽後直接處理、直接 reply，不需早回 ack）
// /api/*    → 照護站 REST API
// 其餘路徑 → 照護站網站（public/ 靜態資源）

import { parseMessage, matchFood, guessFood, normalizeText } from './parser.js';
import { deriveFoodFields, isWetFoodType, isEstimableType } from './summary.js';
import { handleApi } from './api.js';
import { verifyLineSignature, replyOrPush, replyOrPushQuick, replyOrPushFlex, replyMessages, pushText, pushMessages, getProfile, getAccessToken, checkAccessToken } from './line.js';
import { hasAnyReminder, parseReminderSettings, buildReminderLines, reminderMessage, visitReminderMessage } from './reminders.js';
import { shortDate } from './replies.js';
import { recordFlex, recordFlexCompact, foodDisambigFlex, multiRecordFlex, todayFlex, websiteFlex, menuFlex, recordMenuFlex, recordTutorialFlex, quickRecordCarousel, weekFlex, monthFlex, recentFlex, reminderFlex, visitReminderFlex, welcomeFlex, onboardCard, onboardingCarousel, menuCell, exampleCard, petDataFlex, deletedCard, confirmDeleteFlex, careNotifyFlex, careInviteFlex } from './flex.js';
import { isBetaAllowed, normalizeCode, gateText } from './plan.js';
import {
  ensureUser, updateUser, getUser, listPets, createPet, resolveDefaultPet, getPet, updatePetFields, createFoodItem, createMedItem,
  listFoods, getFood, insertLog, getLog, getLastLogByUser, softDeleteLog, updateLog,
  recomputeDay, getRecentSummaries,
  upcomingVisits, listVetsByOwner, createSession,
  appKvGet, appKvSet, claimMessageOnce, purgeOldSeenMessages, saveReportShot, getReportShot, purgeOldShots, getSessionUser, track, healFoodKcal,
  resolveDataOwner, createCareInvite, redeemCareInvite, listCareMembers, listCareCircle,
  createLoginCode, redeemLoginCode
} from './db.js';
import {
  recordReply, lightRecordReply, todayReply, weekReply, monthReply, visitReply,
  websiteReply, helpText, welcomeText, unknownReply, invalidReply,
  recordTutorial, medTutorial, onboardingText, recordPrompt, backfillGuide
} from './replies.js';
import { getRecentLogsByPet } from './db.js';
import { jsonResponse, taipeiToday, taipeiNowDateTime, addDays } from './util.js';

// 官方 LINE 加好友連結（basicId @232mjffx）——給共同照護邀請用
const LINE_ADD_URL = 'https://line.me/R/ti/p/@232mjffx';

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
      return handleWebhook(request, env, url, ctx);
    }
    // LIFF 設定：前端讀這個決定要不要啟用「挑好友送出邀請」（未設定 LIFF_ID 時回空字串→自動退回複製邀請）
    if (url.pathname === '/api/liff-config') {
      return jsonResponse({ ok: true, liffId: String(env.LIFF_ID || '') });
    }
    // 電腦登入：未登入即可呼叫，用 LINE 取得的 6 位碼換一個 session（放在 handleApi 的權杖檢查之前）
    if (url.pathname === '/api/login-code' && request.method === 'POST') {
      try {
        const body = await request.json();
        const lineUserId = await redeemLoginCode(env.DB, body?.code);
        if (!lineUserId) return jsonResponse({ ok: false, message: '登入碼無效或已過期，請回 LINE 打「電腦登入」重新取得。' }, 400);
        const token = await createSession(env.DB, lineUserId);
        return jsonResponse({ ok: true, token });
      } catch (error) {
        return jsonResponse({ ok: false, message: '登入失敗，請再試一次。' }, 400);
      }
    }
    // LIFF 自動登入：前端在 LINE 內取得 id_token → 這裡向 LINE 驗證 → 取回本人 userId → 換發 session。
    // 因為 LIFF 的 Login channel 和機器人在同一個 Provider，userId（sub）會和 LINE 記錄的一致。
    if (url.pathname === '/api/liff-login' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const accessToken = String(body?.accessToken || '');
        const clientId = String(env.LIFF_CHANNEL_ID || '');
        if (!accessToken || !clientId) return jsonResponse({ ok: false, message: '缺少登入資訊' }, 400);
        // 1) 驗證這個 access token 確實是發給「我們的」channel（防止拿別的 App 的 token 冒用）
        const verifyRes = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
        const verify = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok || String(verify.client_id || '') !== clientId || Number(verify.expires_in) <= 0) {
          return jsonResponse({ ok: false, message: 'LINE 身分驗證失敗' }, 401);
        }
        // 2) 用 access token 取回本人 userId（和機器人同 Provider → userId 一致）
        const profileRes = await fetch('https://api.line.me/v2/profile', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const profile = await profileRes.json().catch(() => ({}));
        if (!profileRes.ok || !profile.userId) {
          return jsonResponse({ ok: false, message: '取得 LINE 身分失敗' }, 401);
        }
        const token = await createSession(env.DB, String(profile.userId));
        return jsonResponse({ ok: true, token });
      } catch (error) {
        return jsonResponse({ ok: false, message: '登入失敗，請再試一次。' }, 400);
      }
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    // 報告截圖：POST 存 PNG（要登入）→ 回一個「真圖片」網址；GET 用長亂數 id 取圖，
    // 讓 LINE 內建瀏覽器能用「長按圖片 → 儲存到相簿」（data 網址在部分瀏覽器無法長按存）。
    if (url.pathname === '/shot' && request.method === 'POST') {
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      const owner = await getSessionUser(env.DB, token);
      if (!owner) return jsonResponse({ ok: false, message: '請先登入' }, 401);
      let body;
      try { body = await request.json(); } catch (error) { return jsonResponse({ ok: false }, 400); }
      const dataUrl = String(body?.png || '');
      const b64 = dataUrl.includes('base64,') ? dataUrl.split('base64,')[1] : '';
      if (!b64 || b64.length > 2_600_000) return jsonResponse({ ok: false, message: '圖片無效或過大' }, 400);
      try {
        const id = await saveReportShot(env.DB, owner, b64);
        return jsonResponse({ ok: true, url: `/shot/${id}` });
      } catch (error) {
        return jsonResponse({ ok: false, message: error.message }, 500);
      }
    }
    if (url.pathname.startsWith('/shot/') && request.method === 'GET') {
      const id = url.pathname.slice('/shot/'.length);
      const row = await getReportShot(env.DB, id);
      if (!row || !row.png) return new Response('not found', { status: 404 });
      try {
        const bin = Uint8Array.from(atob(row.png), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600', 'x-robots-tag': 'noindex' } });
      } catch (error) {
        return new Response('bad image', { status: 404 });
      }
    }
    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'cat-care-beta', now: new Date().toISOString() });
    }
    // 權杖健康檢查（不外洩權杖本身），用 INVITE_CODE 保護
    if (url.pathname === '/admin/line-token') {
      if (url.searchParams.get('key') !== String(env.INVITE_CODE || '\u0000')) {
        return jsonResponse({ ok: false }, 403);
      }
      try {
        return jsonResponse({ ok: true, ...(await checkAccessToken(env)) });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }
    // 行為追蹤儀表板（唯讀彙總；用固定金鑰保護）——結束「靠感覺」，用數據看留存/活化
    if (url.pathname === '/admin/metrics') {
      if (String(env.ADMIN_KEY || '').length < 8 || url.searchParams.get('key') !== env.ADMIN_KEY) return jsonResponse({ ok: false }, 403);
      try {
        const db = env.DB;
        const today = taipeiToday();
        const d7 = addDays(today, -6);
        // 每位使用者的記錄留存（只算真實使用 line/web，排除匯入資料）
        const { results: users } = await db.prepare(
          `SELECT lineUserId,
                  COUNT(*) recs,
                  COUNT(DISTINCT substr(eventDateTime,1,10)) days,
                  MIN(substr(eventDateTime,1,10)) firstDay,
                  MAX(substr(eventDateTime,1,10)) lastDay,
                  SUM(CASE WHEN source='web' THEN 1 ELSE 0 END) webRecs
           FROM logs WHERE isDeleted=0 AND source IN ('line','web')
           GROUP BY lineUserId ORDER BY days DESC, recs DESC`
        ).all();
        const u = users || [];
        const summary = {
          usersRecorded: u.length,
          retained2d: u.filter((x) => x.days >= 2).length,
          retained7d: u.filter((x) => x.days >= 7).length,
          activeLast7d: u.filter((x) => x.lastDay >= d7).length,
          totalRecords: u.reduce((t, x) => t + Number(x.recs), 0)
        };
        let events = [];
        try {
          const r = await db.prepare('SELECT event, COUNT(*) c, COUNT(DISTINCT lineUserId) users FROM events GROUP BY event ORDER BY c DESC').all();
          events = r.results || [];
        } catch (error) { /* events 表可能還沒建 */ }
        return jsonResponse({ ok: true, today, summary, events, users: u });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }
    // 測試者管理小網頁：手機開網址、點按鈕就能開通/關閉某位測試者（只碰存取權旗標，讀不到任何健康紀錄）
    if (url.pathname === '/admin/testers') {
      const key = String(env.ADMIN_KEY || '');
      if (key.length < 8 || url.searchParams.get('key') !== key) {
        return new Response('403 Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const db = env.DB;
      // 切換某人存取權 → 改完導回名單（用 302，避免重新整理又觸發一次）
      const toggleUser = url.searchParams.get('user');
      if (toggleUser) {
        const access = url.searchParams.get('access') === '1' ? 1 : 0;
        try { await updateUser(db, toggleUser, { betaAccess: access }); } catch (error) { /* 找不到就當沒事 */ }
        return new Response(null, { status: 302, headers: { location: `/admin/testers?key=${encodeURIComponent(key)}` } });
      }
      try {
        const today = taipeiToday();
        const d7 = addDays(today, -6);
        const { results } = await db.prepare(
          `SELECT u.lineUserId, u.displayName, u.betaAccess,
                  (SELECT COUNT(*) FROM logs l WHERE l.lineUserId = u.lineUserId AND l.isDeleted = 0 AND l.source IN ('line','web')) recs,
                  (SELECT COUNT(DISTINCT substr(eventDateTime,1,10)) FROM logs l WHERE l.lineUserId = u.lineUserId AND l.isDeleted = 0 AND l.source IN ('line','web')) days,
                  (SELECT MAX(substr(eventDateTime,1,10)) FROM logs l WHERE l.lineUserId = u.lineUserId AND l.isDeleted = 0 AND l.source IN ('line','web')) lastDay,
                  (SELECT GROUP_CONCAT(petName, '、') FROM pets p WHERE p.ownerLineUserId = u.lineUserId AND p.isDeleted = 0) pets
           FROM users u
           ORDER BY u.betaAccess DESC, recs DESC`
        ).all();
        const rows = results || [];
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const mask = (id) => '…' + String(id).slice(-6);
        const onCount = rows.filter((r) => Number(r.betaAccess) === 1).length;
        const activeCount = rows.filter((r) => r.lastDay && r.lastDay >= d7).length;
        // 併入留存數據（原本的 /admin/metrics 內容），一頁看完
        const recordedCount = rows.filter((r) => Number(r.recs) > 0).length;
        const retained2d = rows.filter((r) => Number(r.days) >= 2).length;
        const retained7d = rows.filter((r) => Number(r.days) >= 7).length;
        const totalRecords = rows.reduce((t, r) => t + (Number(r.recs) || 0), 0);
        const stat = (n, label) => `<div class="stat"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;
        const statsBar = `<div class="stats">
          ${stat(rows.length, '總人數')}
          ${stat(onCount, '已開通')}
          ${stat(recordedCount, '有記錄')}
          ${stat(activeCount, '近7天活躍')}
          ${stat(retained2d, '回訪≥2天')}
          ${stat(retained7d, '回訪≥7天')}
          ${stat(totalRecords, '總筆數')}
        </div>`;
        const cards = rows.map((r) => {
          const on = Number(r.betaAccess) === 1;
          const label = esc(r.displayName) || mask(r.lineUserId);
          const href = `/admin/testers?key=${encodeURIComponent(key)}&user=${encodeURIComponent(r.lineUserId)}&access=${on ? 0 : 1}`;
          const confirmMsg = `確定要${on ? '關閉' : '開通'}「${label}」嗎？`;
          return `<div class="row${on ? '' : ' off'}">
            <div class="info">
              <div class="name">${esc(r.displayName) || '（未命名）'} <span class="uid">${mask(r.lineUserId)}</span></div>
              <div class="meta">${r.pets ? '🐈 ' + esc(r.pets) + ' · ' : ''}記錄 ${Number(r.recs) || 0} 筆 · 最後活躍 ${esc(r.lastDay) || '—'}</div>
            </div>
            <div class="act">
              <span class="badge ${on ? 'b-on' : 'b-off'}">${on ? '已開通' : '已關閉'}</span>
              <a class="btn ${on ? 'btn-off' : 'btn-on'}" href="${href}" onclick="return confirm('${confirmMsg}')">${on ? '關閉' : '開通'}</a>
            </div>
          </div>`;
        }).join('');
        const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>測試者管理</title><style>
  :root{--brand:#734921}
  *{box-sizing:border-box;margin:0}
  body{font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#efe9dd;color:#1b1d1a;padding:18px;max-width:560px;margin:0 auto}
  h1{font-size:19px;color:#734921;margin-bottom:4px}
  .sub{font-size:12.5px;color:#6b6e63;margin-bottom:16px}
  .row{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e2e0d6;border-radius:14px;padding:13px 14px;margin-bottom:9px;box-shadow:0 4px 12px rgba(115,73,33,.05)}
  .row.off{opacity:.62}
  .info{flex:1;min-width:0}
  .name{font-size:15px;font-weight:600}
  .uid{font-size:11px;color:#a0a396;font-weight:400;margin-left:4px}
  .meta{font-size:12px;color:#6b6e63;margin-top:3px}
  .act{display:flex;flex-direction:column;align-items:flex-end;gap:7px;flex:0 0 auto}
  .badge{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px}
  .b-on{background:#e5efe2;color:#3f7a3a}.b-off{background:#eee;color:#8a8a82}
  .btn{display:inline-block;font-size:13px;font-weight:600;padding:7px 16px;border-radius:999px;text-decoration:none;-webkit-tap-highlight-color:transparent}
  .btn-off{background:#fdecec;color:#c0392b;border:1px solid #f2c9c4}
  .btn-on{background:#734921;color:#fff}
  .empty{color:#6b6e63;font-size:14px;text-align:center;padding:40px 0}
  .foot{font-size:11.5px;color:#9a9d90;margin-top:16px;line-height:1.7}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
  .stat{background:#fff;border:1px solid #e2e0d6;border-radius:12px;padding:10px 6px;text-align:center;box-shadow:0 4px 12px rgba(115,73,33,.05)}
  .stat-n{font-size:20px;font-weight:700;color:#734921;line-height:1.1}
  .stat-l{font-size:11px;color:#6b6e63;margin-top:3px}
  .sec-title{font-size:13px;font-weight:700;color:#734921;margin:4px 2px 10px}
</style></head><body>
  <h1>🐾 測試者管理</h1>
  <div class="sub">一頁看完：上方是留存數據，下方可開通／關閉測試者。只動存取權，看不到任何健康紀錄。</div>
  ${statsBar}
  <div class="sec-title">測試者名單</div>
  ${cards || '<div class="empty">還沒有任何使用者</div>'}
  <div class="foot">網址含金鑰，請勿外流。停用後對方在 LINE 會被擋在門檻外、看不到任何內容，但資料保留；重新「開通」即可恢復。</div>
</body></html>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      } catch (error) {
        return new Response('error: ' + error.message, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
    // 照護站不進搜尋引擎：靠 index.html 的 <meta name="robots"> 與 /robots.txt（靜態資源由平台直接回應，Worker 不介入）
    return env.ASSETS.fetch(request);
  },

  // 每晚 21:00（台北）：先主動確認/換新 LINE 權杖，再檢查照護提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      getAccessToken(env).catch((error) => console.error('cron token warm-up failed:', error.message))
    );
    // 清掉 2 天前的訊息冪等紀錄，避免 app_kv 無限成長
    ctx.waitUntil(purgeOldSeenMessages(env.DB, `${addDays(taipeiToday(), -2)}T00:00:00.000Z`));
    // 清掉 1 天前的報告截圖暫存（存圖是即時用途，不需長期保留）
    ctx.waitUntil(purgeOldShots(env.DB, `${addDays(taipeiToday(), -1)}T00:00:00.000Z`));
    ctx.waitUntil(runDailyReminders(env));
  }
};

async function runDailyReminders(env) {
  const db = env.DB;
  const today = taipeiToday();
  const tomorrow = addDays(today, 1);
  const nowHour = Number(taipeiNowDateTime().slice(11, 13)); // 現在的台北整點（排程每個整點跑一次）
  const { results: pets } = await db.prepare('SELECT * FROM pets WHERE isDeleted = 0').all();

  // 以「飼主」為單位合併：一晚最多一次推播（LINE 一次推播計一則，可帶最多 5 張卡）
  // 這裡先收全部（不濾提醒設定）——有共同照護者的家庭就算沒開提醒，也要送每日總結給大家。
  const byOwner = new Map();
  for (const pet of pets || []) {
    if (!pet.ownerLineUserId) continue;
    if (!byOwner.has(pet.ownerLineUserId)) byOwner.set(pet.ownerLineUserId, []);
    byOwner.get(pet.ownerLineUserId).push(pet);
  }

  for (const [ownerId, ownerPets] of byOwner) {
    try {
      // 只在「這位飼主設定的發送時間 = 現在這個整點」時才發（沒設定 → 預設晚上 9 點）
      const ownerUser = await getUser(db, ownerId);
      let sendHour = Number(ownerUser?.reminderHour);
      if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) sendHour = 21;
      if (sendHour !== nowHour) continue;

      const circle = await listCareCircle(db, ownerId);
      const isCoCare = circle.length > 1;
      // 單人家庭、又沒開任何提醒 → 維持原本「不打擾」，跳過
      if (!isCoCare && !ownerPets.some((pet) => hasAnyReminder(pet))) continue;

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

      // 每日總結：有共同照護者時，一律送一份今日彙整給整個照護圈（含共同照護者），
      // 不管有沒有提醒缺口——這是共同照護者「唯一」會收到的通知。
      if (isCoCare) {
        const digestLines = [];
        for (const pet of ownerPets) {
          const s = await recomputeDay(db, pet.petId, today);
          if (!s.entryCount) continue;
          const parts = [`水 ${Math.round(s.totalWaterMl)} ml`, `熱量 ${Math.round(s.kcal)} kcal`];
          if (s.medTakenCount || s.medIssueCount) parts.push(`藥 ${s.medTakenCount} 次${s.medIssueCount ? `（${s.medIssueCount} 筆待留意）` : ''}`);
          if (s.vomitCount) parts.push(`嘔吐 ${s.vomitCount} 次`);
          digestLines.push(ownerPets.length > 1 ? `【${pet.petName}】${parts.join('・')}` : parts.join('・'));
        }
        if (digestLines.length) {
          const digestPet = ownerPets.length === 1 ? ownerPets[0] : { petName: '今日照護' };
          // 放在最前面，當作當晚主訊息；標題直接用「今日照護提醒」，body 不再放「今日彙整」字樣
          messages.unshift(reminderFlex(digestPet, digestLines, '今日照護提醒'));
          textFallbacks.unshift(`今日照護提醒\n${digestLines.join('\n')}`);
        }
      }

      if (!messages.length) continue;
      // 共同照護 → 整個照護圈都收到每日總結；單人 → 只有飼主本人
      const recipients = isCoCare ? circle : [ownerId];
      for (const recipient of recipients) {
        try {
          await pushMessages(env, recipient, messages.slice(0, 5));
        } catch (flexError) {
          console.warn('reminder flex failed, fallback to text:', flexError.message);
          try { await pushText(env, recipient, textFallbacks.join('\n\n')); } catch (textErr) { console.error('reminder text failed:', textErr.message); }
        }
      }
      console.log(JSON.stringify({ step: 'reminder_sent', cards: messages.length, recipients: recipients.length }));
    } catch (error) {
      console.error('reminder push failed:', error.message);
    }
  }
}

async function handleWebhook(request, env, url, ctx) {
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

  // 立刻回 200 給 LINE，實際處理與回覆在背景進行（replyToken 仍在有效窗內）。
  // 這樣即使記錄/回覆稍慢，LINE 也不會判定逾時而「重送」，避免重複紀錄與
  // replyToken 被搶用造成「有時有回、有時沒回」。ctx.waitUntil 讓背景工作跑完才回收。
  const work = processWebhookEvents(events, env, baseUrl);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  else await work;

  return jsonResponse({ ok: true });
}

async function processWebhookEvents(events, env, baseUrl) {
  for (const event of events) {
    try {
      if (event.type === 'follow') {
        await handleFollow(event, env);
      } else if (event.type === 'message' && event.message?.type === 'text') {
        // 兩層去重：同實例用記憶體快速擋；跨實例／LINE 重送用資料庫原子認領（避免回兩次）
        if (isDuplicateMessage(event.message.id)) continue;
        if (!(await claimMessageOnce(env.DB, event.message.id))) continue;
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
}

// Flex 卡片按鈕：目前只有「刪除這筆」
// ---------- 引導流程卡（一張卡一件事，全部大按鈕；自由輸入用 pendingAction 等待） ----------

function stepMedCard(petName, step = '') {
  return onboardCard({
    step,
    title: `${petName}每天需要餵藥嗎？`,
    subtitle: '選了之後，今日記錄和晚上提醒都會幫你看著',
    rows: [
      [menuCell('早', '一天一次', '餵藥時段 早'), menuCell('早晚', '一天兩次', '餵藥時段 早晚')],
      [menuCell('早中晚', '一天三次', '餵藥時段 早中晚'), menuCell('只有晚上', '一天一次', '餵藥時段 晚')],
      [menuCell('不用餵藥', '之後可以再設定', '餵藥時段 不用')]
    ],
    alt: '每天需要餵藥嗎？'
  });
}

// 上手最小門檻：名字＋目前體重（給醫生看與每日喝水量目標都靠體重）。刻意不放「跳過」按鈕。
function weightOnboardCard(petName, step = '第 2 步・共 3 步') {
  return onboardCard({
    step,
    title: `${petName}現在幾公斤？`,
    subtitle: '直接打數字，例如 4.2（之後隨時能再量再記）',
    alt: `${petName}現在幾公斤？`
  });
}

function stepFoodCard(step = '第 3 步・共 3 步', subtitle = '建了記錄就自動算熱量（乾乾、罐罐都可）') {
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

function medAskCard(petName, step = '選填') {
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
    subtitle: `現在幫${petName}記第一筆——點「快速紀錄」用按鈕就好，不用打字`,
    rows: [
      [menuCell('快速紀錄', '點按鈕記，不用打字', '紀錄', true)],
      [menuCell('怎麼記？看範例', '想打字更快看這', '怎麼記'), menuCell('今日記錄', '看今天狀況', '今天')],
      [menuCell('補充貓咪資料', '晶片・疾病・疫苗', '補資料'), menuCell('開啟照護站', '回診・回顧・設定', '照護站')]
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

// 引導建立食物：
//  - 熱量（每克 kcal）各產品差異大，絕不自動帶預設值；沒填就留 0，記錄時先不算熱量、之後在照護站補正確值。
//  - 含水比例：罐頭/濕食用 80%（濕食含水的物理常數，可在照護站微調）；乾糧/其他不預設（0）。
async function createGuidedFood(db, lineUserId, foodType, name, kcalIn) {
  const isWet = isWetFoodType(foodType);
  const kcalPerGram = kcalIn > 0 ? kcalIn : 0;
  const waterRatio = isWet ? 0.8 : 0;
  const food = await createFoodItem(db, lineUserId, {
    displayName: name,
    foodType,
    kcalPerGram,
    waterRatio,
    note: kcalIn > 0 ? '' : 'LINE 引導建立（熱量待補）'
  });
  // ④ 一填公式，就回頭把過去這個品項沒算到熱量的紀錄補算回來
  let healed = 0;
  if (kcalPerGram > 0) {
    try { ({ healed } = await healFoodKcal(db, food)); } catch (error) { console.error('healFoodKcal failed:', error.message); }
  }
  return { kcalPerGram, waterRatio, needsKcal: !(kcalIn > 0), healed };
}

function foodDoneCard(name, foodType, info) {
  const waterPct = Math.round(info.waterRatio * 100);
  const healedLine = info.healed > 0 ? `\n✓ 順便把過去 ${info.healed} 筆（含估算的）熱量補成精確值了。` : '';
  const estimable = isEstimableType(foodType);
  const subtitle = info.needsKcal
    ? (estimable
        ? `${foodType}・含水 ${waterPct}%\n還沒填每克熱量，記錄時會先用「${foodType}」類型預設估算（畫面標 ≈）。到照護站「設定→常吃的食物」填精確每克熱量，就會變精確值、並自動補算過去的估算。`
        : `${foodType}・含水 ${waterPct}%\n這類（零食/其他）每家熱量差很多，沒辦法估。填一次每克熱量（包裝上通常有），以後這個就會自動算。`)
    : `${foodType}・每克 ${info.kcalPerGram} kcal・含水 ${waterPct}%${healedLine}`;
  return onboardCard({
    title: `已建立「${name}」`,
    subtitle,
    rows: [
      [menuCell('再建一種', '乾乾罐罐都建更好用', '設定食物'), menuCell('下一步：保健品/藥', '有在吃的話', '設定保健品')]
    ],
    alt: `已建立「${name}」`
  });
}

// 等待中的自由輸入（名字/體重/生日/食物名/克數）；回 true 表示已處理
async function handlePending(env, event, { db, user, pet, pets, lineUserId, ownerId = lineUserId, text, baseUrl }) {
  const pending = user.pendingAction;
  const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
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
      newPet = await createPet(db, ownerId, { petName: text });
      if (!pets.length) await updateUser(db, lineUserId, { defaultPetId: newPet.petId });
    }
    // 最小門檻：建檔後先問目前體重（必填），再進食物設定
    await updateUser(db, lineUserId, { pendingAction: 'weight-onboard' });
    await replyOrPushFlex(env, event, weightOnboardCard(newPet.petName), `已幫「${newPet.petName}」建立檔案！先告訴我${newPet.petName}現在幾公斤？直接打數字，例如 4.2`);
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

  // 上手最小門檻的體重：建檔後第一件事，記完就接著（可略過的）食物設定
  if (pending === 'weight-onboard' && pet) {
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:kg|公斤)?$/i);
    if (!m) { await clear(); return false; }
    await updatePetFields(db, pet.petId, { weightKg: Number(m[1]) });
    await clear();
    await replyOrPushFlex(env, event, stepFoodCard('第 3 步・共 3 步', `已記下 ${pet.petName} ${m[1]} kg！最常吃哪一種？建好記錄就自動算熱量和水分（也可先跳過，直接開始記）`), `已記下體重 ${m[1]} kg。接下來可建常吃的食物：輸入「設定罐頭」「設定乾糧」，或直接開始記錄`);
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
    const foods = await listFoods(db, ownerId);
    if (foods.some((food) => food.displayName === name)) {
      await replyOrPushFlex(env, event, foodDoneCard(name, foodType, { kcalPerGram: '—', waterRatio: 0, usedDefault: false }), `「${name}」已經建立過了`);
      return true;
    }
    const info = await createGuidedFood(db, ownerId, foodType, name, kcalIn);
    await replyOrPushFlex(env, event, foodDoneCard(name, foodType, info), `已建立「${name}」（${foodType}）`);
    return true;
  }

  if (pending === 'medname' && pet) {
    if (asIntent.type !== 'unknown' || !text || text.length > 15) { await clear(); return false; }
    await createMedItem(db, pet.petId, text);
    await clear();
    await replyOrPushFlex(env, event, onboardCard({
      title: `「${text}」多久吃一次？`,
      subtitle: '選了之後，今日記錄和晚上提醒都會幫你看著',
      rows: [
        [menuCell('早', '一天一次', '餵藥時段 早'), menuCell('早晚', '一天兩次', '餵藥時段 早晚')],
        [menuCell('早中晚', '一天三次', '餵藥時段 早中晚'), menuCell('只有晚上', '一天一次', '餵藥時段 晚')]
      ],
      skip: { label: '不固定，先這樣', send: '餵藥時段 不用' },
      alt: `「${text}」多久吃一次？`
    }), `已記下「${text}」，多久吃一次？（輸入：餵藥時段 早晚）`);
    return true;
  }

  // 回顧清單「改數字」：更新指定那一筆的數量（食物連帶重算熱量/含水）
  if (pending.startsWith('editLog|')) {
    const logId = pending.slice(8);
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|克|公克|ml|毫升)?$/i);
    if (!m) { await clear(); return false; }
    await clear();
    const log = await getLog(db, logId);
    if (!log || log.lineUserId !== ownerId || log.isDeleted) {
      await replyOrPush(env, event, '找不到那筆紀錄了');
      return true;
    }
    const newAmount = Number(m[1]);
    const fields = { amount: newAmount };
    if (log.category === 'water') {
      fields.waterMl = newAmount;
    } else if (log.category === 'food') {
      const food = log.foodId ? await getFood(db, log.foodId) : null;
      const derived = deriveFoodFields(newAmount, log.foodType, food);
      fields.kcal = derived.kcal;
      fields.waterMl = derived.waterMl;
    }
    const updated = await updateLog(db, logId, fields, lineUserId);
    const eventDate = String(updated.eventDateTime).slice(0, 10);
    const summary = await recomputeDay(db, updated.petId, eventDate);
    const cardPet = await getPet(db, updated.petId);
    const subParts = [];
    if (updated.kcal) subParts.push(`${updated.kcal} kcal`);
    if (updated.category === 'food' && updated.waterMl) subParts.push(`含水 ${updated.waterMl} ml`);
    const categoryKey = updated.category === 'food' ? (updated.foodType === '乾糧' ? 'dry' : 'wet') : updated.category;
    await replyOrPushFlex(env, event, recordFlex({
      pet: cardPet, categoryKey, mainText: describeLog(updated), subText: subParts.join('・'),
      summary, date: eventDate, logId: updated.logId, title: `✓ 已更新・${cardPet?.petName || '貓貓'}`
    }), recordReply(describeLog(updated), cardPet, summary, [], eventDate));
    return true;
  }

  // 從食物快捷卡選了某品項後：只需打幾克（可帶「水 N」加水），直接用該食物的公式記錄
  if (pending.startsWith('amountFood|')) {
    const foodId = pending.slice(11);
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|克|公克)?(?:\s*(?:水|加水|泡水)\s*([0-9]+(?:\.[0-9]+)?))?$/i);
    if (!m) {
      // 開頭是數字 → 應是想回答克數但格式跑掉 → 保留待辦、溫柔再問一次（不清空情境）
      if (/^\s*[0-9]/.test(text)) {
        await replyOrPush(env, event, '直接打幾克就好，例如 25。\n要另外加水就打「25 水 15」（先克數、後水量）。');
        return true;
      }
      await clear();
      return false;
    }
    await clear();
    const food = await getFood(db, foodId);
    if (!food || food.ownerLineUserId !== ownerId || food.isDeleted || !pet) {
      await replyOrPush(env, event, '找不到這個品項，請再選一次。');
      return true;
    }
    await handleRecord(env, event, pet, {
      category: 'food', foodType: food.foodType, itemName: food.displayName,
      amount: Number(m[1]), unit: 'g', addedWaterMl: m[2] ? Number(m[2]) : 0,
      medStatus: '', medSlot: '', note: ''
    }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    return true;
  }

  if (pending.startsWith('amount|')) {
    const base = pending.slice(7);
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|克|公克|ml|毫升)?$/i);
    if (!m) {
      // 開頭是數字卻格式跑掉 → 保留情境、溫柔再問一次，不清空
      if (/^\s*[0-9]/.test(text)) {
        await replyOrPush(env, event, '直接打數字就好，例如 20。');
        return true;
      }
      await clear();
      return false;
    }
    await clear();
    const intent2 = parseMessage(`${base} ${m[1]}`);
    if (intent2.type === 'record' && pet) {
      await handleRecord(env, event, pet, intent2.record, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
      return true;
    }
    return false;
  }

  // 點嘔吐/排便/精神/備註/營養補充 → 直接打描述就記好
  if (pending.startsWith('note|') && pet) {
    const cat = pending.slice(5);
    // 只有在使用者改打了「別的類別」完整紀錄（例如問補充時打「吐了」）才交回正常流程；
    // 若打的正是這個類別的內容（例如問補充時打「益生菌」），就把整句當作名稱/描述記下來，別讓它被吃掉。
    if (asIntent.type === 'record' && asIntent.record.category !== cat) { await clear(); return false; }
    await clear();
    await handleRecord(env, event, pet, {
      category: cat, amount: 0, unit: '', foodType: '', medStatus: '', medSlot: '',
      itemName: cat === 'supplement' ? text : '',
      note: cat === 'supplement' ? '' : text
    }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    return true;
  }

  await clear();
  return false;
}

// ── Quick Reply 點按記錄：一路點就能記，不用背指令（打字仍可當捷徑）──
const qrMsg = (label, text) => ({ type: 'action', action: { type: 'message', label: String(label).slice(0, 20), text } });
const qrPost = (label, data, displayText) => ({ type: 'action', action: { type: 'postback', label: String(label).slice(0, 20), data, displayText: displayText || String(label) } });

// 症狀類分類鈕（吃喝藥用一鍵捷徑，這裡只留較少用的狀況當安全網）
function symptomCategoryQuick() {
  return [
    qrPost('嘔吐', 'action=rec&k=vomit', '嘔吐'),
    qrPost('大小便', 'action=rec&k=stool', '大小便'),
    qrPost('精神', 'action=rec&k=mood', '精神'),
    qrPost('保健', 'action=rec&k=supplement', '保健'),
    qrPost('備註', 'action=rec&k=note', '備註')
  ];
}
// 找出這隻貓的預設貓 id（給一鍵捷徑用）
async function defaultPetId(db, lineUserId, ownerId) {
  try {
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    return pet?.petId || '';
  } catch (error) { return ''; }
}
// progressive disclosure：紀錄很少＝還在學，才顯示「怎麼打字記錄」教學鈕；上手後自動收起
async function isBeginner(db, petId) {
  if (!petId) return true;
  try {
    const r = await db.prepare('SELECT COUNT(*) c FROM logs WHERE petId = ? AND isDeleted = 0').bind(petId).first();
    return (Number(r?.c) || 0) < 15;
  } catch (error) { return false; }
}
const TEACH_BTN = qrPost('❓ 怎麼打字記錄', 'action=howtype', '怎麼打字記錄');
// 一鍵捷徑：把「這隻貓最常記的吃喝藥」重建成可直接送出的指令，點一下就記好（也順便讓人記住指令長怎樣）
async function quickShortcuts(db, petId) {
  const DEFAULTS = ['水 20', '水 30', '罐頭 30', '乾糧 5', '藥 早 已吃'];
  let cmds = [];
  if (petId) {
    try {
      const { results } = await db.prepare(
        `SELECT category, foodType, itemName, CAST(ROUND(amount) AS INTEGER) amt, medSlot, medStatus, COUNT(*) c, MAX(eventDateTime) t
         FROM logs WHERE petId=? AND isDeleted=0 AND category IN ('water','food','med')
         GROUP BY category, foodType, itemName, amt, medSlot, medStatus ORDER BY c DESC, t DESC LIMIT 10`
      ).bind(petId).all();
      for (const r of results || []) {
        if (r.category === 'water' && r.amt > 0) cmds.push(`水 ${r.amt}`);
        else if (r.category === 'food' && r.foodType && r.amt > 0) cmds.push(foodShortcutCmd(r.foodType, r.itemName, r.amt));
        else if (r.category === 'med') cmds.push(`藥 ${[r.medSlot, r.medStatus || '已吃'].filter(Boolean).join(' ')}`.trim());
      }
    } catch (error) { /* 查不到就用預設 */ }
  }
  cmds = [...new Set(cmds)];
  for (const d of DEFAULTS) { if (cmds.length >= 5) break; if (!cmds.includes(d)) cmds.push(d); }
  return cmds.slice(0, 9).map((c) => qrMsg(c, c));
}
// 看不懂客戶輸入時的引導：不當死路，教打字 ＋ 這隻貓的一鍵捷徑，順手就能記
async function guideUnknown(env, event, petId) {
  const items = [
    ...await quickShortcuts(env.DB, petId),
    TEACH_BTN,
    qrPost('其他狀況（吐/便…）', 'action=recmore', '其他狀況')
  ];
  await replyOrPushQuick(env, event,
    '咦？這句我看不懂 🙏\n\n'
    + '記錄可以直接打字 👇\n'
    + '· 喝水 → 水 20\n'
    + '· 吃飯 → 罐頭 30／乾糧 5\n'
    + '· 餵藥 → 藥 早 已吃\n\n'
    + '或點下面你常記的，一下就好：',
    items);
}
// 歡迎卡＋一鍵捷徑（P1-1：新朋友加入/解鎖就能直接記第一筆）
async function welcomeMsg(db, lineUserId, ownerId) {
  const w = welcomeFlex();
  try {
    const petId = await defaultPetId(db, lineUserId, ownerId);
    w.quickReply = { items: [...await quickShortcuts(db, petId), TEACH_BTN] };
  } catch (error) { /* ignore */ }
  return w;
}
// 第二層：每一類的常用值（點一個就記好；「其他」才要打字）
const RECORD_L2 = {
  water: { prompt: '喝了多少 ml？點一下就記好', items: () => [...[10, 20, 30, 50, 80].map((n) => qrMsg(String(n), `水 ${n}`)), qrPost('其他', 'action=rec&k=water_other', '其他數字')] },
  med: { prompt: '這次的藥？點一下就記好', items: () => [qrMsg('早·已吃', '藥 早 已吃'), qrMsg('晚·已吃', '藥 晚 已吃'), qrMsg('中午·已吃', '藥 中午 已吃'), qrMsg('未餵', '藥 未餵')] },
  food: { prompt: '吃哪一種？', items: () => [qrPost('罐頭', 'action=rec2&t=罐頭', '罐頭'), qrPost('乾糧', 'action=rec2&t=乾糧', '乾糧'), qrPost('濕食', 'action=rec2&t=濕食', '濕食'), qrPost('生食', 'action=rec2&t=生食', '生食'), qrPost('零食', 'action=rec2&t=零食', '零食')] },
  vomit: { prompt: '吐了什麼？點一個，或自己打描述', items: () => [qrMsg('透明泡沫', '吐 透明泡沫'), qrMsg('黃色液體', '吐 黃色液體'), qrMsg('食物或毛', '吐 食物或毛'), qrMsg('只是吐了', '吐了')] },
  stool: { prompt: '大小便情況？點一個就好', items: () => [qrMsg('正常便', '大便 正常'), qrMsg('軟便', '軟便'), qrMsg('拉肚子', '拉肚子'), qrMsg('尿尿正常', '尿尿 正常')] },
  mood: { prompt: '今天精神如何？', items: () => [qrMsg('活力好', '精神 活力好'), qrMsg('普通', '精神 普通'), qrMsg('懶懶的', '精神 懶懶的'), qrMsg('沒精神', '精神 沒精神')] },
  supplement: { prompt: '補充了什麼？點一個或自己打', items: () => [qrMsg('益生菌', '保健 益生菌'), qrMsg('化毛膏', '保健 化毛膏'), qrMsg('離胺酸', '保健 離胺酸')] }
};
function foodGramQuick(type) {
  return [...[5, 10, 15, 20, 30].map((n) => qrMsg(String(n), `${type} ${n}`)), qrPost('其他克數', `action=rec2other&t=${type}`, '其他克數')];
}

async function handlePostback(event, env, baseUrl) {
  const db = env.DB;
  const lineUserId = event.source?.userId;
  const data = new URLSearchParams(String(event.postback?.data || ''));
  const action = data.get('action');

  if (action === 'fillFood' || action === 'fill') return; // 只是把文字填進輸入框，不需回覆

  // 共同照護者操作時解析到飼主本人（飼主本人時 ownerId === lineUserId，行為不變）
  const ownerId = lineUserId ? await resolveDataOwner(db, lineUserId) : lineUserId;

  // 其他狀況（較少記的）：點分類 → 常用描述，兩層即可
  if (action === 'recmore') {
    await replyOrPushQuick(env, event, '其他狀況？點一個分類 👇', symptomCategoryQuick());
    return;
  }
  // 教打字：熟了直接打指令最快
  if (action === 'howtype') {
    await track(db, lineUserId, 'howtype');
    await replyOrPushQuick(env, event,
      '熟了之後，直接打字最快 👇（不用先點）\n\n'
      + '· 喝水 → 打「水 20」\n'
      + '· 吃飯 → 打「罐頭 30」或「乾糧 5」\n'
      + '· 餵藥 → 打「藥 早 已吃」\n'
      + '· 嘔吐 → 打「吐 黃液」\n'
      + '· 一次記多筆 → 「水20 乾糧5 藥早已吃」\n'
      + '· 補昨天 → 「昨天 21:30 水 20」',
      [qrMsg('看完整記法', '完整記法'), qrMsg('先記一筆', '快速記錄')]);
    return;
  }
  // ── Quick Reply 點按記錄：第一層點分類 → 冒出第二層常用值 ──
  if (action === 'rec') {
    const k = data.get('k') || '';
    if (k === 'water_other') {
      await updateUser(db, lineUserId, { pendingAction: 'amount|水' });
      await replyOrPush(env, event, '喝了多少 ml？直接打數字，例如 25');
      return;
    }
    if (k === 'note') {
      await updateUser(db, lineUserId, { pendingAction: 'note|note' });
      await replyOrPush(env, event, '想記什麼？直接打字就好。');
      return;
    }
    if (k === 'food') {
      // 有建好的品項就先讓他點品項（免選類型），沒有才問類型
      const foods = await listFoods(db, ownerId);
      if (foods.length) {
        const items = foods.slice(0, 10).map((food) => qrPost(String(food.displayName).slice(0, 20), `action=pickFood&foodId=${food.foodId}`, `記 ${food.displayName}`));
        items.push(qrPost('其他/新品項', 'action=rec2&t=罐頭', '其他'));
        await replyOrPushQuick(env, event, '吃哪一個？點一下，再點幾克', items);
        return;
      }
    }
    const spec = RECORD_L2[k];
    if (spec) { await replyOrPushQuick(env, event, spec.prompt, spec.items()); return; }
    return;
  }
  // 吃飯選了類型 → 冒出常用克數
  if (action === 'rec2') {
    const t = data.get('t') || '罐頭';
    await replyOrPushQuick(env, event, `${t}吃了幾克？點一下就記好`, foodGramQuick(t));
    return;
  }
  if (action === 'rec2other') {
    const t = data.get('t') || '罐頭';
    await updateUser(db, lineUserId, { pendingAction: `amount|${t}` });
    await replyOrPush(env, event, `${t}吃了幾克？直接打數字，例如 30`);
    return;
  }

  // 快速紀錄點選食物品項 → 冒出常用克數，點一下就記好（不用打字、不會斷在半路）
  if (action === 'pickFood') {
    const foodId = data.get('foodId') || '';
    const food = foodId ? await getFood(db, foodId) : null;
    if (!food || food.ownerLineUserId !== ownerId || food.isDeleted) {
      await replyOrPush(env, event, '找不到這個品項，請再選一次。');
      return;
    }
    const items = [...[5, 10, 15, 20, 30].map((n) => qrPost(String(n), `action=recFoodG&foodId=${foodId}&g=${n}`, `${food.displayName} ${n}g`)),
      qrPost('其他克數', `action=recFoodGother&foodId=${foodId}`, '其他克數'),
      qrPost('↩ 重選', 'action=rec&k=food', '重選品項')];
    await replyOrPushQuick(env, event, `「${food.displayName}」吃了幾克？點一下就記好`, items);
    return;
  }
  // 點克數 → 直接用該食物的公式記錄
  if (action === 'recFoodG' || action === 'recFoodGother') {
    const foodId = data.get('foodId') || '';
    const food = foodId ? await getFood(db, foodId) : null;
    if (!food || food.ownerLineUserId !== ownerId || food.isDeleted) {
      await replyOrPush(env, event, '找不到這個品項，請再選一次。');
      return;
    }
    if (action === 'recFoodGother') {
      await updateUser(db, lineUserId, { pendingAction: `amountFood|${foodId}` });
      await replyOrPush(env, event, `「${food.displayName}」吃了幾克？直接打數字，例如 30\n（要加水就打「30 水 20」）`);
      return;
    }
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    await handleRecord(env, event, pet, {
      category: 'food', foodType: food.foodType, itemName: food.displayName,
      amount: Number(data.get('g')) || 0, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: ''
    }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    return;
  }
  // ② 確認卡按「就先記著，不算熱量」→ 照打的品名如實記下（forceRaw 跳過再次確認），確認卡會標紅提醒
  if (action === 'recFoodRaw') {
    const t = data.get('t') || '罐頭';
    const g = Number(data.get('g')) || 0;
    const name = data.get('name') || '';
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    await handleRecord(env, event, pet, {
      category: 'food', foodType: t, itemName: name,
      amount: g, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '', forceRaw: true
    }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    return;
  }

  // 月曆點某一天 → 回那天的總結卡
  if (action === 'calDay') {
    const date = data.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const { user } = await ensureUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const summary = await recomputeDay(db, pet.petId, date);
    if (!summary.entryCount) {
      await replyOrPush(env, event, `${shortDate(date)}（${pet.petName}）\n這天沒有紀錄。`);
      return;
    }
    const siteUrl = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, todayFlex({ pet, date, summary, dateLabel: shortDate(date), siteUrl }), todayReply(pet, date, summary));
    return;
  }

  // 月曆切換月份（不超過本月，最多回溯 24 個月）
  if (action === 'calMonth') {
    const month = data.get('month') || '';
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const { user } = await ensureUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
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
    const calendarUrl = await siteLink(env, baseUrl, lineUserId, 'calendar');
    await replyOrPushFlex(env, event, monthFlex(pet.petName, target, rows, today, calendarUrl), monthReply(pet.petName, monthLabel, rows));
    return;
  }

  // 回顧清單「改數字」：進入等待輸入新數量的狀態
  if (action === 'editAmount') {
    const logId = data.get('logId') || '';
    const log = await getLog(db, logId);
    if (!log || log.lineUserId !== ownerId || log.isDeleted) {
      await replyOrPush(env, event, '找不到那筆紀錄了');
      return;
    }
    if (!['water', 'food'].includes(log.category)) {
      await replyOrPush(env, event, `「${describeLog(log)}」沒有數量可以改，\n可以改按「刪除」。`);
      return;
    }
    await updateUser(db, lineUserId, { pendingAction: `editLog|${logId}` });
    const unit = log.category === 'water' ? 'ml' : 'g';
    await replyOrPush(env, event, `「${describeLog(log)}」\n要改成多少 ${unit}？\n直接打數字就好（例如 ${unit === 'ml' ? '60' : '13'}）`);
    return;
  }

  // 刪除前先問一次（避免手機誤觸）
  if (action === 'delAsk') {
    try {
      const log = await getLog(db, data.get('logId') || '');
      if (log && log.lineUserId === ownerId && !log.isDeleted) {
        await replyOrPushFlex(env, event, confirmDeleteFlex(log.logId, describeLog(log)), '確定要刪除這筆嗎？回覆「刪除」確認。');
      } else {
        await replyOrPush(env, event, '找不到那筆紀錄了，可能已經刪除。');
      }
    } catch (error) {
      console.error('delAsk failed:', error);
      await replyOrPush(env, event, '系統忙碌，請再試一次。');
    }
    return;
  }
  if (action === 'cancelDel') {
    await replyOrPush(env, event, '好，這筆先保留著 👌');
    return;
  }

  if (action === 'delLog') {
    try {
      const log = await getLog(db, data.get('logId') || '');
      if (log && log.lineUserId === ownerId && !log.isDeleted) {
        await softDeleteLog(db, log.logId, lineUserId);
        await recomputeDay(db, log.petId, String(log.eventDateTime).slice(0, 10));
      }
    } catch (error) {
      console.error('delLog failed:', error);
    }
    // 不論結果都回一張安心卡（避免使用者卡住沒反應）
    const url = await siteLink(env, baseUrl, lineUserId);
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
  await track(env.DB, lineUserId, 'follow');
  await replyOrPushFlex(env, event, await welcomeMsg(env.DB, lineUserId, lineUserId), welcomeText());
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

  let text = normalizeText(event.message?.text || '');

  // 共同照護：接受邀請——直接打 6 碼英數邀請碼即可（也相容舊寫法「加入 ABC123」）；
  // 收到整段邀請訊息直接貼上也行（從「邀請碼: XXXXXX」抓碼）
  let codeMatch = text.match(/^(?:加入\s*)?([A-Za-z0-9]{6})$/);
  let pastedInvite = false;
  if (!codeMatch) {
    const pasted = text.match(/邀請碼\s*[:：]?\s*([A-Za-z0-9]{6})\b/);
    if (pasted) { codeMatch = pasted; pastedInvite = true; }
  }
  if (codeMatch) {
    const explicit = pastedInvite || text.startsWith('加入'); // 明確要加入，無效時給提示
    const result = await redeemCareInvite(db, codeMatch[1], lineUserId);
    if (result.ok) {
      await track(db, lineUserId, 'invite_redeemed');
      if (!isBetaAllowed(user)) await updateUser(db, lineUserId, { betaAccess: 1 });
      await replyOrPush(env, event, '✓ 加入成功！接下來你在這裡打「水 20」「罐頭 30」就會記進對方的貓咪，也能打「照護站」開網站看完整資料 🐈');
      try { await ensurePersonalRichMenu(env, baseUrl, lineUserId); } catch (error) { console.error('personal richmenu failed:', error.message); }
      return;
    }
    if (explicit) {
      const why = result.reason === 'expired' ? '這組邀請碼已過期（7 天有效），請對方再給你一組新的。'
        : result.reason === 'self' ? '這是你自己的邀請碼，不用加入喔。'
        : '找不到這組邀請碼，請確認有沒有打錯（6 碼英數）。';
      await replyOrPush(env, event, why);
      return;
    }
    // 只打了 6 碼但不是有效邀請碼 → 當一般訊息處理，不吃掉、不報錯
  }

  // 這位使用者實際操作誰的資料：飼主本人＝自己；共同照護者＝那位飼主（本人時完全等於原行為）
  const ownerId = await resolveDataOwner(db, lineUserId);
  const isCaregiver = ownerId !== lineUserId;
  const caregiverName = isCaregiver ? String(user.displayName || '') : '';
  const pets = await listPets(db, ownerId);

  // 封閉測試門檻：未解鎖者只能輸入邀請碼，看不到任何產品內容
  if (!isBetaAllowed(user)) {
    const code = String(env.INVITE_CODE || '__closed_beta__').trim();
    if (normalizeCode(text) === normalizeCode(code)) {
      await updateUser(db, lineUserId, { betaAccess: 1 });
      await replyOrPushFlex(env, event, await welcomeMsg(db, lineUserId, ownerId), welcomeText());
      return;
    }
    await replyOrPush(env, event, gateText());
    return;
  }

  // 任何一則訊息都順手確認專屬選單是最新版（版本相符時只是一次快取讀取、很便宜；
  // 版本不符才會重建＝改版後使用者一互動就換到新選單，不必特地做某個動作）
  try { await ensurePersonalRichMenu(env, baseUrl, lineUserId); } catch (error) { console.error('richmenu ensure failed:', error.message); }

  // 電腦登入：在電腦網站輸入這組碼即可登入（免把手機連結複製過去）
  if (['電腦登入', '電腦', '網頁登入', '網站登入', '登入碼', '用電腦', '電腦版'].includes(text)) {
    const code = await createLoginCode(db, lineUserId);
    await replyOrPush(env, event,
      `💻 用電腦登入照護站：\n\n1. 電腦打開這個網址：\n${baseUrl}\n\n2. 在登入畫面輸入這組登入碼：\n${code}\n\n（10 分鐘內有效，用一次就好；登入後電腦會記住你，下次直接開網址就進得去）`);
    return;
  }

  // 共同照護：飼主產生邀請碼，給家人/幫手一起照護
  if (['邀請', '共同照護', '加入照護', '一起照護', '找人照護', '找人一起照顧', '新增照護者', '加人',
       '邀請家人', '邀請人', '加入人', '怎麼加入人', '加家人', '新增照顧者', '共同照顧', '一起照顧'].includes(text)
      || /加入.*一起照/.test(text) || /怎麼.*加入.*人/.test(text)) {
    const code = await createCareInvite(db, ownerId);
    const members = await listCareMembers(db, ownerId);
    const shareMsg = `一起照顧貓咪吧 🐈\n加入官方 LINE：\n${LINE_ADD_URL}\n加入後打這組邀請碼：\n${code}\n（7 天內有效，直接把整段訊息貼給管家也可以）`;
    // 兩則：①可長按轉傳的整段邀請文 ②邀請碼卡（📋 一鍵複製）
    try {
      await replyMessages(env, event.replyToken, [
        { type: 'text', text: `🤝 把下面整段轉傳給對方 👇\n\n${shareMsg}` },
        careInviteFlex(code, members.length)
      ]);
    } catch (error) {
      await replyOrPush(env, event, `🤝 把下面整段傳給對方 👇\n\n${shareMsg}`);
    }
    return;
  }

  // 多貓咪：
  //  - 只打貓咪名（如「蚵仔」）→ 切換「目前登記的貓」，之後每筆都記給牠（與網站同步）
  //  - 名字前綴（如「冠關 水 20」）→ 只有這一則記給那隻，不改預設
  let pet = await resolveDefaultPet(db, user, pets);
  let switchTarget = null;
  for (const candidate of pets) {
    const names = [candidate.petName, `@${candidate.petName}`];
    if (names.includes(text)) { switchTarget = candidate; break; }
    const pfx = names.find((n) => text.startsWith(`${n} `));
    if (pfx) { pet = candidate; text = text.slice(pfx.length).trim(); break; }
  }
  if (switchTarget) {
    if (pets.length > 1) {
      if (user.defaultPetId !== switchTarget.petId) {
        await updateUser(db, lineUserId, { defaultPetId: switchTarget.petId });
      }
      // 明確告訴使用者「怎麼切回去」：把其他貓的名字列出來當切換方法（切換是持續生效的，別讓人忘了切回）
      const others = pets.filter((p) => p.petId !== switchTarget.petId).map((p) => p.petName).filter(Boolean);
      const backHint = others.length ? `\n\n👉 想換回其他貓，打名字就好：${others.join('、')}` : '';
      await replyOrPush(env, event, `✓ 已切換，接下來都記給「${switchTarget.petName}」🐈\n現在打「水 20」「罐頭 30」就會記到牠。${backHint}`);
      return;
    }
    pet = switchTarget; // 單貓：維持原本「看今天」行為
    text = '今天';
  }

  // 說明選單卡的教學子頁
  if (['如何記錄', '如何紀錄', '如何記', '怎麼記', '怎麼記錄', '記法', '記錄方式', '怎麼用'].includes(text)) {
    const howtoSiteUrl = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, quickRecordCarousel({ petName: pet?.petName || '', siteUrl: howtoSiteUrl }), recordTutorial());
    return;
  }
  if (['完整記法', '完整記錄', '所有記法', '記法大全'].includes(text)) {
    await replyOrPushFlex(env, event, recordTutorialFlex(), recordTutorial());
    return;
  }
  if (text === '如何記餵藥' || text === '如何記藥') {
    await replyOrPush(env, event, medTutorial());
    return;
  }

  // 引導流程等待中的自由輸入（名字/體重/生日/食物名/克數）
  if (user.pendingAction) {
    const consumed = await handlePending(env, event, { db, user, pet, pets, lineUserId, ownerId, text, baseUrl });
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
      const newPet = await createPet(db, ownerId, { petName: intent.name });
      if (!pets.length) await updateUser(db, lineUserId, { defaultPetId: newPet.petId });
      // 最小門檻：建檔後先問目前體重（必填），再進食物設定
      await updateUser(db, lineUserId, { pendingAction: 'weight-onboard' });
      await replyOrPushFlex(env, event, weightOnboardCard(newPet.petName), `已幫「${intent.name}」建立檔案！先告訴我${intent.name}現在幾公斤？直接打數字，例如 4.2`);
      return;
    }

    case 'exampleMenu': {
      await replyOrPushFlex(env, event, exampleCard(), '怎麼記：\n水 60（記喝水）\n罐頭 30（記食物）\n藥 早 已吃\n吐了');
      return;
    }

    case 'petDataLink': {
      const url = await siteLink(env, baseUrl, lineUserId, 'pet');
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
      const foods = await listFoods(db, ownerId);
      if (foods.some((food) => food.displayName === intent.name)) {
        await replyOrPushFlex(env, event, doneCard(pet?.petName || '貓貓'), `「${intent.name}」已經建立過了，直接記錄就可以。`);
        return;
      }
      const info = await createGuidedFood(db, ownerId, intent.foodType, intent.name, intent.kcalPerGram);
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
        pet = await createPet(db, ownerId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      await handleRecord(env, event, pet, intent.record, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
      return;
    }

    case 'multiRecord': {
      if (!pet) {
        pet = await createPet(db, ownerId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      const lines = [];
      let lastSummary = null;
      let lastDate = '';
      for (const rec of intent.records) {
        const res = await handleRecord(env, event, pet, rec, ownerId, { silent: true, actorId: lineUserId, caregiverName });
        if (res?.mainText) lines.push(res.mainText);
        if (res?.summary) { lastSummary = res.summary; lastDate = res.eventDate; }
      }
      if (!lines.length) { await guideUnknown(env, event, pet?.petId || ''); return; }
      const fallback = `已記錄 ${lines.length} 筆：\n${lines.map((line) => `· ${line}`).join('\n')}`;
      const multiSiteUrl = await siteLink(env, baseUrl, lineUserId);
      await replyOrPushFlex(env, event, multiRecordFlex(pet, lines, lastSummary, lastDate, multiSiteUrl), fallback);
      return;
    }

    case 'query': {
      await handleQuery(env, event, user, pet, intent.query, baseUrl, lineUserId, ownerId);
      return;
    }

    case 'fixLast': {
      await handleFixLast(env, event, ownerId, intent, lineUserId);
      return;
    }

    case 'fixMatch': {
      await handleFixMatch(env, event, pet, intent, lineUserId);
      return;
    }

    case 'deleteLast': {
      await handleDeleteLast(env, event, ownerId, lineUserId);
      return;
    }

    case 'recordPrompt': {
      const k = intent.kind;
      // 喝水：點了直接打數字就好
      if (k === 'water') {
        await updateUser(db, lineUserId, { pendingAction: 'amount|水' });
        await replyOrPush(env, event, '喝了多少 ml？直接打數字，例如 20\n\n💡 熟了更快：下次直接打「水 20」就記好，不用先點。');
        return;
      }
      // 吃飯：列出自己建好的品項，點一下就直接記那個食物（免再打類型）
      if (k === 'food') {
        const foods = await listFoods(db, ownerId);
        if (foods.length) {
          const cells = foods.slice(0, 8).map((food) => {
            const sub = Number(food.kcalPerGram) > 0 ? `每克 ${food.kcalPerGram} kcal` : '點一下記錄';
            return menuCell(String(food.displayName).slice(0, 12), sub, `記 ${food.displayName}`, false, '', `action=pickFood&foodId=${food.foodId}`);
          });
          const rows = [];
          for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
          rows.push([menuCell('建新的品項', '常吃的先建檔', '設定食物')]);
          await replyOrPushFlex(env, event, onboardCard({
            title: '想記哪一個品項？',
            subtitle: '點品項，再打幾克就好',
            rows,
            hint: '💡 熟了更快：直接打「罐頭 皇家 30」不用先點',
            alt: '想記哪一個品項？'
          }), recordPrompt('food'));
          return;
        }
        await updateUser(db, lineUserId, { pendingAction: 'amount|罐頭' });
        await replyOrPush(env, event, '吃了幾克？直接打數字，例如 30\n（先當罐頭記，之後可在照護站改）\n\n💡 熟了更快：直接打「罐頭 品名 30」。');
        return;
      }
      // 用藥：給快捷鈕，免打字
      if (k === 'med') {
        await replyOrPushFlex(env, event, onboardCard({
          title: '這次的藥？',
          subtitle: '點一下就記好',
          rows: [
            [menuCell('早・已吃', '', '藥 早 已吃'), menuCell('晚・已吃', '', '藥 晚 已吃')],
            [menuCell('中午・已吃', '', '藥 中午 已吃'), menuCell('未餵', '', '藥 未餵')]
          ],
          hint: '💡 熟了更快：直接打「藥 早 已吃」',
          alt: '這次的藥？'
        }), '記餵藥：藥 早 已吃 / 藥 晚 已吃 / 藥 未餵');
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
      await replyOrPush(env, event, '要修正紀錄：\n改 54（改最後一筆）\n改 皇家罐頭 24（指定品名改）\n剩 20（沒吃完扣掉）\n刪除（整筆刪掉）');
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
      // 看不懂不當死路：教打字 ＋ 這隻貓的一鍵捷徑，順手就能記
      await guideUnknown(env, event, pet?.petId || '');
    }
  }
}

// 食物顯示：品名已含類型（如「希爾斯罐頭」）就不再前綴類型，避免「罐頭 希爾斯罐頭」重複
// 一鍵捷徑的食物指令：品名若已含類型就去掉重複的類型字（「乾糧 希爾斯 5」而非「乾糧 希爾斯乾糧 5」），
// 但保留類型前綴讓 parser 仍能解析比對到品項。
export function foodShortcutCmd(foodType, itemName, amt) {
  let name = String(itemName || '');
  if (foodType && name.includes(foodType)) name = name.split(foodType).join('').trim();
  return `${foodType}${name ? ` ${name}` : ''} ${amt}`;
}
export function foodLabel(foodType, itemName) {
  const t = String(foodType || '').trim();
  const n = String(itemName || '').trim();
  if (!n) return t;
  if (!t) return n;
  return n.includes(t) ? n : `${t} ${n}`;
}

// 沒指定早/晚時，依「這筆的時間」自動歸到最接近的餵藥時段（早≈8、中午≈13、晚≈20 點）。
// 使用者有明講時段就不呼叫這個（明確優先）；沒設定餵藥時段則回空字串。
export function autoMedSlot(pet, eventDateTime) {
  let slots = [];
  try { slots = JSON.parse(pet?.goalMedSlots || '[]'); } catch (error) { slots = []; }
  slots = Array.isArray(slots) ? slots.filter(Boolean) : [];
  if (!slots.length) return '';
  const hour = Number(String(eventDateTime).slice(11, 13));
  const h = Number.isFinite(hour) ? hour : 12;
  const rep = { 早: 8, 中午: 13, 中: 13, 晚: 20 };
  let best = slots[0], bestDiff = Infinity;
  for (const s of slots) {
    const diff = Math.abs((rep[s] ?? 12) - h);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// 上一筆的簡短描述（修正/刪除回覆用）
function describeLog(log) {
  if (log.category === 'water') return `水 ${log.amount} ml`;
  if (log.category === 'food') return `${foodLabel(log.foodType, log.itemName)} ${log.amount} g`;
  if (log.category === 'med') {
    const label = [log.medSlot, log.itemName].filter(Boolean).join(' ');
    return `藥${label ? ` ${label}` : ''} ${log.medStatus}`;
  }
  const names = { vomit: '嘔吐', stool: '便便', mood: '精神', note: '備註', urine: '尿尿', supplement: '營養補充', vaccine: '疫苗', deworm: '除蟲' };
  return `${names[log.category] || log.category}${log.note ? `：${log.note}` : ''}`;
}

// 「改 54」「剩 20」：修正最近一筆的數量
async function handleFixLast(env, event, lineUserId, intent, actorId = lineUserId) {
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

  const updated = await updateLog(db, last.logId, fields, actorId);
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

// 「改 皇家罐頭 24」：找最近一筆符合品名/類型的食物，改它的克數（連帶重算熱量/含水）
async function handleFixMatch(env, event, pet, intent, actorId) {
  const db = env.DB;
  if (!pet) { await replyOrPush(env, event, '找不到可以修改的紀錄，\n先記一筆吧！'); return; }
  const q = intent.query;
  const recent = (await getRecentLogsByPet(db, pet.petId, 30)) || [];
  const foods = recent.filter((l) => l.category === 'food' && !l.isDeleted);
  // 先比品名，再比類型；取最近一筆
  let match = foods.find((l) => l.itemName && (l.itemName.includes(q) || q.includes(l.itemName)));
  if (!match) match = foods.find((l) => l.foodType && (l.foodType.includes(q) || q.includes(l.foodType)));
  if (!match) {
    await replyOrPush(env, event, `找不到「${q}」的食物紀錄可以改。\n・想改最後一筆：直接打「改 ${intent.amount}」\n・或到照護站點那筆改`);
    return;
  }
  const food = match.foodId ? await getFood(db, match.foodId) : null;
  const derived = deriveFoodFields(intent.amount, match.foodType, food);
  const updated = await updateLog(db, match.logId, { amount: intent.amount, kcal: derived.kcal, waterMl: derived.waterMl }, actorId);
  const eventDate = String(updated.eventDateTime).slice(0, 10);
  const summary = await recomputeDay(db, updated.petId, eventDate);
  const cardPet = await getPet(db, updated.petId);
  const subParts = [];
  if (updated.kcal) subParts.push(`${updated.kcal} kcal`);
  if (updated.waterMl) subParts.push(`含水 ${updated.waterMl} ml`);
  const card = recordFlex({
    pet: cardPet, categoryKey: updated.foodType === '乾糧' ? 'dry' : 'wet',
    mainText: describeLog(updated), subText: subParts.join('・'),
    summary, date: eventDate, logId: updated.logId,
    title: `✓ 已更新・${cardPet?.petName || '貓貓'}`
  });
  await replyOrPushFlex(env, event, card, recordReply(describeLog(updated), cardPet, summary, [], eventDate));
}

// 「刪除」：刪掉最近一筆
async function handleDeleteLast(env, event, lineUserId, actorId = lineUserId) {
  const db = env.DB;
  const last = await getLastLogByUser(db, lineUserId);
  if (!last) {
    await replyOrPush(env, event, '沒有可以刪除的紀錄');
    return;
  }
  await softDeleteLog(db, last.logId, actorId);
  const summary = await recomputeDay(db, last.petId, String(last.eventDateTime).slice(0, 10));
  await replyOrPush(env, event, `🗑 已刪除上一筆\n${describeLog(last)}\n\n今日水分 ${summary.totalWaterMl} ml\n熱量 ${summary.kcal} kcal`);
}

// 照護站連結（卡片「開啟照護站」按鈕、圖文選單用）：
// 有設 LIFF 就用永不過期的 LIFF 連結——在 LINE 內點開直接以 LINE 身分自動登入；
// 沒設 LIFF 才退回「烤入本人登入 token」的舊連結。
// suffix 深連結：LIFF 用 ?go=…，token 連結用 &go=…（接在 #token= 後面）
function liffLink(env, go = '') {
  if (!env.LIFF_ID) return '';
  return `https://liff.line.me/${env.LIFF_ID}${go ? `?go=${go}` : ''}`;
}
async function siteLink(env, baseUrl, lineUserId, go = '') {
  const liffUrl = liffLink(env, go);
  if (liffUrl) return liffUrl;
  if (!baseUrl || !lineUserId) return '';
  try {
    const token = await createSession(env.DB, lineUserId);
    return `${baseUrl}/#token=${token}${go ? `&go=${go}` : ''}`;
  } catch (error) { console.error('siteLink failed:', error.message); return ''; }
}

async function handleRecord(env, event, pet, record, lineUserId, opts = {}) {
  const db = env.DB;
  const hints = [];
  let noKcal = false; // 食物「完全沒有熱量可算」（零食/其他且沒設公式）→ 確認卡提示未計入
  let estimated = false; // 食物熱量用「類型預設」估算（品項還沒設精確每克熱量）→ 確認卡標「估算」＋提醒可設定
  let estKcalPerG = 0;

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
    recordedBy: opts.actorId || lineUserId,
    caregiverName: opts.caregiverName || '',
    isBackfilled: (record.dayOffset || record.time) ? 1 : 0,
    source: 'line',
    updatedBy: opts.actorId || lineUserId
  };

  let description = '';

  if (record.category === 'water') {
    log.waterMl = record.amount;
    description = `水 ${record.amount} ml`;
  } else if (record.category === 'food') {
    const foods = await listFoods(db, lineUserId);
    let matched = matchFood(foods, record.itemName, record.foodType);
    const sameType = foods.filter((food) => !food.isDeleted && food.foodType === record.foodType);
    // 沒寫品名時，若該類型只建了一種品項就自動套用（例如乾糧只有一種 → 直接用它的公式）
    if (!matched && !record.itemName && sameType.length === 1) matched = sameType[0];
    // 一則多筆（silent）沒辦法互動確認 → 用保守模糊比對自動對應最接近的同類型品項，
    // 避免「皇冠 27 水 15」這種批次輸入安靜記成 0 熱量（卡片仍會顯示對應到的品名可核對）。
    if (!matched && opts.silent && sameType.length >= 1) matched = guessFood(sameType, record.itemName, record.foodType);
    // ②③ 打了品名卻對不到、但這個類型有可選品項 → 先停下來問是哪一個，別默默記成 0 熱量。
    //     forceRaw＝使用者已在確認卡按「就先記著不算熱量」；silent＝一則多筆，不做互動式確認。
    if (!matched && !record.forceRaw && !opts.silent && sameType.length >= 1) {
      const guess = guessFood(sameType, record.itemName, record.foodType);
      await replyOrPushFlex(env, event, foodDisambigFlex({
        pet, foodType: record.foodType, typedName: record.itemName || record.foodType,
        grams: Number(record.amount) || 0, options: sameType, guessId: guess?.foodId || ''
      }), `「${record.itemName || record.foodType}」對不到已建立的品項，請選正確的${record.foodType}，熱量才算得到。`);
      return { disambiguated: true };
    }
    if (matched) {
      log.foodId = matched.foodId;
      log.itemName = matched.displayName;
      const derived = deriveFoodFields(record.amount, record.foodType, matched);
      log.kcal = derived.kcal;
      log.waterMl = derived.waterMl;
      description = `${foodLabel(record.foodType, matched.displayName)} ${record.amount} g`;
      // 品項有對到、但還沒填精確每克熱量 → 用類型預設估算，畫面標「估算」＋提醒可設定
      if (derived.estimated) { estimated = true; estKcalPerG = derived.estKcalPerG; }
      else if (!(derived.kcal > 0)) noKcal = true; // 零食/其他這種沒有預設值的才維持「未計入」
    } else {
      const derived = deriveFoodFields(record.amount, record.foodType, null);
      log.kcal = derived.kcal; // 用類型預設估算（不再留 0，畫面標「估算」）
      log.waterMl = derived.waterMl;
      description = `${foodLabel(record.foodType, record.itemName)} ${record.amount} g`;
      if (derived.estimated) { estimated = true; estKcalPerG = derived.estKcalPerG; }
      else noKcal = true;
    }
  } else if (record.category === 'med') {
    // 沒帶早/晚 → 依這筆的時間自動歸到最接近的餵藥時段（有講就聽使用者的）
    if (!log.medSlot && log.medStatus) {
      const auto = autoMedSlot(pet, eventDateTime);
      if (auto) log.medSlot = auto;
    }
    const label = [log.medSlot, record.itemName].filter(Boolean).join(' ');
    description = `藥${label ? ` ${label}` : ''} ${record.medStatus}`;
  } else if (record.category === 'vomit') {
    description = `嘔吐${record.note ? `：${record.note}` : ''}`;
    if (!record.note) hints.push('補一句吐了什麼更好給醫生看，\n例：「嘔吐 乾乾吃太快」\n會自動整理進回顧的注意事項。');
  } else if (record.category === 'stool') {
    description = `便便${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'urine') {
    description = `尿尿${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'supplement') {
    description = `營養補充${record.itemName ? `：${record.itemName}` : ''}`;
  } else if (record.category === 'mood') {
    description = `精神${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'vaccine') {
    description = `疫苗${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'deworm') {
    description = `除蟲${record.note ? `：${record.note}` : ''}`;
  } else if (record.category === 'weight') {
    description = `體重 ${record.amount} kg`;
    // 記一筆有日期的體重（趨勢用），同時把「目前體重」更新成最新值
    try { await updatePetFields(db, pet.petId, { weightKg: record.amount }); } catch (error) { console.warn('sync weightKg failed:', error.message); }
  } else {
    description = `備註：${record.note}`;
  }

  // 罐頭另外加水：主文字標注，並在下方另計一筆喝水，讓當天總水分正確
  const addedWaterMl = record.category === 'food' ? Number(record.addedWaterMl) || 0 : 0;
  if (addedWaterMl > 0) description += `（另加水 ${addedWaterMl} ml）`;

  const mainText = description;
  const subParts = [];
  if (log.kcal) subParts.push(`${estimated ? '≈' : ''}${log.kcal} kcal`);
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
      recordedBy: opts.actorId || lineUserId,
      caregiverName: opts.caregiverName || '',
      isBackfilled: log.isBackfilled,
      source: 'line',
      updatedBy: opts.actorId || lineUserId
    });
  }
  const eventDate = eventDateTime.slice(0, 10);
  const summary = await recomputeDay(db, pet.petId, eventDate);
  await track(db, lineUserId, 'record', { c: record.category, src: 'line' });

  // 共同照護·即時通知：只要「共同照護者」記錄，飼主本人就即時收到每一筆；
  // 共同照護者自己不會被即時通知（他們只收每日總結）。背景 try/catch，不影響記錄與回覆。
  // 通知卡附「刪除這筆／開照護站修改」：飼主看到記錯當場就能處理（刪除會先跳確認）
  const notifyActorId = opts.actorId || lineUserId; // lineUserId 為飼主本人（資料擁有者）
  if (notifyActorId && notifyActorId !== lineUserId) {
    try {
      const who = opts.caregiverName || '共同照護者';
      const notifySiteUrl = await siteLink(env, opts.baseUrl, lineUserId);
      await pushMessages(env, lineUserId, [careNotifyFlex(who, pet.petName, description, savedLog.logId, notifySiteUrl, summary)]);
    } catch (error) {
      console.error('care notify failed:', error.message);
      try { await pushText(env, lineUserId, `📝 ${opts.caregiverName || '共同照護者'} 記錄了 ${pet.petName}：${description}`); } catch (e2) { /* ignore */ }
    }
  }

  const categoryKey = record.category === 'food'
    ? (record.foodType === '乾糧' ? 'dry' : 'wet')
    : record.category;

  const fixName = record.category === 'food' ? (log.itemName || record.foodType || '罐頭') : '';
  let tip = record.category === 'water'
    ? '記錯？直接打「改 25」改這筆'
    : record.category === 'food'
      ? `記錯？打「改 25」或「改 ${fixName} 25」・沒吃完「剩 20」`
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
  // 一則多筆時：不各自回覆，交由呼叫端彙整成一張卡
  if (opts.silent) {
    return { mainText, summary, eventDate, savedLog };
  }
  // 單筆記錄：一律回完整卡片（不再忽大忽小分級）。純文字為 LINE 通知/無法顯示卡片時的備援。
  const fallbackText = recordReply(description, pet, summary, hints, eventDate);
  const card = recordFlex({
    pet, categoryKey, mainText,
    subText: subParts.join('・'),
    summary, date: eventDate,
    logId: savedLog?.logId || '',
    hints, tip, siteUrl: await siteLink(env, opts.baseUrl, lineUserId),
    warnNoKcal: record.category === 'food' && noKcal, foodType: record.foodType || '',
    estimated: record.category === 'food' && estimated, estKcalPerG
  });
  await replyOrPushFlex(env, event, card, fallbackText);
  // 記錄是每天最高頻的互動：順手把專屬圖文選單保持在最新版（版本相符時只是一次快取讀取，不重建）
  if (opts.baseUrl) {
    try { await ensurePersonalRichMenu(env, opts.baseUrl, lineUserId); } catch (error) { console.error('personal richmenu refresh failed:', error.message); }
  }
  return { mainText, summary, eventDate, savedLog };
}

// 每位使用者專屬的圖文選單：把本人登入連結烤進「喵喵照護站／回診資訊」，
// 之後點一下就直接進自己的照護站、免打字免跳卡片。第一次登入時在背景建立，
// 建好就存進 app_kv 快取；只有連結失效才重建。全程 try/catch，不影響任何回覆。
// 選單設計版本：改了選單圖片或區塊配置就把這個數字 +1，
// 現有使用者的快取版本不符就會強制重建，改版才推得到所有人。
// v6：更新選單圖（更深色版，使用者指定）。按鈕送出詞與標籤維持一致。
const RICHMENU_VERSION = 7;

async function ensurePersonalRichMenu(env, baseUrl, lineUserId) {
  const db = env.DB;
  const kvKey = `menu:${lineUserId}`;
  const cached = await appKvGet(db, kvKey);
  if (cached) {
    try {
      const { menuId, token, v } = JSON.parse(cached);
      // 版本相符 + 連結還有效才略過重建（getSessionUser 會順便延長效期）
      if (v === RICHMENU_VERSION && menuId && token && (await getSessionUser(db, token))) return;
    } catch { /* 快取壞掉就當作沒有，往下重建 */ }
  }

  const accessToken = await getAccessToken(env);
  const token = await createSession(db, lineUserId);
  // 有 LIFF 用永不過期的 LIFF 連結（點開自動登入）；沒有才烤 token 連結
  const site = liffLink(env) || `${baseUrl}/#token=${token}`;
  const trendSite = liffLink(env, 'trend') || `${baseUrl}/#token=${token}&go=trend`;
  const W = 2500, H = 1686, colW = Math.round(W / 3), rowH = H / 2;
  const cell = (c, r, action) => ({ bounds: { x: c * colW, y: r * rowH, width: c === 2 ? W - 2 * colW : colW, height: rowH }, action });
  const send = (text) => ({ type: 'message', text });
  const menu = {
    size: { width: W, height: H }, selected: true, name: `owner-${lineUserId.slice(-8)}`, chatBarText: '選單',
    // v4 重排：上排＝每天要做的（留對話），下排＝查看與前往
    // 送出的字＝選單標籤（自動回覆一致）：記一筆／今日記錄／給醫生看／怎麼記
    areas: [
      cell(0, 0, send('記一筆')),                  // 記一筆 → 快速記錄選單
      cell(1, 0, send('今日記錄')),                // 今日記錄 → 今天總結
      cell(2, 0, send('給醫生看')),                // 給醫生看 → 回診重點
      cell(0, 1, { type: 'uri', uri: site }),      // 喵喵照護站（網站）
      cell(1, 1, send('怎麼記')),                  // 說明／怎麼記 → 可點範例卡
      cell(2, 1, { type: 'uri', uri: trendSite })  // 記錄回顧（網站，近 30 天）
    ]
  };
  const lineApi = async (url, options) => {
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) } });
    const body = await res.text();
    if (!res.ok) throw new Error(`${url} → ${res.status}: ${body}`);
    return body ? JSON.parse(body) : {};
  };
  const created = await lineApi('https://api.line.me/v2/bot/richmenu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(menu)
  });
  const menuId = created.richMenuId;
  const imgRes = await env.ASSETS.fetch(new Request(new URL('/richmenu.png', baseUrl)));
  const imgBytes = await imgRes.arrayBuffer();
  await lineApi(`https://api-data.line.me/v2/bot/richmenu/${menuId}/content`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: imgBytes
  });
  await lineApi(`https://api.line.me/v2/bot/user/${lineUserId}/richmenu/${menuId}`, { method: 'POST' });

  // 清掉這位使用者的舊專屬選單，避免堆積
  if (cached) {
    try { const old = JSON.parse(cached).menuId; if (old && old !== menuId) await lineApi(`https://api.line.me/v2/bot/richmenu/${old}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  await appKvSet(db, kvKey, JSON.stringify({ menuId, token, v: RICHMENU_VERSION }));
}

async function handleQuery(env, event, user, pet, query, baseUrl, lineUserId, ownerId = lineUserId) {
  const db = env.DB;
  const today = taipeiToday();

  if (query === 'website') {
    const url = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, websiteFlex(url), websiteReply(url));
    // 回覆送出後，背景幫這位使用者把登入烤進專屬選單（失敗也不影響上面的回覆）
    try { await ensurePersonalRichMenu(env, baseUrl, lineUserId); } catch (error) { console.error('personal richmenu failed:', error.message); }
    return;
  }

  if (query === 'help') {
    await replyOrPushFlex(env, event, menuFlex(), helpText());
    return;
  }

  if (query === 'recordMenu') {
    await track(db, lineUserId, 'menu_record');
    // 「快速記錄」：先教最快的打字（和「如何記錄」一致），再給這隻貓的一鍵捷徑；點一下就記好
    const petId = pet?.petId || '';
    const shortcuts = await quickShortcuts(db, petId);
    const beginner = await isBeginner(db, petId);
    // 捷徑永遠在前（老手肌肉記憶）；教學鈕只在新手期出現，之後自動收起
    const items = [...shortcuts, ...(beginner ? [TEACH_BTN] : []), qrPost('其他狀況（吐/便…）', 'action=recmore', '其他狀況')];
    const text = beginner
      ? '記錄超快，兩種都行 👇\n\n'
        + '① 直接打字（最快）：\n　水 20・罐頭 30・藥 早 已吃\n　一次多筆：水20 乾糧5 藥早已吃\n\n'
        + '② 或點下面你常記的，一下就好：'
      : '點你常記的，一下就好 👇\n（也可直接打字：水 20・罐頭 30・藥 早 已吃）';
    await replyOrPushQuick(env, event, text, items);
    return;
  }

  if (query === 'recordButtons') {
    await replyOrPushFlex(env, event, recordMenuFlex(), recordPrompt(''));
    return;
  }

  if (query === 'backfill') {
    await replyOrPush(env, event, backfillGuide());
    return;
  }

  if (query === 'onboarding') {
    await track(db, lineUserId, 'onboarding_view');
    await replyOrPushFlex(env, event, onboardingCarousel(pet?.petName || ''), onboardingText());
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
    const siteUrl = await siteLink(env, baseUrl, lineUserId);
    const card = todayFlex({ pet, date: today, summary, dateLabel: shortDate(today), siteUrl });
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
    const calendarUrl = await siteLink(env, baseUrl, lineUserId, 'calendar');
    await replyOrPushFlex(env, event, monthFlex(pet.petName, month, rows, today, calendarUrl), monthReply(pet.petName, monthLabel, rows));
    return;
  }

  if (query === 'recent') {
    // 多撈一些，濾掉「罐頭加水」那種伴隨紀錄後，仍能湊滿約 10 筆
    const raw = await getRecentLogsByPet(db, pet.petId, 20);
    const logs = raw.filter((log) => !(log.category === 'water' && String(log.note || '') === '罐頭加水')).slice(0, 10);
    if (!logs.length) {
      await replyOrPush(env, event, `${pet.petName} 還沒有任何紀錄。\n打「水 60」或「罐頭 皇家 30g」開始記錄吧！`);
      return;
    }
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const items = logs.map((log) => {
      const dt = String(log.eventDateTime);
      const wd = WD[new Date(`${dt.slice(0, 10)}T00:00:00`).getDay()] || '';
      const dateLabel = `${Number(dt.slice(5, 7))}/${Number(dt.slice(8, 10))}（${wd}）`;
      let title = describeLog(log);
      let sub = '';
      if (log.category === 'food') {
        title = `${log.foodType}${log.itemName ? ` ${log.itemName}` : ''} ${log.amount}g`;
        const parts = [];
        if (Number(log.kcal) > 0) parts.push(`${log.kcal} kcal`);
        if (String(log.note || '').includes('加水')) parts.push(String(log.note).replace('另', ''));
        sub = parts.join('・');
      } else if (log.category === 'water') {
        title = `喝水 ${log.amount} ml`;
      }
      return { logId: log.logId, dateLabel, time: dt.slice(11, 16), title, sub, editable: log.category === 'water' || log.category === 'food' };
    });
    const fallback = items.map((i) => `${i.dateLabel} ${i.time} ${i.title}${i.sub ? `（${i.sub}）` : ''}`).join('\n');
    await replyOrPushFlex(env, event, recentFlex(pet.petName, items), `最近紀錄：\n${fallback}`);
    return;
  }

  if (query === 'visit') {
    const visits = await upcomingVisits(db, pet.petId, today);
    const vets = await listVetsByOwner(db, ownerId);
    const vetsById = Object.fromEntries(vets.map((vet) => [vet.vetId, vet]));
    const rows = await getRecentSummaries(db, pet.petId, today, 7);
    const visitUrl = await siteLink(env, baseUrl, lineUserId, 'trend');
    const infoText = `${visitReply(pet.petName, visits, vetsById)}\n\n給醫生看的完整整理（可複製）：\n${visitUrl}`;
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

  // 「所見即可打」救援：所有指令都沒中時，最後用食物清單比對「名字＋數量」，
  // 讓使用者照卡片顯示的品名（例如「皇家罐頭 27」，不是「罐頭 皇家」）也能記進去。
  const foodGuess = text.match(/^(.{2,20}?)\s+(\d+(?:\.\d+)?)\s*(?:g|克|公克)?$/);
  if (foodGuess) {
    const name = foodGuess[1].trim();
    const amount = Number(foodGuess[2]);
    if (name && amount > 0) {
      const foods = await listFoods(db, ownerId);
      const food = matchFood(foods, name, '');
      if (food) {
        await handleRecord(env, event, pet, {
          category: 'food', foodType: food.foodType, itemName: food.displayName,
          amount, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '', dayOffset: 0, time: ''
        }, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
        return;
      }
    }
  }

  await guideUnknown(env, event, pet?.petId || '');
}
