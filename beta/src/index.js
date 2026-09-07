import { publicReport, purgeReports } from './report-sharing.js';
// 貓貓照護管家 Beta — Cloudflare Worker 入口
// /webhook  → LINE Messaging API webhook（驗簽後直接處理、直接 reply，不需早回 ack）
// /api/*    → 照護站 REST API
// 其餘路徑 → 照護站網站（public/ 靜態資源）

import { parseMessage, matchFood, guessFood, normalizeText, analyzeLeading, stripFoodTypeWords, isAskableFoodName } from './parser.js';
import { deriveFoodFields, isWetFoodType, isEstimableType, buildHandoff } from './summary.js';
import { handleApi } from './api.js';
import { verifyLineSignature, replyOrPush, replyOrPushQuick, replyOrPushFlex, replyMessages, pushText, pushMessages, getProfile, getAccessToken, checkAccessToken, showLoadingAnimation } from './line.js';
import { hasAnyReminder, parseReminderSettings, buildReminderLines, reminderMessage, visitReminderMessage } from './reminders.js';
import { shortDate } from './replies.js';
import { reportChoiceFlex, recordFlex, recordFlexCompact, foodDisambigFlex, multiRecordFlex, undoConfirmFlex, todayFlex, handoffFlex, websiteFlex, menuFlex, recordMenuFlex, recordTutorialFlex, quickRecordCarousel, weekFlex, monthFlex, recentFlex, reminderFlex, visitReminderFlex, welcomeFlex, onboardCard, onboardingCarousel, menuCell, exampleCard, petDataFlex, deletedCard, confirmDeleteFlex, careNotifyFlex, careInviteFlex, weightModifyConfirmFlex, weightNoRecordFlex, weightAddedFlex, weightModifiedFlex, foodTimelineFlex, foodEditMenuFlex, foodBrandPickFlex, reviewMenuFlex } from './flex.js';
import { isBetaAllowed, normalizeCode, gateText } from './plan.js';
import {
  ensureUser, updateUser, getUser, listPets, createPet, resolveDefaultPet, getPet, updatePetFields, createFoodItem, createMedItem,
  listFoods, getFood, insertLog, getLog, getLastLogByUser, softDeleteLog, updateLog,
  getFoodHistory, getFoodTimeline, resolveDefaultFood,
  resolveFoodAlias, setFoodAlias, ALIAS_FOODTYPES,
  getLatestWeightLog, resyncPetWeight,
  recomputeDay, getRecentSummaries,
  upcomingVisits, listVetsByOwner, createSession,
  appKvGet, appKvSet, claimMessageOnce, purgeOldSeenMessages, saveReportShot, getReportShot, purgeOldShots, getDataExport, purgeOldExports, getSessionUser, track, healFoodKcal,
  resolveDataOwner, createCareInvite, redeemCareInvite, listCareMembers, listCareCircle,
  createLoginCode, redeemLoginCode, rateLimited
} from './db.js';
import {
  recordReply, lightRecordReply, todayReply, handoffReply, weekReply, monthReply, visitReply,
  websiteReply, helpText, welcomeText, unknownReply, invalidReply,
  recordTutorial, medTutorial, onboardingText, recordPrompt, backfillGuide
} from './replies.js';
import { getRecentLogsByPet, ensureTaskSchema, getLogsForDay, logTextInput } from './db.js';
import { jsonResponse, taipeiToday, taipeiNowDateTime, addDays, formatWeightKg, weightEquals, shotExpired, constantTimeEqual, newToken } from './util.js';

// 官方 LINE 加好友連結（basicId @232mjffx）——給共同照護邀請用
const LINE_ADD_URL = 'https://line.me/R/ti/p/@232mjffx';

// 管理員驗證：優先 cookie session（/admin/login 換發，金鑰不再掛網址），否則沿用 ?key=（constant-time 比對）。
// 回 { ok, viaCookie }。ADMIN_KEY 少於 8 碼一律拒絕（等於沒設好就不開後台）。
async function adminAuth(env, request, url) {
  const key = String(env.ADMIN_KEY || '');
  if (key.length < 8) return { ok: false, viaCookie: false };
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)adm=([A-Za-z0-9]+)/);
  if (m) {
    try {
      const raw = await appKvGet(env.DB, `adminsess:${m[1]}`);
      if (raw) { const s = JSON.parse(raw); if (s && String(s.expiresAt) > new Date().toISOString()) return { ok: true, viaCookie: true }; }
    } catch (error) { /* 壞值視為未登入 */ }
  }
  const qk = url.searchParams.get('key');
  if (qk != null && constantTimeEqual(qk, key)) return { ok: true, viaCookie: false };
  return { ok: false, viaCookie: false };
}
// 由 ?key= 進來且尚無 cookie → 發一張 8 小時 cookie，之後導覽不必再帶 key（HttpOnly/Secure/SameSite）。
async function issueAdminCookieIfNeeded(env, auth) {
  if (!auth.ok || auth.viaCookie) return null;
  const token = newToken();
  try { await appKvSet(env.DB, `adminsess:${token}`, JSON.stringify({ expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() })); } catch (error) { return null; }
  return `adm=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800`;
}

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
    if (url.pathname.startsWith('/r/')) return publicReport(request,env,url);
    // 確保 tasks 表與 logs.sourceTaskId 已存在（冪等、每 isolate 一次），再進任何會寫 logs 的路徑
    await ensureTaskSchema(env.DB);

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
        // 防暴力猜碼：同一 IP 每 10 分鐘最多 10 次嘗試（正常人一次就過）
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        if (await rateLimited(env.DB, `login:${ip}`, 10, 600)) {
          return jsonResponse({ ok: false, message: '嘗試太多次，請稍後再試。' }, 429);
        }
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
      // 6 小時失效：即使 cron 尚未實體清除，過期就不再供圖（回 410 Gone）
      if (shotExpired(row.createdAt)) return new Response('gone', { status: 410 });
      try {
        const bin = Uint8Array.from(atob(row.png), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600', 'x-robots-tag': 'noindex' } });
      } catch (error) {
        return new Response('bad image', { status: 404 });
      }
    }
    // 資料匯出 CSV：長亂數能力憑證網址（GET 直接下載，LINE 內建瀏覽器也能存）。
    if (url.pathname.startsWith('/export/') && request.method === 'GET') {
      const id = url.pathname.slice('/export/'.length);
      const row = await getDataExport(env.DB, id);
      if (!row || row.csv === undefined || row.csv === null) return new Response('not found', { status: 404 });
      const filename = String(row.filename || 'export.csv');
      return new Response(row.csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'cache-control': 'private, no-store',
          'x-robots-tag': 'noindex'
        }
      });
    }
    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: 'cat-care-beta', now: new Date().toISOString() });
    }
    // 管理員登入：用 ?key= 換一張 cookie session 後導回後台（金鑰只在這一次的網址出現，之後靠 cookie）
    if (url.pathname === '/admin/login') {
      const key = String(env.ADMIN_KEY || '');
      const qk = url.searchParams.get('key');
      if (key.length < 8 || qk == null || !constantTimeEqual(qk, key)) {
        return new Response('403 Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      const cookie = await issueAdminCookieIfNeeded(env, { ok: true, viaCookie: false });
      return new Response(null, { status: 302, headers: { location: '/admin/testers', ...(cookie ? { 'set-cookie': cookie } : {}) } });
    }
    // 權杖健康檢查（不外洩權杖本身），用 ADMIN_KEY／cookie session 保護（不可用測試者也有的邀請碼）
    if (url.pathname === '/admin/line-token') {
      if (!(await adminAuth(env, request, url)).ok) {
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
      if (!(await adminAuth(env, request, url)).ok) return jsonResponse({ ok: false }, 403);
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
      const auth = await adminAuth(env, request, url);
      if (!auth.ok) {
        return new Response('403 Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      // 由 ?key= 進來時順手發一張 cookie，之後所有導覽／切換連結都不必再帶金鑰
      const setCookie = await issueAdminCookieIfNeeded(env, auth);
      const db = env.DB;
      // 切換某人存取權 → 改完導回名單（用 302，避免重新整理又觸發一次）；連結不帶金鑰，靠 cookie
      const toggleUser = url.searchParams.get('user');
      if (toggleUser) {
        const access = url.searchParams.get('access') === '1' ? 1 : 0;
        try { await updateUser(db, toggleUser, { betaAccess: access }); } catch (error) { /* 找不到就當沒事 */ }
        return new Response(null, { status: 302, headers: { location: '/admin/testers', ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
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
        // 依「實際使用情況」自動分類：活躍使用者／用過但沉寂／只加入還沒用
        const classify = (r) => {
          const recs = Number(r.recs) || 0;
          if (recs === 0) return { key: 'joined', label: '只加入・還沒用', cls: 'b-joined' };
          if (r.lastDay && r.lastDay >= d7) return { key: 'active', label: '使用者・活躍', cls: 'b-active' };
          return { key: 'dormant', label: '用過・近期沒動', cls: 'b-dormant' };
        };
        const joinedCount = rows.filter((r) => Number(r.recs) === 0).length;
        const stat = (n, label) => `<div class="stat"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;
        // 只留 4 個最重要的數字，其餘（開通數、回訪）收成一行小字
        const statsBar = `<div class="stats">
          ${stat(rows.length, '總人數')}
          ${stat(activeCount, '活躍使用者')}
          ${stat(joinedCount, '只加入沒用')}
          ${stat(totalRecords, '總筆數')}
        </div>
        <div class="mini">已開通 ${onCount} · 回訪 ≥2天 ${retained2d} · ≥7天 ${retained7d}</div>`;
        const cardHtml = (r) => {
          const on = Number(r.betaAccess) === 1;
          const label = esc(r.displayName) || mask(r.lineUserId);
          const href = `/admin/testers?user=${encodeURIComponent(r.lineUserId)}&access=${on ? 0 : 1}`;
          const confirmMsg = `確定要${on ? '關閉' : '開通'}「${label}」嗎？`;
          return `<div class="row${on ? '' : ' off'}">
            <div class="info">
              <div class="name">${esc(r.displayName) || '（未命名）'}</div>
              <div class="meta">${r.pets ? '🐈 ' + esc(r.pets) + ' · ' : ''}${Number(r.recs) || 0} 筆 · ${esc(r.lastDay) || '—'}</div>
            </div>
            <a class="btn ${on ? 'btn-off' : 'btn-on'}" href="${href}" onclick="return confirm('${confirmMsg}')">${on ? '關閉' : '開通'}</a>
          </div>`;
        };
        const groups = { active: [], dormant: [], joined: [] };
        rows.forEach((r) => { groups[classify(r).key].push(cardHtml(r)); });
        const section = (title, arr) => arr.length ? `<div class="sec-title">${title}（${arr.length}）</div>${arr.join('')}` : '';
        const cards = section('🟢 使用者・活躍（近 7 天有記錄）', groups.active)
          + section('🟡 用過・近期沒動', groups.dormant)
          + section('⚪ 只加入・還沒用', groups.joined);

        // ---- 功能使用量測 ----
        // 最常記什麼：記錄類別分佈（含 LINE 與網站）
        const catRes = await db.prepare(
          `SELECT category, COUNT(*) c FROM logs WHERE isDeleted = 0 AND source IN ('line','web') GROUP BY category ORDER BY c DESC`
        ).all();
        const CAT_LABEL = { water: '喝水', food: '吃飯', med: '用藥', vomit: '嘔吐', stool: '大便', urine: '尿尿', supplement: '營養補充', mood: '精神', weight: '體重', note: '備註' };
        const catMax = Math.max(1, ...(catRes.results || []).map((r) => Number(r.c)));
        const ubar = (label, val, max) => `<div class="ubar"><span class="ul">${esc(label)}</span><span class="ut"><span class="uf" style="width:${Math.round((val / max) * 100)}%"></span></span><span class="uv">${val}</span></div>`;
        const catBar = (catRes.results || []).filter((r) => r.category).map((r) => ubar(CAT_LABEL[r.category] || r.category, Number(r.c), catMax)).join('') || '<div class="mini">還沒有紀錄</div>';
        // 功能開啟次數（events）
        let evRows = [];
        try { evRows = (await db.prepare('SELECT event, COUNT(*) c FROM events GROUP BY event').all()).results || []; } catch (e) { /* 尚無 events 表 */ }
        const EV_LABEL = { website_open: '開網站', review_open: '看回顧', calendar_open: '看月曆', report_save: '存給醫生的圖', export: '匯出資料', care_open: '開共同照護', onboarding_view: '看上手教學', menu_record: '用選單記錄' };
        const evMap = new Map(evRows.map((r) => [r.event, Number(r.c)]));
        const evMax = Math.max(1, ...Object.keys(EV_LABEL).map((k) => evMap.get(k) || 0));
        const evBar = Object.entries(EV_LABEL).filter(([k]) => evMap.get(k)).sort((a, b) => (evMap.get(b[0]) || 0) - (evMap.get(a[0]) || 0)).map(([k, lb]) => ubar(lb, evMap.get(k) || 0, evMax)).join('') || '<div class="mini">還沒有資料</div>';
        // 共同照護
        const careRes = await db.prepare("SELECT ownerLineUserId, COUNT(*) c FROM care_members WHERE status = 'accepted' GROUP BY ownerLineUserId").all();
        const careOwners = new Map((careRes.results || []).map((r) => [r.ownerLineUserId, Number(r.c)]));
        const memberTotal = [...careOwners.values()].reduce((a, b) => a + b, 0);
        const inviteCreated = evMap.get('invite_created') || 0;
        const petOwners = rows.filter((r) => r.pets);
        const helperOwners = petOwners.filter((r) => careOwners.has(r.lineUserId));
        const soloOwners = petOwners.filter((r) => !careOwners.has(r.lineUserId));
        const avgDays = (arr) => arr.length ? (arr.reduce((t, r) => t + (Number(r.days) || 0), 0) / arr.length) : 0;
        const usageSections = `
          <div class="sec-title">最常記什麼</div>
          <div class="ucard">${catBar}</div>
          <div class="sec-title">功能使用次數</div>
          <div class="ucard">${evBar}</div>
          <div class="sec-title">共同照護</div>
          <div class="stats" style="margin-bottom:8px">
            ${stat(inviteCreated, '產生邀請碼')}
            ${stat(memberTotal, '加入的幫手')}
            ${stat(helperOwners.length, '有幫手家庭')}
          </div>
          <div class="mini">有幫手家庭平均記錄 ${avgDays(helperOwners).toFixed(1)} 天　·　單獨顧 ${avgDays(soloOwners).toFixed(1)} 天</div>`;
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
  .tag{font-size:10px;font-weight:600;padding:1px 7px;border-radius:999px;margin-left:6px;white-space:nowrap;vertical-align:middle}
  .b-active{background:#e5efe2;color:#3f7a3a}
  .b-dormant{background:#fbf0d8;color:#9a6a1e}
  .b-joined{background:#eee;color:#8a8a82}
  .btn{display:inline-block;font-size:13px;font-weight:600;padding:7px 16px;border-radius:999px;text-decoration:none;-webkit-tap-highlight-color:transparent}
  .btn-off{background:#fdecec;color:#c0392b;border:1px solid #f2c9c4}
  .btn-on{background:#734921;color:#fff}
  .empty{color:#6b6e63;font-size:14px;text-align:center;padding:40px 0}
  .foot{font-size:11.5px;color:#9a9d90;margin-top:16px;line-height:1.7}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px}
  .stat{background:#fff;border:1px solid #e2e0d6;border-radius:12px;padding:11px 6px;text-align:center;box-shadow:0 4px 12px rgba(115,73,33,.05)}
  .stat-n{font-size:21px;font-weight:700;color:#734921;line-height:1.1}
  .stat-l{font-size:11px;color:#6b6e63;margin-top:3px}
  .mini{font-size:11.5px;color:#9a9d90;text-align:center;margin-bottom:18px}
  .sec-title{font-size:13px;font-weight:700;color:#734921;margin:18px 2px 9px}
  .ucard{background:#fff;border:1px solid #e2e0d6;border-radius:14px;padding:12px 14px;box-shadow:0 4px 12px rgba(115,73,33,.05)}
  .ubar{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:13px}
  .ubar .ul{flex:0 0 82px;color:#3a3d34}
  .ubar .ut{flex:1;height:8px;background:#f0ece2;border-radius:999px;overflow:hidden}
  .ubar .uf{display:block;height:100%;background:linear-gradient(90deg,#b98a4e,#734921);border-radius:999px}
  .ubar .uv{flex:0 0 auto;font-weight:700;color:#734921;min-width:30px;text-align:right}
  @media(max-width:420px){.stats{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
  <h1>🐾 測試者管理</h1>
  <div class="sub">留存數據、功能使用、共同照護一頁看完。下方可開通／關閉。只動存取權，看不到任何健康紀錄內容。</div>
  ${statsBar}
  ${usageSections}
  <div class="sec-title">測試者名單</div>
  ${cards || '<div class="empty">還沒有任何使用者</div>'}
  <div class="foot">此頁僅供管理員，請勿外流。停用後對方在 LINE 會被擋在門檻外、看不到任何內容，但資料保留；重新「開通」即可恢復。</div>
</body></html>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
      } catch (error) {
        return new Response('error: ' + error.message, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
    // 照護站不進搜尋引擎：靠 index.html 的 <meta name="robots"> 與 /robots.txt（靜態資源由平台直接回應，Worker 不介入）
    return env.ASSETS.fetch(request);
  },

  // 每晚 21:00（台北）：先主動確認/換新 LINE 權杖，再檢查照護提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeReports(env.DB));
    ctx.waitUntil(
      getAccessToken(env).catch((error) => console.error('cron token warm-up failed:', error.message))
    );
    // 清掉 2 天前的訊息冪等紀錄，避免 app_kv 無限成長
    ctx.waitUntil(purgeOldSeenMessages(env.DB, `${addDays(taipeiToday(), -2)}T00:00:00.000Z`));
    // 清掉 1 天前的報告截圖暫存（存圖是即時用途，不需長期保留）
    ctx.waitUntil(purgeOldShots(env.DB, `${addDays(taipeiToday(), -1)}T00:00:00.000Z`));
    // 清掉 1 天前的匯出 CSV 暫存（下載完即可清）
    ctx.waitUntil(purgeOldExports(env.DB, `${addDays(taipeiToday(), -1)}T00:00:00.000Z`));
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
      // 事件級去重：LINE 重送（含按鈕 postback）帶同一個 webhookEventId，原子認領確保每個事件只處理一次，
      // 避免重送把「按按鈕」重播成好幾次、或回覆兩次。
      if (event.webhookEventId && !(await claimMessageOnce(env.DB, `evt:${event.webhookEventId}`))) continue;
      if (event.type === 'follow') {
        await handleFollow(event, env);
      } else if (event.type === 'message' && event.message?.type === 'text') {
        // 同實例再加一層記憶體快速擋（同一批次內重複）
        if (isDuplicateMessage(event.message.id)) continue;
        // 「管家處理中…」動態點點（免費、不算訊息、僅 1:1 有效）：先亮再處理，回覆一到就消失
        if (event.source?.type === 'user') await showLoadingAnimation(env, event.source.userId);
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
function weightOnboardCard(petName, step = '') {
  return onboardCard({
    step,
    title: `${petName}現在幾公斤？`,
    subtitle: '直接打數字，例如 4.2（之後隨時能再量再記）',
    alt: `${petName}現在幾公斤？`
  });
}

function stepFoodCard(step = '', subtitle = '建了記錄就自動算熱量（乾乾、罐罐都可）') {
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
      [menuCell('怎麼記？看範例', '想打字更快看這', '怎麼記'), menuCell('今日記錄', '今天記了什麼', '今天')],
      [menuCell('補充貓咪資料', '晶片・疾病・疫苗', '補資料'), menuCell('開啟管家後台', '回診・回顧・設定', '照護站')]
    ],
    hint: '晶片、疾病、疫苗、醫院醫生等詳細資料，點「補充貓咪資料」直接到設定頁填',
    alt: '都準備好了！'
  });
}

// P0-1：新增貓咪只要名字就完成，立刻可記錄。體重／生日／食物等改為選填、之後在照護站補（不阻塞）。
export function petAddedCard(petName) {
  return onboardCard({
    title: `${petName}加入完成 🐱`,
    subtitle: `現在就可以用了！直接打一句話試試看：\n乾乾5　·　喝水30　·　嘔吐 白沫`,
    rows: [
      [menuCell('用按鈕記也可以', '不想打字就點這', '紀錄', true)],
      [menuCell('讓紀錄更準', '想更準可補常吃食物與熱量（選填）', '補資料')]
    ],
    hint: '沒設定也能一直用；體重、生日、常吃食物、目標都可以之後在管家後台補。',
    alt: `${petName}加入完成，直接打「乾乾5」就能記`
  });
}

export function namePromptCard() {
  return onboardCard({
    title: '貓貓叫什麼名字？',
    subtitle: '打名字送出就好——之後就能直接記錄，其他資料都能晚點再補',
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
        ? `${foodType}・含水 ${waterPct}%\n還沒填每克熱量，記錄時會先用「${foodType}」類型預設估算（畫面標 ≈）。到管家後台「設定→常吃的食物」填精確每克熱量，就會變精確值、並自動補算過去的估算。`
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
        rows: [[menuCell('安心上手', '上手小教學', '安心上手'), menuCell('開啟管家後台', '看看長什麼樣子', '照護站')]]
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
    // P0-1：只要名字就完成，立刻可記錄；體重／食物不再阻塞，之後可到照護站補
    await clear();
    await replyOrPushFlex(env, event, petAddedCard(newPet.petName), `${newPet.petName}加入完成，現在就可以開始記錄！之後想補體重、生日或常吃食物，打「補資料」或開管家後台即可。`);
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
    await replyOrPushFlex(env, event, stepFoodCard('', `已記下 ${pet.petName} ${m[1]} kg！最常吃哪一種？建好記錄就自動算熱量和水分（也可先跳過，直接開始記）`), `已記下體重 ${m[1]} kg。接下來可建常吃的食物：輸入「設定罐頭」「設定乾糧」，或直接開始記錄`);
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
      subtitle: age ? `生日先記為 ${value}，管家後台可調整` : value,
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
  // 體重「改重量／再修改」：等待輸入新公斤數 → 覆寫最近那筆體重的 amount，保留原日期、resync 目前體重
  if (pending.startsWith('editWeight|')) {
    const logId = pending.slice(11);
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:kg|公斤)?$/i);
    if (!m) { await clear(); return false; }
    await clear();
    const newAmount = Number(m[1]);
    // 沿用 applyWeightModify（含相同值護欄）：相同值不更新、不動 updatedAt，只回讀
    const res = await applyWeightModify(db, { logId, amount: newAmount, ownerId, actorId: lineUserId });
    if (!res.ok) { await replyOrPush(env, event, res.reason === 'bad_amount' ? '體重數字看起來怪怪的，請重新輸入一次。' : '找不到那筆體重紀錄了。'); return true; }
    if (res.unchanged) { await replyOrPush(env, event, `這筆體重已經是 ${formatWeightKg(res.newKg)}kg。`); return true; }
    const cardPet = await getPet(db, res.log.petId);
    const site = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event,
      weightModifiedFlex({ pet: cardPet, oldKg: res.oldKg, newKg: res.newKg, recordDate: res.log.eventDateTime, logId: res.log.logId, siteUrl: site }),
      `已修改${cardPet?.petName || '貓貓'}最近一次體重 ${formatWeightKg(res.oldKg)} → ${formatWeightKg(res.newKg)} kg`);
    return true;
  }

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
    const { updated, summary } = await applyLogAmountEdit(db, log, Number(m[1]), lineUserId);
    const eventDate = String(updated.eventDateTime).slice(0, 10);
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

  // 泡水歧義選了「加水」→ 保留加水量、再追問食物克數（amountFoodAw|類型|加水量）
  if (pending.startsWith('amountFoodAw|')) {
    const [, foodType, awRaw] = pending.split('|');
    const aw = Number(awRaw) || 0;
    const m = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|克|公克)?$/i);
    if (!m) {
      if (/^\s*[0-9]/.test(text)) { await replyOrPush(env, event, '直接打幾克就好，例如 30。'); return true; }
      await clear();
      return false;
    }
    await clear();
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return true; }
    await handleRecord(env, event, pet, {
      category: 'food', foodType, itemName: '',
      amount: Number(m[1]), unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: ''
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

// 撤銷用的 ids 視為不可信輸入：只收 uuid 格式、去重。接受字串或陣列。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 內嵌 postback 的 id 上限（配合 LINE 約 300 byte）；smid token 取回時的理智上限（不截斷真實操作）
const MAX_INLINE_UNDO_IDS = 6;
const MAX_TOKEN_UNDO_IDS = 50;
export function parseUndoIds(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const ids = arr.map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(ids)].filter((id) => UUID_RE.test(id));
}

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
// 多貓且此人「還沒明確選過要記哪一隻」時＝true：記錄前先問，避免默默記到第一隻（尤其是剛加入的共同照護者）
function needsCatPick(user, pets) {
  return pets.length >= 2 && !(user?.defaultPetId && pets.some((p) => p.petId === user.defaultPetId));
}
async function askWhichCat(env, event, pets) {
  const items = pets.slice(0, 12).map((p) => qrMsg(p.petName, p.petName));
  const names = pets.map((p) => p.petName).filter(Boolean).join('、');
  await replyOrPushQuick(env, event,
    `這筆要記給哪隻貓？\n家裡有：${names}\n直接回覆名字就好，這筆就會記給牠 🐈`,
    items);
}

// 「等待選貓」的暫存紀錄（pendrec）在 pendingAction，格式：pendrec:<json{ r:已解析的 record, t:建立時間ms }>。
const PENDREC_TTL_MS = 15 * 60 * 1000;   // 15 分鐘逾時：夠久讓分心的人回來，又不會久到之後打貓名意外補寫舊紀錄
// 使用者回貓名時，若正在等「這筆記給哪隻貓？」→ 用選定的貓「重走既有 handleRecord」完成上一筆（不另做簡化寫入）。
// 回 true＝有 pendrec 且已處理（完成寫入，或因過期/壞值而作廢）；false＝沒有 pendrec，交回呼叫端做原本行為。
// 一律先清掉 pending（避免掛著、避免重複寫入）；過期/壞值不補寫。
async function tryCompletePendingRecord(env, event, { db, user, pet, lineUserId, ownerId, caregiverName, baseUrl }) {
  const pending = String(user.pendingAction || '');
  if (!pending.startsWith('pendrec:')) return false;
  await updateUser(db, lineUserId, { pendingAction: '' });
  let data = null;
  try { data = JSON.parse(pending.slice('pendrec:'.length)); } catch (error) { data = null; }
  // 過期/壞值：已清 pending、不補寫；回 false → 呼叫端就當一般「切換貓」處理（不會靜默、也不會誤寫舊紀錄）
  if (!data || !data.r || (Date.now() - Number(data.t || 0)) > PENDREC_TTL_MS) return false;
  const recRes = await handleRecord(env, event, pet, data.r, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
  const recSavedId = recRes?.savedLog?.logId || '';
  const recAllIds = [recRes?.savedLog?.logId, recRes?.addedWaterLog?.logId].filter(Boolean);
  await logTextInput(db, {
    lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
    parseStatus: recSavedId ? 'record' : (recRes?.disambiguated ? 'awaiting_food_selection' : 'record'),
    failReason: recRes?.disambiguated ? 'need_food_selection' : '',
    sourceMessageId: String(event.message?.id || ''), resolvedPetId: pet.petId, linkedLogId: recSavedId,
    parsedResult: JSON.stringify({ events: [{ category: data.r.category, amount: data.r.amount, unit: data.r.unit, itemName: data.r.itemName, addedWaterMl: data.r.addedWaterMl || 0 }], savedLogIds: recAllIds, unparsedSegments: [], awaitingAction: recRes?.disambiguated ? 'food_selection' : '' })
  });
  return true;
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
export async function guideUnknown(env, event, petId) {
  const items = [
    ...await quickShortcuts(env.DB, petId),
    TEACH_BTN,
    qrPost('其他狀況（吐/便…）', 'action=recmore', '其他狀況')
  ];
  await replyOrPushQuick(env, event,
    '我還沒聽懂這句 🙏\n'
    + '可以試著這樣說：\n'
    + '乾乾5、喝水30、嘔吐 白沫、最近吃什麼\n'
    + '（不用學格式，照平常講話就好）\n\n'
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
  food: { prompt: '吃哪一種？', items: () => [qrPost('罐頭', 'action=rec2&t=罐頭', '罐頭'), qrPost('主食罐', 'action=rec2&t=主食罐', '主食罐'), qrPost('副食罐', 'action=rec2&t=副食罐', '副食罐'), qrPost('乾糧', 'action=rec2&t=乾糧', '乾糧'), qrPost('濕食', 'action=rec2&t=濕食', '濕食'), qrPost('生食', 'action=rec2&t=生食', '生食'), qrPost('零食', 'action=rec2&t=零食', '零食')] },
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

  // 一鍵把今日交班推播給所有共照夥伴（LINE 不能轉傳 Flex，改由機器人主動推）
  if (action === 'handoffShare') {
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '找不到貓咪資料，請先建立檔案。'); return; }
    const today = taipeiToday();
    const logs = await getLogsForDay(db, pet.petId, today);
    const data = buildHandoff(pet, logs);
    const dateLabel = shortDate(today);
    const circle = await listCareCircle(db, pet.ownerLineUserId); // [飼主, ...已加入夥伴]
    const recipients = circle.filter((id) => id && id !== lineUserId); // 除了自己
    if (!recipients.length) {
      await replyOrPush(env, event, '目前還沒有共照夥伴。到「設定 → 邀請夥伴」把家人或幫手加進來，就能一鍵傳給大家。');
      return;
    }
    const card = handoffFlex(pet, dateLabel, data);
    let ok = 0;
    for (const rid of recipients) {
      try { await pushMessages(env, rid, [card]); ok += 1; } catch (error) { /* 個別失敗略過 */ }
    }
    await track(db, lineUserId, 'handoff_share', String(ok));
    await replyOrPush(env, event, ok ? `已把今日交班傳給 ${ok} 位照護夥伴。` : '這次沒有傳成功，請稍後再試一次。');
    return;
  }

  // 其他狀況（較少記的）：點分類 → 常用描述，兩層即可
  if (action === 'recmore') {
    await replyOrPushQuick(env, event, '其他狀況？點一個分類 👇', symptomCategoryQuick());
    return;
  }
  // 教打字：熟了直接打指令最快
  if (action === 'howtype') {
    await track(db, lineUserId, 'howtype');
    await replyOrPushQuick(env, event,
      '不用學格式，照平常說就好 👇（「克」可省略、空格隨意）\n\n'
      + '· 吃飯 → 打「主食3」「乾乾10」\n'
      + '· 喝水 → 打「喝水30」\n'
      + '· 狀況 → 打「嘔吐 白沫」\n'
      + '· 沒吃完 → 打「乾乾減5」「罐罐剩10」\n'
      + '· 回頭查 → 打「今天吃多少」「最近吃什麼」',
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
    const g = Number(data.get('g')) || 0;
    const aw = Number(data.get('aw')) || 0;      // 保留過品牌選擇的額外加水量
    const smid = data.get('smid') || '';          // 文字澄清／延後確認帶來的原訊息 id
    const pid = data.get('pid') || '';            // 多筆待確認時綁定「這一筆」
    // pid 路徑（多筆待確認佇列）：只動被點的那一筆，狀態機防重複／防動到別筆／防跨家庭
    if (smid && pid) {
      await confirmPendingFood(env, event, db, {
        pet, smid, pid, ownerId, lineUserId, caregiverName, baseUrl,
        foodRecord: { category: 'food', foodType: food.foodType, itemName: food.displayName, amount: g, unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: '' },
        eventDesc: { category: 'food', foodType: food.foodType, itemName: food.displayName, amount: g, addedWaterMl: aw }
      });
      return;
    }
    // legacy（單筆澄清、item_lookup 單句、快速紀錄）：無 pid，沿用冪等＋priorIds 判斷
    if (smid && await smidHasFoodLog(db, smid, ownerId, { foodId, grams: g })) {
      await replyOrPush(env, event, '這筆已經記過了 👌');
      return;
    }
    const priorIds = smid ? await smidPriorSavedIds(db, smid, ownerId) : [];
    const isMultiFlow = priorIds.length > 0;
    const res = await handleRecord(env, event, pet, {
      category: 'food', foodType: food.foodType, itemName: food.displayName,
      amount: g, unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: ''
    }, ownerId, { fromButton: true, silent: isMultiFlow, actorId: lineUserId, caregiverName, baseUrl, sourceMessageId: smid });
    if (smid) {
      const sid = res?.savedLog?.logId || '';
      const allIds = [...new Set([...priorIds, res?.savedLog?.logId, res?.addedWaterLog?.logId].filter(Boolean))];
      await logTextInput(db, { lineUserId, ownerId, petId: pet.petId, rawText: '', parseStatus: 'record', failReason: '', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: sid, parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: food.foodType, itemName: food.displayName, amount: g, addedWaterMl: aw }], savedLogIds: allIds, unparsedSegments: [], awaitingAction: '' }) });
      if (isMultiFlow) await sendSmidSummaryCard(env, event, db, pet, smid, ownerId, baseUrl, lineUserId);
    }
    return;
  }
  // ② 確認卡按「就先記著，不算熱量」→ 照打的品名如實記下（forceRaw 跳過再次確認），確認卡會標紅提醒
  if (action === 'recFoodRaw') {
    const t = data.get('t') || '罐頭';
    const g = Number(data.get('g')) || 0;
    const name = data.get('name') || '';
    const aw = Number(data.get('aw')) || 0;
    const smid = data.get('smid') || '';
    const pid = data.get('pid') || '';
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    // pid 路徑（多筆待確認）：只記類型（forceRaw）並標這一筆 confirmed
    if (smid && pid) {
      await confirmPendingFood(env, event, db, {
        pet, smid, pid, ownerId, lineUserId, caregiverName, baseUrl,
        foodRecord: { category: 'food', foodType: t, itemName: name, amount: g, unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: '', forceRaw: true },
        eventDesc: { category: 'food', foodType: t, itemName: name, amount: g, addedWaterMl: aw }
      });
      return;
    }
    // legacy 無 pid：冪等＋priorIds
    if (smid && await smidHasFoodLog(db, smid, ownerId, { grams: g, foodType: t, itemName: name })) {
      await replyOrPush(env, event, '這筆已經記過了 👌');
      return;
    }
    const priorIds = smid ? await smidPriorSavedIds(db, smid, ownerId) : [];
    const isMultiFlow = priorIds.length > 0;
    const res = await handleRecord(env, event, pet, {
      category: 'food', foodType: t, itemName: name,
      amount: g, unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: '', forceRaw: true
    }, ownerId, { fromButton: true, silent: isMultiFlow, actorId: lineUserId, caregiverName, baseUrl, sourceMessageId: smid });
    if (smid) {
      const sid = res?.savedLog?.logId || '';
      const allIds = [...new Set([...priorIds, res?.savedLog?.logId, res?.addedWaterLog?.logId].filter(Boolean))];
      await logTextInput(db, { lineUserId, ownerId, petId: pet.petId, rawText: '', parseStatus: 'record', failReason: '', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: sid, parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: t, itemName: name, amount: g, addedWaterMl: aw }], savedLogIds: allIds, unparsedSegments: [], awaitingAction: '' }) });
      if (isMultiFlow) await sendSmidSummaryCard(env, event, db, pet, smid, ownerId, baseUrl, lineUserId);
    }
    return;
  }

  // 不明句首澄清：使用者選了要記哪隻貓 → 用 postback 帶回來的事件文字寫入，保留原事件、不用重打。
  // 事件文字來自「已解析可成立」的後段，這裡再 parse 一次落地；選貓＝確認，選貓前正式 logs 為 0 筆。
  if (action === 'pickcatFor') {
    const petId = data.get('petId') || '';
    const ev = data.get('ev') || '';
    const pets = await listPets(db, ownerId);
    const chosen = pets.find((p) => p.petId === petId);
    if (!chosen) { await replyOrPush(env, event, '找不到這隻貓，請重新輸入一次。'); return; }
    const smid = data.get('smid') || '';
    const sub = parseMessage(ev);
    const recs = sub.type === 'multiRecord' ? sub.records : (sub.type === 'record' ? [sub.record] : []);
    // 反查候選（無類別詞的品名＋份量，如「皇家 33」）也要帶進來，選完貓才不會遺失食物
    let candidates = Array.isArray(sub.candidates) ? sub.candidates : [];
    if (sub.type === 'item_lookup_candidate') candidates = [{ itemName: sub.itemName, amount: sub.amount, addedWaterMl: sub.addedWaterMl || 0 }];
    const unparsed = Array.isArray(sub.unparsed) ? sub.unparsed : [];
    if (!recs.length && !candidates.length) { await replyOrPush(env, event, '這筆我沒抓到內容，請重新輸入一次。'); return; }
    const user = await getUser(db, lineUserId);
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    // 多筆／需品項確認／有看不懂片段 → 與正常多筆完全相同的機制（deferDisambig＋partial 確認卡＋advancePending），
    // 保留同一 smid，杜絕「先選貓就遺失食物」，且食物需確認時走局部確認卡、全部確認後才宣告完成。
    if (recs.length > 1 || candidates.length || unparsed.length) {
      await recordMultiForPet(env, event, db, {
        pet: chosen, records: recs, candidates, unparsed, smid, rawText: ev,
        ownerId, lineUserId, caregiverName, baseUrl
      });
      return;
    }
    // 單筆乾淨紀錄（旺財類真雜字＋單一事件）→ 沿用原本行為：handleRecord 直接渲染紀錄卡
    const savedIds = [];
    for (const rec of recs) {
      const res = await handleRecord(env, event, chosen, rec, ownerId, { silent: false, actorId: lineUserId, caregiverName, baseUrl });
      if (res?.savedLog?.logId) savedIds.push(res.savedLog.logId);
      if (res?.addedWaterLog?.logId) savedIds.push(res.addedWaterLog.logId);
    }
    // awaiting_pet_selection 完成 → 補一列最終 record（帶原 sourceMessageId），最新狀態反映成功
    await logTextInput(db, { lineUserId, ownerId, petId: chosen.petId, rawText: ev, parseStatus: 'record', failReason: '', sourceMessageId: smid, resolvedPetId: chosen.petId, linkedLogId: savedIds.join(','), parsedResult: JSON.stringify({ events: recs.map((r) => ({ category: r.category, amount: r.amount, unit: r.unit, itemName: r.itemName, addedWaterMl: r.addedWaterMl || 0 })), savedLogIds: savedIds, unparsedSegments: [], awaitingAction: '' }) });
    return;
  }

  // ── 體重修改流程（postback）───────────────────────────────────────
  // 多貓且沒指定貓 → 先選貓，再進修改確認
  if (action === 'weightPick') {
    const petId = data.get('petId') || '';
    const amount = Number(data.get('amt')) || 0;
    const smid = data.get('smid') || '';
    const pets = await listPets(db, ownerId);
    const chosen = pets.find((p) => p.petId === petId);
    if (!chosen) { await replyOrPush(env, event, '找不到這隻貓，請重新輸入一次。'); return; }
    await showWeightModifyConfirm(env, event, { db, pet: chosen, amount, smid });
    return;
  }
  // 確認「改成 Xkg」：改最近一筆體重 log 的 amount、保留原日期；冪等（同值重點＝不建新 log，只覆寫）
  if (action === 'wMod') {
    const res = await applyWeightModify(db, { logId: data.get('logId') || '', amount: Number(data.get('amt')) || 0, ownerId, actorId: lineUserId });
    if (!res.ok) {
      await replyOrPush(env, event, res.reason === 'bad_amount' ? '體重數字看起來怪怪的，請重新輸入一次。' : '找不到可以修改的體重紀錄了，可能已被刪除。');
      return;
    }
    // 重複點同一張確認卡、資料已是該值 → 不再更新、不動 updatedAt，只回讀（冪等）
    if (res.unchanged) {
      await replyOrPush(env, event, `這筆體重已經是 ${formatWeightKg(res.newKg)}kg。`);
      return;
    }
    // 規格五：補記修改結果（沿用同一 sourceMessageId 串起 raw→結果）
    await logTextInput(db, {
      lineUserId, ownerId, petId: res.log.petId, rawText: '', parseStatus: 'weight_modified', failReason: '',
      sourceMessageId: data.get('smid') || '', resolvedPetId: res.log.petId, linkedLogId: res.log.logId,
      parsedResult: JSON.stringify({ events: [{ category: 'weight', op: 'modify', from: res.oldKg, to: res.newKg, recordDate: String(res.log.eventDateTime).slice(0, 10) }], savedLogIds: [res.log.logId], unparsedSegments: [], awaitingAction: '' })
    });
    const cardPet = await getPet(db, res.log.petId);
    const site = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event,
      weightModifiedFlex({ pet: cardPet, oldKg: res.oldKg, newKg: res.newKg, recordDate: res.log.eventDateTime, logId: res.log.logId, siteUrl: site }),
      `已修改${cardPet?.petName || '貓貓'}最近一次體重 ${formatWeightKg(res.oldKg)} → ${formatWeightKg(res.newKg)} kg（紀錄日期 ${String(res.log.eventDateTime).slice(0, 10)}）`);
    return;
  }
  // 確認「記為今天的新體重」：新增一筆 today weight log；冪等（同一原訊息 smid 已建過就不重複）
  if (action === 'wAdd') {
    const amount = Number(data.get('amt')) || 0;
    const petId = data.get('petId') || '';
    const smid = data.get('smid') || '';
    const pets = await listPets(db, ownerId);
    const chosen = pets.find((p) => p.petId === petId) || await resolveDefaultPet(db, await getUser(db, lineUserId), pets);
    if (!chosen) { await replyOrPush(env, event, '找不到貓咪資料。'); return; }
    const res = await applyWeightAddToday(db, { petId: chosen.petId, amount, smid, ownerId, actorId: lineUserId });
    if (!res.ok) {
      await replyOrPush(env, event, res.reason === 'dup' ? '這筆體重已經記好了 👌' : '體重數字看起來怪怪的，請重新輸入一次。');
      return;
    }
    // 規格五：補記「記為今天新體重」結果
    await logTextInput(db, {
      lineUserId, ownerId, petId: chosen.petId, rawText: '', parseStatus: 'weight_added', failReason: '',
      sourceMessageId: smid, resolvedPetId: chosen.petId, linkedLogId: res.saved.logId,
      parsedResult: JSON.stringify({ events: [{ category: 'weight', op: 'add_today', amount }], savedLogIds: [res.saved.logId], unparsedSegments: [], awaitingAction: '' })
    });
    const site = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, weightAddedFlex({ pet: chosen, amount, logId: res.saved.logId, summary: res.summary, date: res.date, siteUrl: site }), `已記錄・${chosen.petName}\n體重 ${formatWeightKg(amount)} kg`);
    return;
  }
  if (action === 'wCancel') { await replyOrPush(env, event, '好，體重先不改也不記 👌'); return; }
  // 「改重量／再修改」：進入等待輸入新體重（沿用 pendingAction 機制）
  if (action === 'wEditAsk') {
    const logId = data.get('logId') || '';
    const log = await getLog(db, logId);
    if (!log || log.lineUserId !== ownerId || log.isDeleted || log.category !== 'weight') {
      await replyOrPush(env, event, '找不到那筆體重紀錄了。'); return;
    }
    await updateUser(db, lineUserId, { pendingAction: `editWeight|${logId}` });
    await replyOrPush(env, event, '要改成幾公斤？直接打數字就好（例如 4.2）');
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
        // 刪除最新體重 → 目前體重回退到上一筆未刪除體重（規格六）
        if (log.category === 'weight') await resyncPetWeight(db, log.petId);
      }
    } catch (error) {
      console.error('delLog failed:', error);
    }
    // 不論結果都回一張安心卡（避免使用者卡住沒反應）
    const url = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, deletedCard(url),
      '已刪除剛剛的資料囉。若要再調整，請開啟管家後台。');
  }

  // ↩️ 撤銷這次紀錄：以「這張結果卡建立的全部 log」為單位（含連動加水），二段式確認後才軟刪。
  // ids 不可信：collectUndoable 內已 parseUndoIds（驗格式/去重/限筆數）＋逐筆沿用既有權限。
  if (action === 'undoOp' || action === 'undoDo') {
    // 兩把鑰匙：smid（多筆用 token，不塞 UUID）優先；否則內嵌 ids（單筆/食物+加水，≤2）
    const smid = data.get('smid') || '';
    const items = smid
      ? await collectUndoableBySmid(db, smid, ownerId)
      : await collectUndoable(db, data.get('ids') || '', ownerId);
    if (!items.length) {
      // 已全部刪除後重複點擊：依「原本這次操作的筆數」回單/多筆訊息（savedLogIds 不隨軟刪消失）。
      const origN = smid ? (await savedLogIdsBySmid(db, smid, ownerId)).length : parseUndoIds(data.get('ids') || '').length;
      await replyOrPush(env, event, origN >= 2 ? '這次紀錄已經刪除了 👌' : '這筆紀錄已經刪除了 👌');
      return;
    }
    if (action === 'undoOp') {
      // 護欄一：先確認、不立即刪。undoDo 沿用同一把鑰匙（smid 優先，否則內嵌 ids），避免大量 UUID 塞爆 postback。
      const undoKey = smid ? `smid=${encodeURIComponent(smid)}` : `ids=${items.map((l) => l.logId).join(',')}`;
      const lineTexts = items.map((l) => describeLog(l));
      // 用 Flex 氣泡內建按鈕做二段確認（永遠可見），取代原本浮動易漏看的 quick reply → 使用者不用打字。
      const confirmPet = await getPet(db, items[0]?.petId || '');
      const multi = items.length >= 2;
      const fallback = `${multi ? `確定要刪除這次 ${items.length} 筆紀錄嗎？` : '確定要刪除這筆紀錄嗎？'}\n${lineTexts.map((t) => `· ${t}`).join('\n')}`;
      await replyOrPushFlex(env, event, undoConfirmFlex({ pet: confirmPet, lines: lineTexts, undoKey, count: items.length }), fallback);
      return;
    }
    const undone = await applyUndo(db, items, lineUserId); // 確認後才軟刪＋重算受影響貓/日期
    const doneHead = undone.length >= 2 ? `🗑 已刪除這次 ${undone.length} 筆紀錄：` : '🗑 已刪除這筆紀錄：';
    await replyOrPush(env, event, `${doneHead}\n${undone.map((l) => `· ${describeLog(l)}`).join('\n')}`);
    return;
  }
  if (action === 'undoCancel') { await replyOrPush(env, event, '好，這次紀錄先保留著 👌'); return; }
  // 品項確認卡「取消」：只取消被點的那一筆（pid）；已成功的水／其他片段保留，明確回讀讓使用者不用猜。
  if (action === 'foodCancel') {
    const smid = data.get('smid') || '';
    const pid = data.get('pid') || '';
    if (!smid || !pid) { await replyOrPush(env, event, '好，這筆先不記 👌'); return; } // legacy 無 pid（item_lookup／泡水取消）
    const pendings = await smidPendingFoods(db, smid, ownerId);
    const entry = pendings.find((p) => p.id === pid);
    // 狀態機：找不到（含跨家庭）／已 confirmed／已 cancelled → 不動作，回「已處理」
    if (!entry || entry.status !== 'pending') { await replyOrPush(env, event, '這筆已處理過了 👌'); return; }
    const kept = await logsForSmid(db, smid, ownerId);
    const petId = kept[0]?.petId || '';
    const newPendings = pendings.map((p) => (p.id === pid ? { ...p, status: 'cancelled' } : p));
    const stillActive = newPendings.some((p) => p.status === 'pending');
    // savedLogIds 不變（不撤已記錄的），pendingFoods 這一筆標 cancelled
    await logTextInput(db, { lineUserId, ownerId, petId, rawText: '', parseStatus: stillActive ? 'multi_partial' : 'record', failReason: '', sourceMessageId: smid, resolvedPetId: petId, linkedLogId: kept.map((l) => l.logId).join(','), parsedResult: JSON.stringify({ events: [], savedLogIds: kept.map((l) => l.logId), pendingFoods: newPendings, unparsedSegments: [], awaitingAction: stillActive ? 'food_selection' : '' }) });
    if (stillActive) {
      const user = await getUser(db, lineUserId);
      const pets = await listPets(db, ownerId);
      const pet = await resolveDefaultPet(db, user, pets);
      await advancePending(env, event, db, pet, smid, ownerId, baseUrl, lineUserId);
      return;
    }
    // 全數處理完、含這次取消 → 明確列出已記錄 ＋ 被取消未記錄的
    const cancelledItems = newPendings.filter((p) => p.status === 'cancelled');
    const cancelDesc = cancelledItems.map((p) => `${p.typedName || p.itemName || ''}${p.foodType || ''} ${p.grams}g`.replace(/\s+/g, ' ').trim()).join('、');
    const keptDesc = kept.map((l) => describeLog(l)).join('、');
    await replyOrPush(env, event, kept.length ? `本次已記錄 ${keptDesc}；${cancelDesc} 未記錄。` : `${cancelDesc} 未記錄。`);
    return;
  }

  // 泡水歧義二選一：A＝食物克數、B＝加水量（B 再追問克數）
  if (action === 'foodAmbigG' || action === 'foodAmbigW') {
    const t = data.get('t') || '罐頭';
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    if (action === 'foodAmbigG') {
      const g = Number(data.get('g')) || 0;
      await handleRecord(env, event, pet, { category: 'food', foodType: t, itemName: '', amount: g, unit: 'g', addedWaterMl: 0, medStatus: '', medSlot: '', note: '' }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    } else {
      const aw = Number(data.get('aw')) || 0;
      await updateUser(db, lineUserId, { pendingAction: `amountFoodAw|${t}|${aw}` });
      await replyOrPush(env, event, `好，先記加水 ${aw} ml。那${t}幾克呢？直接打數字就好`);
    }
    return;
  }

  // 「乾乾-N／主食-N」的短確認卡「不是」：不動任何紀錄，明確回讀讓使用者安心。
  if (action === 'adjustCancel') { await replyOrPush(env, event, '好，沒有改動任何紀錄 👌'); return; }

  // 食物時間軸「你是指哪一款？」選定某品項 → 顯示該品項的逐筆時間軸（唯讀；只查所選貓與該 foodId）。
  if (action === 'foodTimelinePick') {
    const foodId = data.get('foodId') || '';
    const petId = data.get('petId') || '';
    const days = Number(data.get('days')) || 0;
    const food = foodId ? await getFood(db, foodId) : null;
    if (!food || String(food.ownerLineUserId) !== String(ownerId)) { await replyOrPush(env, event, '找不到那個品項，可能已被刪除。'); return; }
    const pets = await listPets(db, ownerId);
    const pet = pets.find((p) => p.petId === petId) || (await resolveDefaultPet(db, await getUser(db, lineUserId), pets));
    if (!pet) { await replyOrPush(env, event, '找不到貓貓資料。'); return; }
    const rows = await getFoodTimeline(db, pet.petId, { sinceDays: days || null, foodId });
    await replyFoodTimeline(env, event, baseUrl, lineUserId, rows, { scope: days ? 'recent' : 'all', sinceDays: days || null, label: food.displayName, petName: pet.petName });
    return;
  }

  // ── 從「吃過的食物」時間軸選一筆 → 修改選單（§2/§3/§4）。每步都用 logId 重新驗證，不信任 postback。 ──
  // 改份量沿用 editAmount、刪除沿用 delAsk；改品牌為新流程 foodBrandAsk/foodBrandSet。
  if (action === 'foodEdit') {
    const log = await loadEditableFoodLog(db, data.get('logId') || '', ownerId);
    if (!log) { await replyOrPush(env, event, '找不到那筆紀錄了，可能已刪除或修改。'); return; }
    const url = await siteLink(env, baseUrl, lineUserId, 'eaten');
    const { name, whenLabel, eatenText } = await foodLogDisplay(db, log);
    await replyOrPushFlex(env, event, foodEditMenuFlex({ logId: log.logId, name, whenLabel, eatenText, siteUrl: url }),
      `要修改「${name}（${whenLabel}・${eatenText}）」的什麼？回覆「份量」「品牌」或「刪除」。`);
    return;
  }
  // 改品牌／品項：只列目前家庭「同 foodType」的既有 active 品項；不建立新品項、不改 food_items（§6）。
  if (action === 'foodBrandAsk') {
    const log = await loadEditableFoodLog(db, data.get('logId') || '', ownerId);
    if (!log) { await replyOrPush(env, event, '找不到那筆紀錄了，可能已刪除或修改。'); return; }
    const foods = (await listFoods(db, ownerId)).filter((f) => !f.isDeleted && f.foodType === log.foodType);
    const { name } = await foodLogDisplay(db, log);
    const url = await siteLink(env, baseUrl, lineUserId, 'settings');
    await replyOrPushFlex(env, event, foodBrandPickFlex({ logId: log.logId, foodType: log.foodType, currentName: name, foods, siteUrl: url }),
      foods.length ? `要把「${name}」改成哪一款？` : `還沒有建立${log.foodType}的品項，可到管家後台新增。`);
    return;
  }
  // 套用改品牌：重新驗證 log 與所選品項都屬本家庭且同類型 → 更新 foodId/itemName/kcal，重算當日（§9/§10）。
  if (action === 'foodBrandSet') {
    const log = await loadEditableFoodLog(db, data.get('logId') || '', ownerId);
    if (!log) { await replyOrPush(env, event, '找不到那筆紀錄了，可能已刪除或修改。'); return; }
    const food = await getFood(db, data.get('foodId') || '');
    if (!food || String(food.ownerLineUserId) !== String(ownerId) || food.isDeleted) { await replyOrPush(env, event, '找不到那個品項，可能已被刪除。'); return; }
    if (String(food.foodType) !== String(log.foodType)) { await replyOrPush(env, event, '品項類型和這筆不同，請改選同類型的品項。'); return; }
    const { updated, summary } = await applyFoodBrandChange(db, log, food, lineUserId); // 用該品牌實際每克熱量重算（§6/§9）
    const eventDate = String(updated.eventDateTime).slice(0, 10);
    const cardPet = await getPet(db, updated.petId);
    const subParts = [];
    if (updated.kcal) subParts.push(`${updated.kcal} kcal`);
    if (updated.waterMl) subParts.push(`含水 ${updated.waterMl} ml`);
    await replyOrPushFlex(env, event, recordFlex({
      pet: cardPet, categoryKey: isWetFoodType(updated.foodType) ? 'wet' : 'dry', mainText: describeLog(updated),
      subText: subParts.join('・'), summary, date: eventDate, logId: updated.logId, title: `✓ 已改品牌・${cardPet?.petName || '貓貓'}`
    }), recordReply(describeLog(updated), cardPet, summary, [], eventDate));
    return;
  }

  // ── 家裡習慣的叫法：第一次遇到未知口語（肉5）→ 選類型 → 問要不要記住（§六/§二十四）──
  if (action === 'aliasType') {
    const name = data.get('n') || '';
    const t = data.get('t') || '';
    const g = Number(data.get('g')) || 0;
    const aw = Number(data.get('aw')) || 0;
    if (!name || !ALIAS_FOODTYPES.includes(t)) { await replyOrPush(env, event, '好，先不記 👌'); return; }
    const enc = `n=${encodeURIComponent(name)}&t=${encodeURIComponent(t)}&g=${g}&aw=${aw}`;
    await replyOrPushQuick(env, event, `之後「${name}」都代表「${t}」嗎？`, [
      qrPost('記住這個叫法', `action=aliasSave&${enc}`, '記住這個叫法'),
      qrPost('這次而已', `action=aliasOnce&${enc}`, '這次而已')
    ]);
    return;
  }
  if (action === 'aliasSave' || action === 'aliasOnce') {
    const name = data.get('n') || '';
    const t = data.get('t') || '';
    const g = Number(data.get('g')) || 0;
    const aw = Number(data.get('aw')) || 0;
    if (!name || !ALIAS_FOODTYPES.includes(t) || !(g > 0)) { await replyOrPush(env, event, '好，先不記 👌'); return; }
    const user = await getUser(db, lineUserId);
    const pets = await listPets(db, ownerId);
    const pet = await resolveDefaultPet(db, user, pets);
    if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪。'); return; }
    const caregiverName = ownerId !== lineUserId ? String(user.displayName || '') : '';
    // 「記住」才寫入家庭別名（只存 app_kv，保留詞不寫）；兩者都照常記這一次（走 defaultFood/generic，§五A）。
    if (action === 'aliasSave' && isAskableFoodName(name)) {
      await setFoodAlias(db, ownerId, name, { targetType: 'foodType', value: t });
    }
    await handleRecord(env, event, pet, { category: 'food', foodType: t, itemName: '', amount: g, unit: 'g', addedWaterMl: aw, medStatus: '', medSlot: '', note: '' }, ownerId, { fromButton: true, actorId: lineUserId, caregiverName, baseUrl });
    if (action === 'aliasSave') {
      await replyOrPush(env, event, `👌 已記住：以後「${name}」就當作「${t}」。想改或移除可到管家後台的「家裡習慣的叫法」。`);
    }
    return;
  }
  if (action === 'aliasCancel') { await replyOrPush(env, event, '好，這筆先不記 👌'); return; }

  // P0-2：「改 品名 N」多餐符合時，使用者從確認卡選定要改哪一餐 → 改成 N。
  // mode=subtract 時（超口語「別名減N／別名-N」的確認）改為從實吃量扣掉 N，其餘一律預設改成 N。
  if (action === 'fixPick') {
    await ensureTaskSchema(db);
    const logId = data.get('logId') || '';
    const amt = Number(data.get('amt')) || 0;
    const modeParam = data.get('mode');
    const mode = (modeParam === 'subtract' || modeParam === 'leftover') ? modeParam : 'set';
    const log = logId ? await getLog(db, logId) : null;
    if (!log || log.isDeleted || log.lineUserId !== ownerId) { await replyOrPush(env, event, '找不到那筆紀錄，可能已被刪除或修改。'); return; }
    await applyAdjustToLog(env, event, db, log, { mode, amount: amt }, lineUserId);
    return;
  }
}

// 撤銷核心（可單測）：挑出「屬於這個家庭、還沒刪」的可撤銷筆。ids 不可信 → 先 parseUndoIds。
// 沿用既有權限：log.lineUserId === ownerId（owner 或已接受共照者解析到的家庭 owner）。
export async function collectUndoable(db, rawIds, ownerId, cap = MAX_INLINE_UNDO_IDS) {
  const items = [];
  for (const id of parseUndoIds(rawIds).slice(0, cap)) {
    const log = await getLog(db, id);
    if (log && log.lineUserId === ownerId && !log.isDeleted) items.push(log);
  }
  return items;
}
// smid token 撤銷：從 text_inputs 最新列取這次操作的全部 savedLogIds（不塞進 postback、不截斷真實操作）。
// 只認屬於這個家庭的列（ownerLineUserId / lineUserId）。
// 取這個 smid（家庭範圍）最新一列登記的 savedLogIds 原始清單——不論是否已軟刪。
// 用於：批次刪除挑筆、以及「已刪除後重複點擊」時判斷原本是單筆或多筆（savedLogIds 不隨軟刪消失）。
export async function savedLogIdsBySmid(db, smid, ownerId) {
  if (!smid) return [];
  const row = await db.prepare(
    "SELECT parsedResult FROM text_inputs WHERE sourceMessageId = ? AND (ownerLineUserId = ? OR lineUserId = ?) ORDER BY id DESC LIMIT 1"
  ).bind(String(smid), ownerId, ownerId).first();
  try { const pr = JSON.parse(row?.parsedResult || '{}'); if (Array.isArray(pr.savedLogIds)) return pr.savedLogIds; } catch (error) { /* ignore */ }
  return [];
}
export async function collectUndoableBySmid(db, smid, ownerId) {
  if (!smid) return [];
  const ids = await savedLogIdsBySmid(db, smid, ownerId);
  return collectUndoable(db, ids, ownerId, MAX_TOKEN_UNDO_IDS);
}
// 執行撤銷：對已挑出的可撤銷筆軟刪除，並重算受影響的（貓,日期）。回傳實際撤銷的 log。
export async function applyUndo(db, items, actorId) {
  const undone = [];
  const affected = new Map();
  const weightPets = new Set(); // 這次批次刪除有動到體重的貓 → 之後要回算目前體重
  for (const log of items) {
    await softDeleteLog(db, log.logId, actorId);
    undone.push(log);
    const date = String(log.eventDateTime).slice(0, 10);
    affected.set(`${log.petId}|${date}`, [log.petId, date]);
    if (log.category === 'weight') weightPets.add(log.petId);
  }
  for (const [, [petId, date]] of affected) { try { await recomputeDay(db, petId, date); } catch (error) { /* 重算失敗不影響撤銷結果 */ } }
  // 批次刪除含體重時，目前體重回退到真正最新的未刪除體重（規格三·批次刪除路徑）
  for (const petId of weightPets) { try { await resyncPetWeight(db, petId); } catch (error) { /* 不影響撤銷結果 */ } }
  return undone;
}

// 時間軸修改共用的安全載入（§3/§4）：logId 不可信，server 端每次重新確認——
// 存在、未刪、category='food'、屬本家庭（沿用既有 log.lineUserId===ownerId 權限，不發明新規則）。
export async function loadEditableFoodLog(db, logId, ownerId) {
  if (!logId) return null;
  const log = await getLog(db, logId);
  if (!log || log.isDeleted) return null;
  if (log.category !== 'food') return null;
  if (String(log.lineUserId) !== String(ownerId)) return null;
  return log;
}

// 修改選單顯示用（§11：不露 logId/foodId）。名稱：有 foodId→品項 displayName；否則 itemName；再否則只顯示類型（generic 不猜品牌，§9）。
async function foodLogDisplay(db, log) {
  let name = String(log.itemName || '').trim();
  if (log.foodId) { const f = await getFood(db, log.foodId); if (f && f.displayName) name = f.displayName; }
  if (!name) name = String(log.foodType || '食物');
  const at = String(log.eventDateTime || '');
  const whenLabel = at.length >= 16 ? `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))} ${at.slice(11, 16)}` : at.slice(0, 10);
  const eaten = Math.round(Number(log.amount) || 0);
  const servedNote = Number(log.servedAmount) > 0
    ? `（原 ${Math.round(Number(log.servedAmount))}g・剩 ${Math.round(Number(log.leftoverAmount) || 0)}g）` : '';
  return { name, whenLabel, eatenText: `實吃 ${eaten}g${servedNote}` };
}

// 改份量時維持 served/leftover 一致（§5）：只在原本有記「原餵量」時處理，其餘紀錄行為不變。
//  - 原餵量 >= 新實吃 → 保留原餵量、剩餘＝原餵量−新實吃。
//  - 新實吃 > 原餵量 → 不造假原餵量，清掉剩食追蹤（只留實吃 amount）。
export function reconcileServedOnSet(log, newAmount) {
  if (!log || log.category !== 'food') return {};
  if (log.servedAmount == null) return {};
  const served = Number(log.servedAmount);
  if (!(served > 0)) return {};
  if (served >= newAmount) return { servedAmount: served, leftoverAmount: Math.round((served - newAmount) * 10) / 10 };
  return { servedAmount: 0, leftoverAmount: 0 };
}

// 套用「改份量」到已鎖定的 log（水／食物共用；§5 served/leftover 一致、§10 重算當日）。呼叫端負責先驗證權限。
export async function applyLogAmountEdit(db, log, newAmount, actorId) {
  const fields = { amount: newAmount };
  if (log.category === 'water') {
    fields.waterMl = newAmount;
  } else if (log.category === 'food') {
    const food = log.foodId ? await getFood(db, log.foodId) : null;
    const derived = deriveFoodFields(newAmount, log.foodType, food);
    fields.kcal = derived.kcal;
    fields.waterMl = derived.waterMl;
    Object.assign(fields, reconcileServedOnSet(log, newAmount));
  }
  const updated = await updateLog(db, log.logId, fields, actorId);
  const summary = await recomputeDay(db, updated.petId, String(updated.eventDateTime).slice(0, 10));
  return { updated, summary };
}

// 套用「改品牌／品項」（§6/§9/§10）：用所選品項重設 foodId／顯示名／類型，並用該品項每克熱量重算 kcal、重算當日。
// 只改這一筆 log，不建立／不修改 food_items。呼叫端負責先驗證 log 與 food 都屬本家庭且同 foodType。
export async function applyFoodBrandChange(db, log, food, actorId) {
  const derived = deriveFoodFields(Number(log.amount) || 0, food.foodType, food);
  const updated = await updateLog(db, log.logId, {
    foodId: food.foodId, itemName: food.displayName, foodType: food.foodType, kcal: derived.kcal, waterMl: derived.waterMl
  }, actorId);
  const summary = await recomputeDay(db, updated.petId, String(updated.eventDateTime).slice(0, 10));
  return { updated, summary };
}

// ── 反查 food_items（無類別詞的品項候選用）＋ smid 合併／冪等（延後確認的品項寫入用）──
// 精確反查：品名（依既有正規化＋去類別詞）完全等於某品項的 displayName／品牌／品名核心才算高信心。
// 用 stripFoodTypeWords 讓「皇家」＝「皇家罐頭」；模糊分數（guessFood）不算精確，一律走 partial。
export function exactFoodMatches(foods, name) {
  const target = stripFoodTypeWords(String(name || ''));
  if (!target) return [];
  return (foods || []).filter((f) => {
    if (f.isDeleted) return false;
    for (const v of [f.displayName, f.brand, f.productName]) {
      const core = stripFoodTypeWords(String(v || ''));
      if (core && core === target) return true;
    }
    return false;
  });
}
// 取這個 smid（家庭範圍）最新一列的 savedLogIds（延後確認時，把新 log 追加進去、不覆蓋先前的水）。
export async function smidPriorSavedIds(db, smid, ownerId) {
  if (!smid) return [];
  const row = await db.prepare(
    "SELECT parsedResult FROM text_inputs WHERE sourceMessageId = ? AND (ownerLineUserId = ? OR lineUserId = ?) ORDER BY id DESC LIMIT 1"
  ).bind(String(smid), ownerId, ownerId).first();
  try { const pr = JSON.parse(row?.parsedResult || '{}'); return Array.isArray(pr.savedLogIds) ? pr.savedLogIds : []; } catch (error) { return []; }
}
// 這個 smid 最新一列「尚未確認的食物片段」佇列（多筆待確認時逐一 prompt 用）。
export async function smidPendingFoods(db, smid, ownerId) {
  if (!smid) return [];
  const row = await db.prepare(
    "SELECT parsedResult FROM text_inputs WHERE sourceMessageId = ? AND (ownerLineUserId = ? OR lineUserId = ?) ORDER BY id DESC LIMIT 1"
  ).bind(String(smid), ownerId, ownerId).first();
  try { const pr = JSON.parse(row?.parsedResult || '{}'); return Array.isArray(pr.pendingFoods) ? pr.pendingFoods : []; } catch (error) { return []; }
}
// 冪等：這個 smid 是否已寫過「同一筆食物」（同 foodId＋克數；raw 無 foodId 時比對類型＋品名＋克數）。
export async function smidHasFoodLog(db, smid, ownerId, { foodId = '', grams = 0, foodType = '', itemName = '' }) {
  const ids = await smidPriorSavedIds(db, smid, ownerId);
  for (const id of ids) {
    const l = await getLog(db, id);
    if (!l || l.isDeleted || l.category !== 'food' || Number(l.amount) !== Number(grams)) continue;
    if (foodId) { if (l.foodId === foodId) return true; }
    else if (l.foodType === foodType && String(l.itemName || '') === String(itemName || '')) return true;
  }
  return false;
}
// 依原始 smid 重查「這次操作」的全部正式紀錄（從最新 savedLogIds 取，過濾已刪／非本家庭）。
// 局部確認完成後的「完整回讀卡」要用它，而不是只用剛新增的那一筆 log 產卡。
export async function logsForSmid(db, smid, ownerId) {
  // 只讀「這個 smid、這個家庭（owner）」的 savedLogIds → 逐筆取 log，排除已刪／已撤銷／非本家庭。
  // ownerLineUserId 已在 smidPriorSavedIds 限定家庭，這裡再以 log.lineUserId===ownerId 二次確認、不跨家庭。
  const ids = await smidPriorSavedIds(db, smid, ownerId);
  const logs = [];
  for (const id of ids) {
    const l = await getLog(db, id);
    if (l && !l.isDeleted && l.lineUserId === ownerId) logs.push(l);
  }
  // 穩定順序：事件時間、再 logId（同一次寫入的順序固定，回讀顯示不跳動）
  logs.sort((a, b) => String(a.eventDateTime).localeCompare(String(b.eventDateTime)) || String(a.logId).localeCompare(String(b.logId)));
  return logs;
}
// 局部確認完成 → 依原始 smid 重查全部正式紀錄，回一張「本次共記錄 N 筆」完整卡（統一撤銷／開啟照護站），
// 讓使用者一眼看到水＋食物同屬這一次、都真的寫進去了，不用靠猜。
async function sendSmidSummaryCard(env, event, db, pet, smid, ownerId, baseUrl, lineUserId) {
  const logs = await logsForSmid(db, smid, ownerId);
  if (!logs.length) return;
  const lines = logs.map((l) => describeLog(l));
  const date = String(logs[0].eventDateTime || '').slice(0, 10) || taipeiToday();
  const summary = await recomputeDay(db, pet.petId, date);
  const siteUrl = await siteLink(env, baseUrl, lineUserId);
  const fallback = `本次共記錄 ${lines.length} 筆：\n${lines.map((l) => `· ${l}`).join('\n')}`;
  await replyOrPushFlex(env, event, multiRecordFlex(pet, lines, summary, date, siteUrl, `smid=${smid}`), fallback);
}
// 無類別詞品項候選反查 food_items：唯一精確→直接記；多筆/模糊→partial 讓使用者選；無命中→保留、告知。
async function resolveCandidate(db, ownerId, cand) {
  const foods = await listFoods(db, ownerId);
  const exact = exactFoodMatches(foods, cand.itemName);
  if (exact.length === 1) return { kind: 'unique', food: exact[0] };
  if (exact.length > 1) return { kind: 'pick', options: exact };
  const guess = guessFood(foods, cand.itemName, ''); // 跨類型模糊
  if (guess) return { kind: 'pick', options: [guess] };
  return { kind: 'none' };
}
// 局部確認流程的下一步：以「該 smid 最新狀態的 pendings（含 status）」為準——
//  - 還有 status==='pending' 的品項 → 只 prompt 下一筆，回「已記錄N筆，另有M筆待確認」，絕不宣稱完成
//  - 沒有 pending → 才出「本次共記錄」完整完成卡
async function advancePending(env, event, db, pet, smid, ownerId, baseUrl, lineUserId) {
  const pendings = await smidPendingFoods(db, smid, ownerId);
  const active = pendings.filter((p) => p.status === 'pending');
  const logs = await logsForSmid(db, smid, ownerId);
  if (!active.length) { await sendSmidSummaryCard(env, event, db, pet, smid, ownerId, baseUrl, lineUserId); return; }
  const next = active[0];
  const done = logs.length ? `目前已記錄 ${logs.length} 筆，` : '';
  const smidEnc = encodeURIComponent(smid);
  const pidEnc = encodeURIComponent(next.id);
  if (next.kind === 'lookup') {
    // 無類別詞候選：重查相符品項，列成可選按鈕（每顆綁 pid）
    const foods = await listFoods(db, ownerId);
    const exact = exactFoodMatches(foods, next.itemName);
    const options = exact.length ? exact : (guessFood(foods, next.itemName, '') ? [guessFood(foods, next.itemName, '')] : []);
    const btns = options.slice(0, 10).map((f) => qrPost(String(f.displayName).slice(0, 20), `action=recFoodG&foodId=${f.foodId}&g=${next.grams}&aw=${next.aw || 0}&smid=${smidEnc}&pid=${pidEnc}`, `${f.displayName} ${next.grams}g`));
    btns.push(qrPost('取消', `action=foodCancel&smid=${smidEnc}&pid=${pidEnc}`, '取消'));
    await replyOrPushQuick(env, event, `${done}另有 ${active.length} 筆待確認：「${next.itemName}」是哪一個品項？（${next.grams} g）`, btns);
    return;
  }
  // 有類別詞、品牌對不到：品項確認卡（帶 pid）
  const foods = await listFoods(db, ownerId);
  const sameType = foods.filter((f) => !f.isDeleted && f.foodType === next.foodType);
  const guess = guessFood(sameType, next.typedName, next.foodType);
  const leadText = `${done}另有 ${active.length} 筆待確認：「${next.typedName}」是哪一個${next.foodType}？（${next.grams} g）`;
  const card = foodDisambigFlex({ pet, foodType: next.foodType, typedName: next.typedName, grams: next.grams, addedWaterMl: next.aw || 0, smid, pid: next.id, options: sameType, guessId: guess?.foodId || '' });
  await replyOrPushMulti(env, event, [{ type: 'text', text: leadText }, card]);
}
// 確認「某一個 pending（pid）」：狀態機防重複——只有 status==='pending' 才寫入並標 confirmed；
// 已 confirmed/cancelled 或找不到（含跨家庭：別家 smid 讀不到 → 空）→ 不動作、回「已處理」。
async function confirmPendingFood(env, event, db, opts) {
  const { pet, smid, pid, ownerId, lineUserId, caregiverName, baseUrl, foodRecord, eventDesc } = opts;
  const pendings = await smidPendingFoods(db, smid, ownerId);
  const entry = pendings.find((p) => p.id === pid);
  if (!entry || entry.status !== 'pending') { await replyOrPush(env, event, '這筆已處理過了 👌'); return; }
  const priorIds = await smidPriorSavedIds(db, smid, ownerId);
  const res = await handleRecord(env, event, pet, foodRecord, ownerId, { fromButton: true, silent: true, actorId: lineUserId, caregiverName, baseUrl, sourceMessageId: smid });
  const allIds = [...new Set([...priorIds, res?.savedLog?.logId, res?.addedWaterLog?.logId].filter(Boolean))];
  const newPendings = pendings.map((p) => (p.id === pid ? { ...p, status: 'confirmed' } : p));
  const active = newPendings.some((p) => p.status === 'pending');
  await logTextInput(db, { lineUserId, ownerId, petId: pet.petId, rawText: '', parseStatus: active ? 'multi_partial' : 'record', failReason: '', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: res?.savedLog?.logId || '', parsedResult: JSON.stringify({ events: [eventDesc], savedLogIds: allIds, pendingFoods: newPendings, unparsedSegments: [], awaitingAction: active ? 'food_selection' : '' }) });
  await advancePending(env, event, db, pet, smid, ownerId, baseUrl, lineUserId);
}
// 一次回多則訊息（文字＋確認卡）：局部 partial 時要同時「告知已記錄的水」＋「只確認不確定的那一段」。
async function replyOrPushMulti(env, event, messages) {
  const list = (messages || []).filter(Boolean);
  if (!list.length) return;
  const targetId = String(event?.source?.userId || '').trim();
  if (event?.replyToken) {
    try { await replyMessages(env, event.replyToken, list); return; } catch (error) { console.warn('multi reply failed:', error.message); }
  }
  if (!targetId) return;
  try { await pushMessages(env, targetId, list); } catch (error) { console.warn('multi push failed:', error.message); }
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

// 選貓提示用：把「已解析的事件」描述成人看得懂的一行（皇家罐頭33g／水8ml／早藥已吃…）。
// 純顯示，不做 food_item 反查（那留到選完貓的落地階段）。
function describeParsedEvent(r) {
  if (!r) return '';
  if (r.category === 'water') return `水 ${r.amount}ml`;
  if (r.category === 'med') return `${r.medSlot || ''}藥 ${r.medStatus || '已餵'}`.trim();
  if (r.category === 'food') return `${r.itemName || ''}${r.foodType || '食物'} ${r.amount}g`.trim();
  if (r.category === 'vomit') return `嘔吐${r.itemName ? `（${r.itemName}）` : ''}`;
  if (r.category === 'stool') return r.itemName || '排便';
  if (r.category === 'mood') return `精神${r.itemName ? `（${r.itemName}）` : ''}`;
  if (r.category === 'weight') return `體重 ${formatWeightKg(r.amount)}kg`;
  return r.itemName || r.note || r.category;
}
export function describeParsedEvents(text) {
  const p = parseMessage(text);
  const recs = p.type === 'multiRecord' ? p.records : (p.type === 'record' ? [p.record] : []);
  return recs.map(describeParsedEvent).filter(Boolean);
}

// 多筆紀錄落地（可被「一則多筆」與「先選貓後補記」共用）：
// 逐筆寫入（typed 品項對不到 → deferDisambig 進 pending）＋反查候選（唯一→記、需選→pending、無命中→告知）＋
// 看不懂片段保留；有 pending → advancePending 逐一確認（回「已記錄N筆，另有M筆待確認」）；全成→多筆卡。
// smid／rawText 由呼叫端帶入，確保「先選貓」流程延續同一次操作（savedLogIds／pendingId 都掛同一 smid）。
export async function recordMultiForPet(env, event, db, opts) {
  const { pet, records = [], candidates = [], unparsed: unparsedIn = [], smid, rawText, ownerId, lineUserId, caregiverName, baseUrl } = opts;
  const lines = [];
  const savedIds = [];
  const pendingDisambig = []; // 有類別詞、品牌對不到 → typed pending
  let lastSummary = null;
  let lastDate = '';
  for (const rec of records) {
    const res = await handleRecord(env, event, pet, rec, ownerId, { silent: true, deferDisambig: true, actorId: lineUserId, caregiverName });
    if (res?.needsDisambig) { pendingDisambig.push(res.disambig); continue; }
    if (res?.mainText) lines.push(res.mainText);
    if (res?.savedLog?.logId) savedIds.push(res.savedLog.logId);
    if (res?.addedWaterLog?.logId) savedIds.push(res.addedWaterLog.logId); // 加水另一筆 log 也算
    if (res?.summary) { lastSummary = res.summary; lastDate = res.eventDate; }
  }
  // 無類別詞品項候選：沿用單句相同的反查邏輯（唯一→記、多筆/模糊→partial、無命中→保留告知）
  const lookupPendings = [];
  const noMatch = [];
  for (const cand of (Array.isArray(candidates) ? candidates : [])) {
    const r = await resolveCandidate(db, ownerId, cand);
    if (r.kind === 'unique') {
      const res = await handleRecord(env, event, pet, { category: 'food', foodType: r.food.foodType, itemName: r.food.displayName, amount: cand.amount, unit: 'g', addedWaterMl: cand.addedWaterMl || 0, medStatus: '', medSlot: '', note: '' }, ownerId, { silent: true, actorId: lineUserId, caregiverName });
      if (res?.mainText) lines.push(res.mainText);
      if (res?.savedLog?.logId) savedIds.push(res.savedLog.logId);
      if (res?.addedWaterLog?.logId) savedIds.push(res.addedWaterLog.logId);
      if (res?.summary) { lastSummary = res.summary; lastDate = res.eventDate; }
    } else if (r.kind === 'pick') {
      lookupPendings.push({ kind: 'lookup', itemName: cand.itemName, grams: cand.amount, aw: cand.addedWaterMl || 0 });
    } else {
      noMatch.push({ itemName: cand.itemName, grams: cand.amount });
    }
  }
  const unparsed = Array.isArray(unparsedIn) ? unparsedIn : [];
  // 待確認佇列（typed＋lookup），每筆給穩定 id＋status，取消/確認只動被點的那一筆
  const pendings = [
    ...pendingDisambig.map((d) => ({ kind: 'typed', foodType: d.foodType, typedName: d.typedName, grams: d.grams, aw: d.addedWaterMl || 0 })),
    ...lookupPendings
  ].map((p, i) => ({ id: `p${i}`, status: 'pending', ...p }));
  const hasPending = pendings.length > 0;
  const anyContent = lines.length || pendings.length || noMatch.length;
  const multiStatus = !anyContent ? 'unknown' : ((hasPending || unparsed.length || noMatch.length) ? 'multi_partial' : 'record');
  await logTextInput(db, {
    lineUserId, ownerId, petId: pet.petId, rawText: rawText || '',
    parseStatus: multiStatus, failReason: !anyContent ? 'no_valid_segment' : '',
    sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: savedIds.join(','),
    parsedResult: JSON.stringify({
      events: records.map((r) => ({ category: r.category, amount: r.amount, unit: r.unit, itemName: r.itemName, addedWaterMl: r.addedWaterMl || 0 })),
      savedLogIds: savedIds,
      pendingFoods: pendings,
      noMatch,
      unparsedSegments: unparsed,
      awaitingAction: hasPending ? 'food_selection' : ''
    })
  });
  // 「尚未找到相符品項」文案：不得用「看不懂」、不得讓片段消失
  const noMatchTxt = noMatch.map((x) => `我辨認到品項「${x.itemName}」${x.grams}g，但尚未找到相符的常用食物。`).join('\n');
  // 有待確認 → 逐一 prompt（advancePending 會回「已記錄N筆，另有M筆待確認」，不宣稱完成）
  if (hasPending) { await advancePending(env, event, db, pet, smid, ownerId, baseUrl, lineUserId); return; }
  if (!lines.length) {
    const parts = [noMatchTxt, unparsed.length ? `⚠️ 這些我看不懂、尚未記錄：\n${unparsed.map((u) => `· ${u}`).join('\n')}\n可以分開再打一次（例：罐頭 34）。` : ''].filter(Boolean);
    if (parts.length) { await replyOrPush(env, event, parts.join('\n\n')); return; }
    await guideUnknown(env, event, pet?.petId || ''); return;
  }
  if (noMatchTxt || unparsed.length) {
    // 已記錄 ＋ 尚未找到相符/看不懂 → 明列，刪除只刪已成功的
    const recTxt = `✅ 已記錄 ${lines.length} 筆：\n${lines.map((l) => `· ${l}`).join('\n')}`;
    const extras = [noMatchTxt, unparsed.length ? `⚠️ 這 ${unparsed.length} 筆看不懂、尚未記錄：\n${unparsed.map((u) => `· ${u}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const undoLabel = savedIds.length >= 2 ? `🗑 刪除這次 ${savedIds.length} 筆` : '🗑 刪除這筆';
    const undoBtn = savedIds.length ? [qrPost(undoLabel, `action=undoOp&smid=${smid}`, savedIds.length >= 2 ? `刪除這次 ${savedIds.length} 筆` : '刪除這筆')] : [];
    await replyOrPushQuick(env, event, `${recTxt}\n\n${extras}`, undoBtn);
    return;
  }
  const fallback = `已記錄 ${lines.length} 筆：\n${lines.map((line) => `· ${line}`).join('\n')}`;
  const multiSiteUrl = await siteLink(env, baseUrl, lineUserId);
  const multiUndo = savedIds.length ? `smid=${smid}` : '';
  await replyOrPushFlex(env, event, multiRecordFlex(pet, lines, lastSummary, lastDate, multiSiteUrl, multiUndo), fallback);
}

export async function handleTextMessage(event, env, baseUrl) {
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
    // 防暴力猜邀請碼：同一使用者 10 分鐘內最多 12 次兌換嘗試；超過就當作無效（明確加入才回提示，其餘讓訊息照常處理）
    const throttled = await rateLimited(db, `invite:${lineUserId}`, 12, 600);
    const result = throttled ? { ok: false, reason: 'throttled' } : await redeemCareInvite(db, codeMatch[1], lineUserId);
    if (result.ok) {
      await track(db, lineUserId, 'invite_redeemed');
      if (!isBetaAllowed(user)) await updateUser(db, lineUserId, { betaAccess: 1 });
      const joinedPets = await listPets(db, result.ownerLineUserId);
      const joinedNames = joinedPets.map((p) => p.petName).filter(Boolean).join('、');
      const joinMsg = joinedPets.length >= 2
        ? `✓ 加入成功！你的登記顯示有 ${joinedPets.length} 隻貓貓：${joinedNames}，請打名字先選要記哪隻貓貓的資料哦～\n選好後打「水 20」「罐頭 30」就會記給牠，也能打「管家後台」看完整資料 🐈`
        : '✓ 加入成功！接下來你在這裡打「水 20」「罐頭 30」就會記進對方的貓咪，也能打「管家後台」開網站看完整資料 🐈';
      await replyOrPush(env, event, joinMsg);
      try { await ensurePersonalRichMenu(env, baseUrl, lineUserId); } catch (error) { console.error('personal richmenu failed:', error.message); }
      return;
    }
    if (explicit) {
      const why = result.reason === 'throttled' ? '嘗試太多次了，請稍後再試。'
        : result.reason === 'expired' ? '這組邀請碼已過期（7 天有效），請對方再給你一組新的。'
        : result.reason === 'self' ? '這是你自己的邀請碼，不用加入喔。'
        : '找不到這組邀請碼，請確認有沒有打錯。';
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
      `💻 用電腦登入管家後台：\n\n1. 電腦打開這個網址：\n${baseUrl}\n\n2. 在登入畫面輸入這組登入碼：\n${code}\n\n（10 分鐘內有效，用一次就好；登入後電腦會記住你，下次直接開網址就進得去）`);
    return;
  }

  // 共同照護：飼主產生邀請碼，給家人/幫手一起照護
  if (['邀請', '共同照護', '加入照護', '一起照護', '找人照護', '找人一起照顧', '新增照護者', '加人',
       '邀請家人', '邀請人', '加入人', '怎麼加入人', '加家人', '新增照顧者', '共同照顧', '一起照顧'].includes(text)
      || /加入.*一起照/.test(text) || /怎麼.*加入.*人/.test(text)) {
    const code = await createCareInvite(db, ownerId);
    await track(db, lineUserId, 'invite_created');
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
  // 「把炭吉體重改成6公斤」：把/幫 開頭時，剝掉動詞助詞讓貓名回句首，交既有貓名前綴流程（僅在剝完真的接已知貓名時）。
  if (/^(?:請幫|請|把|幫)/.test(text)) {
    const stripped = text.replace(/^(?:請幫|請|把|幫)\s*/, '');
    if (pets.some((p) => p.petName && stripped.startsWith(p.petName))) text = stripped;
  }
  let switchTarget = null;
  let explicitPet = false; // 這則有沒有「明確指定貓」（打名字前綴），有的話就不用再問要記哪隻
  let leadPick = null;     // 不明句首＋後段可解析（例：旺財 喝水 1ml）→ 待問要記哪隻貓，先不寫入
  let leadPartial = null;  // 已辨認貓、但後段（像食物名＋份量）尚無法可靠解析（例：蚵仔希爾斯罐頭23g）→ 不寫入
  for (const candidate of pets) {
    const names = [candidate.petName, `@${candidate.petName}`];
    if (names.includes(text)) { switchTarget = candidate; break; }
    const pfx = names.find((n) => text.startsWith(`${n} `));
    if (pfx) { pet = candidate; explicitPet = true; text = text.slice(pfx.length).trim(); break; }
  }
  // 既有「貓名＋空格」沒命中時，補：①黏著／標點的已知貓名（蚵仔喝水1ml、蚵仔，喝水1ml）→ 指定該貓；
  // ②不明句首＋後段可解析（旺財 喝水 1ml）→ 不靜默寫預設貓，改問要記哪隻。既有正常格式不受影響（clean）。
  if (!switchTarget && !explicitPet) {
    const lead = analyzeLeading(text, pets.map((p) => p.petName));
    if (lead.kind === 'named') {
      const target = pets.find((p) => p.petName === lead.petName);
      if (target) { pet = target; explicitPet = true; text = lead.rest; }
    } else if (lead.kind === 'partial') {
      leadPartial = lead;
    } else if (lead.kind === 'leadingUnknown' || lead.kind === 'leadingNoPet') {
      // leadingUnknown＝句首有不明前綴（旺財…）；leadingNoPet＝無不明前綴、只是沒指定貓（皇家罐頭33 水8 早藥）。
      // 兩者都問「要記哪隻貓」，但 leadingNoPet 帶完整句、列出所有事件、選完走完整多筆機制（不遺失食物）。
      leadPick = lead;
    }
  }
  if (switchTarget) {
    if (pets.length > 1) {
      // 若正在等「這筆記給哪隻貓？」（pendrec），使用者回貓名＝回答上一筆 → 優先完成那筆（重走 handleRecord），
      // 完成後把牠設成 active pet；之後的紀錄就直接記給牠，不必再問。沒有 pendrec 才是單純切換。
      const completed = await tryCompletePendingRecord(env, event, { db, user, pet: switchTarget, lineUserId, ownerId, caregiverName, baseUrl });
      if (completed) {
        if (user.defaultPetId !== switchTarget.petId) await updateUser(db, lineUserId, { defaultPetId: switchTarget.petId });
        return;
      }
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

  // 已辨認貓、但後段（像食物名＋份量）尚無法可靠解析（蚵仔希爾斯罐頭23g）→ 不寫入、不降級成通用罐頭。
  // 第一階段安全失敗：辨認到的貓存進 raw，給這隻貓的常用捷徑；正式 logs 為 0。（第二階段用 food_item 精確比對）
  if (leadPartial) {
    const target = pets.find((p) => p.petName === leadPartial.petName);
    const rpid = target?.petId || '';
    await logTextInput(db, {
      lineUserId, ownerId, petId: rpid, rawText: event.message?.text || '',
      parseStatus: 'partial', failReason: 'unknown_food_expression', sourceMessageId: String(event.message?.id || ''),
      resolvedPetId: rpid, linkedLogId: '', parsedResult: JSON.stringify({ events: [], savedLogIds: [], unparsedSegments: [leadPartial.rest], awaitingAction: '', recognizedPetName: leadPartial.petName, rest: leadPartial.rest })
    });
    // 下方捷徑一律「帶上這隻貓的名字」再送出（例：點「罐頭 30」實際送「蚵仔 罐頭 30」），
    // 確保記到正確的貓；每個都是完整獨立指令，不靠任何暫存狀態，不會跨訊息污染或重複。
    const shortcuts = (await quickShortcuts(db, rpid)).map((it) => ({
      type: 'action',
      action: { type: 'message', label: it.action.label, text: `${leadPartial.petName} ${it.action.text}` }
    }));
    await replyOrPushQuick(env, event,
      `我知道你要記錄「${leadPartial.petName}」，但還看不懂「${leadPartial.rest}」🙏\n`
      + `⚠️ 這筆尚未記錄。\n`
      + `請從下方選一個（會記給「${leadPartial.petName}」），或改打「${leadPartial.petName} 罐頭 23」這種格式：`,
      shortcuts);
    return;
  }

  // 沒指定貓、但整句可解析 → 不靜默寫預設貓；請使用者選貓。選貓（postback）前正式 logs 為 0 筆；
  // 事件文字帶在 postback，選完用同一 smid 落地、保留原事件、不用重打。
  //  - leadingNoPet：無不明前綴（皇家罐頭33 水8 早藥），列出所有事件、帶完整句；選完走完整多筆機制（不遺失食物）。
  //  - leadingUnknown：句首有不明前綴（旺財…），沿用「看得懂後段、不確定前綴」問法。
  if (leadPick) {
    const smid = String(event.message?.id || '');
    const noPrefix = leadPick.kind === 'leadingNoPet' || !leadPick.prefix;
    const evText = leadPick.eventText;
    const catBtns = pets.slice(0, 12).map((p) => qrPost(p.petName, `action=pickcatFor&petId=${p.petId}&ev=${encodeURIComponent(evText)}&smid=${encodeURIComponent(smid)}`, p.petName));
    await logTextInput(db, {
      lineUserId, ownerId, petId: '', rawText: event.message?.text || '',
      parseStatus: 'awaiting_pet_selection', failReason: noPrefix ? 'no_pet_specified' : 'leading_unknown', sourceMessageId: smid,
      resolvedPetId: '', linkedLogId: '', parsedResult: JSON.stringify({ events: [], savedLogIds: [], unparsedSegments: [], awaitingAction: 'pet_selection', prefix: leadPick.prefix || '', eventText: evText })
    });
    if (noPrefix) {
      const list = describeParsedEvents(evText).map((t) => `・${t}`).join('\n');
      await replyOrPushQuick(env, event,
        `我看懂你要記：\n${list}\n\n請選擇要記在哪隻貓咪：`,
        catBtns);
    } else {
      await replyOrPushQuick(env, event,
        `我看得懂「${leadPick.eventText}」，但不確定前面的「${leadPick.prefix}」代表什麼。\n請選要記錄的貓咪，或直接重新輸入：`,
        catBtns);
    }
    return;
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
      // P0-1：只要名字就完成（第 2、3 隻貓同樣不阻塞）；體重／食物改為選填、之後補
      await updateUser(db, lineUserId, { pendingAction: '' });
      await replyOrPushFlex(env, event, petAddedCard(newPet.petName), `${intent.name}加入完成，現在就可以開始記錄！之後想補體重、生日或常吃食物，打「補資料」或開管家後台即可。`);
      return;
    }

    case 'exampleMenu': {
      await replyOrPushFlex(env, event, exampleCard(), '怎麼記：\n主食3（吃飯）\n喝水30（喝水）\n嘔吐 白沫（狀況）\n最近吃什麼（回頭查）');
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
        subtitle: '選填，之後在管家後台也都能改',
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
      if (!explicitPet && needsCatPick(user, pets)) {
        // 已成功解析、只缺「哪隻貓」→ 暫存這筆（pendrec），等使用者回貓名再用既有流程完成，不要丟掉輸入。
        await updateUser(db, lineUserId, { pendingAction: `pendrec:${JSON.stringify({ r: intent.record, t: Date.now() })}` });
        await askWhichCat(env, event, pets);
        return;
      }
      if (!pet) {
        pet = await createPet(db, ownerId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      const recRes = await handleRecord(env, event, pet, intent.record, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
      const recSavedId = recRes?.savedLog?.logId || '';                                  // 主 log（食物/該事件）
      const recAllIds = [recRes?.savedLog?.logId, recRes?.addedWaterLog?.logId].filter(Boolean); // 全部（含加水）
      // 狀態誠實：只有真的寫入 log 才算 record；待選品牌 → awaiting_food_selection（0 正式 log）
      const recStatus = recSavedId ? 'record' : (recRes?.disambiguated ? 'awaiting_food_selection' : 'record');
      await logTextInput(db, {
        lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
        parseStatus: recStatus, failReason: recRes?.disambiguated ? 'need_food_selection' : '',
        sourceMessageId: String(event.message?.id || ''), resolvedPetId: pet.petId, linkedLogId: recSavedId,
        parsedResult: JSON.stringify({
          events: [{ category: intent.record.category, amount: intent.record.amount, unit: intent.record.unit, itemName: intent.record.itemName, addedWaterMl: intent.record.addedWaterMl || 0 }],
          savedLogIds: recAllIds,
          unparsedSegments: [],
          awaitingAction: recRes?.disambiguated ? 'food_selection' : ''
        })
      });
      return;
    }

    case 'multiRecord': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      if (!pet) {
        pet = await createPet(db, ownerId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      await recordMultiForPet(env, event, db, {
        pet, records: intent.records, candidates: intent.candidates, unparsed: intent.unparsed,
        smid: String(event.message?.id || ''), rawText: event.message?.text || '',
        ownerId, lineUserId, caregiverName, baseUrl
      });
      return;
    }

    // 多個中文數字、無單位無標點 → 對應不明（皇家三八水十五）：保守起見「不先寫入任何一筆」，
    // 保留原文＋數字候選，回 partial 並請使用者打清楚（帶單位或分行）。不臆測、不靜默寫入。
    case 'ambiguousAmounts': {
      const smid = String(event.message?.id || '');
      const rawText = event.message?.text || '';
      const nums = (intent.amountCandidates || []).join('、');
      await logTextInput(db, {
        lineUserId, ownerId, petId: pet?.petId || '', rawText,
        parseStatus: 'partial', failReason: 'ambiguous_amounts', sourceMessageId: smid,
        resolvedPetId: pet?.petId || '', linkedLogId: '',
        parsedResult: JSON.stringify({ events: [], savedLogIds: [], amountCandidates: intent.amountCandidates || [], unparsedSegments: [rawText], awaitingAction: 'clarify_amounts' })
      });
      await replyOrPush(env, event,
        `我看到「${nums}」這幾個數字，但不確定它們分別代表什麼 🙏\n`
        + `這筆先沒有記錄。可以幫我打清楚一點，例如：\n`
        + `· 帶單位：「皇家罐頭 38克，喝水 15ml」\n`
        + `· 或分行分開打：\n　皇家罐頭 38克\n　喝水 15ml`);
      return;
    }

    // 只有「品名＋數量」、沒有類別詞（皇家33）→ 反查家庭 food_items，不臆測是不是食物、更不臆測類型。
    case 'item_lookup_candidate': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      if (!pet) {
        pet = await createPet(db, ownerId, { petName: '貓貓' });
        await updateUser(db, lineUserId, { defaultPetId: pet.petId });
      }
      const smid = String(event.message?.id || '');
      const foods = await listFoods(db, ownerId);
      const matches = exactFoodMatches(foods, intent.itemName);
      // 1) 唯一且精確命中 → 用該品項既有 foodType/資料，依現有高信心規則直接記錄（不用再說「罐頭/乾糧」）
      if (matches.length === 1) {
        const f = matches[0];
        const res = await handleRecord(env, event, pet, {
          category: 'food', foodType: f.foodType, itemName: f.displayName,
          amount: intent.amount, unit: 'g', addedWaterMl: intent.addedWaterMl || 0,
          medStatus: '', medSlot: '', note: '', dayOffset: intent.dayOffset || 0, time: intent.time || ''
        }, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
        const allIds = [res?.savedLog?.logId, res?.addedWaterLog?.logId].filter(Boolean);
        await logTextInput(db, {
          lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
          parseStatus: 'record', failReason: '', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: res?.savedLog?.logId || '',
          parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: f.foodType, itemName: f.displayName, amount: intent.amount, addedWaterMl: intent.addedWaterMl || 0 }], savedLogIds: allIds, unparsedSegments: [], awaitingAction: '' })
        });
        return;
      }
      // 2) 多筆／跨類型命中 → 不自動寫，出品項確認卡讓使用者選（帶克數，選完直接記，並沿用 smid）
      if (matches.length > 1) {
        const smidEnc = encodeURIComponent(smid);
        const btns = matches.slice(0, 10).map((f) => qrPost(String(f.displayName).slice(0, 20), `action=recFoodG&foodId=${f.foodId}&g=${intent.amount}&aw=${intent.addedWaterMl || 0}&smid=${smidEnc}`, `${f.displayName} ${intent.amount}g`));
        btns.push(qrPost('取消', `action=foodCancel&smid=${smidEnc}`, '取消'));
        await logTextInput(db, {
          lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
          parseStatus: 'awaiting_food_selection', failReason: 'item_lookup_multi', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: '',
          parsedResult: JSON.stringify({ events: [{ category: 'food', itemName: intent.itemName, amount: intent.amount }], savedLogIds: [], unparsedSegments: [], awaitingAction: 'food_selection' })
        });
        await replyOrPushQuick(env, event, `「${intent.itemName}」有幾個可能的品項，請選一個（${intent.amount} g）：`, btns);
        return;
      }
      // 3) 家庭「習慣的叫法」（§二/§五/§九）：沒有明確 food_item 命中才查，且每次 server 端重新驗證（§八）。
      const alias = await resolveFoodAlias(db, ownerId, intent.itemName);
      if (alias) {
        const rec = alias.kind === 'foodItem'
          ? { category: 'food', foodType: alias.food.foodType, itemName: alias.food.displayName, amount: intent.amount, unit: 'g', addedWaterMl: intent.addedWaterMl || 0, medStatus: '', medSlot: '', note: '', dayOffset: intent.dayOffset || 0, time: intent.time || '' }
          : { category: 'food', foodType: alias.foodType, itemName: '', amount: intent.amount, unit: 'g', addedWaterMl: intent.addedWaterMl || 0, medStatus: '', medSlot: '', note: '', dayOffset: intent.dayOffset || 0, time: intent.time || '' };
        const res = await handleRecord(env, event, pet, rec, ownerId, { actorId: lineUserId, caregiverName, baseUrl });
        const allIds = [res?.savedLog?.logId, res?.addedWaterLog?.logId].filter(Boolean);
        await logTextInput(db, {
          lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
          parseStatus: 'record', failReason: '', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: res?.savedLog?.logId || '',
          parsedResult: JSON.stringify({ events: [{ category: 'food', foodType: rec.foodType, itemName: rec.itemName, amount: intent.amount, alias: intent.itemName }], savedLogIds: allIds, unparsedSegments: [], awaitingAction: '' })
        });
        return;
      }
      // 4) 第一次遇到的口語叫法（文字＋數字、非保留詞）→ 不亂猜，先安全詢問「這是指什麼？」（§六/§二十二）
      if (isAskableFoodName(intent.itemName)) {
        const n = encodeURIComponent(intent.itemName);
        const g = Number(intent.amount) || 0;
        const aw = Number(intent.addedWaterMl) || 0;
        const btns = ALIAS_FOODTYPES.map((t) => qrPost(t, `action=aliasType&n=${n}&g=${g}&aw=${aw}&t=${encodeURIComponent(t)}`, t));
        btns.push(qrPost('先不記', `action=aliasCancel&n=${n}`, '先不記'));
        await logTextInput(db, {
          lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
          parseStatus: 'awaiting_food_alias', failReason: 'alias_unknown', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: '',
          parsedResult: JSON.stringify({ events: [{ itemName: intent.itemName, amount: intent.amount }], savedLogIds: [], unparsedSegments: [], awaitingAction: 'food_alias' })
        });
        await replyOrPushQuick(env, event, `「${intent.itemName}」是指哪一種？（這次 ${g}g）\n選好之後可以讓管家記住，下次直接用。`, btns);
        return;
      }
      // 5) 完全沒命中且不像叫法 → 不猜是哪種食物、不寫入，保留為未解析並引導補上類型
      await logTextInput(db, {
        lineUserId, ownerId, petId: pet.petId, rawText: event.message?.text || '',
        parseStatus: 'unknown', failReason: 'item_lookup_none', sourceMessageId: smid, resolvedPetId: pet.petId, linkedLogId: '',
        parsedResult: JSON.stringify({ events: [{ itemName: intent.itemName, amount: intent.amount }], savedLogIds: [], unparsedSegments: [`${intent.itemName} ${intent.amount}`], awaitingAction: '' })
      });
      await replyOrPush(env, event, `我看到「${intent.itemName} ${intent.amount}」，但還不確定這是哪一種食物 🙏\n可以打「罐頭 ${intent.itemName} ${intent.amount}」告訴我類型，或到管家後台先建立這個品項。`);
      return;
    }

    case 'query': {
      await handleQuery(env, event, user, pet, intent.query, baseUrl, lineUserId, ownerId, intent);
      return;
    }

    case 'weightModify': {
      const wSmid = String(event.message?.id || '');
      // 規格五：完整保留 raw input＋parseStatus＋sourceMessageId（此步為「待確認」，結果於確認後補記）
      await logTextInput(db, {
        lineUserId, ownerId, petId: pet?.petId || '', rawText: event.message?.text || '',
        parseStatus: 'awaiting_weight_modify', failReason: '', sourceMessageId: wSmid,
        resolvedPetId: pet?.petId || '', linkedLogId: '',
        parsedResult: JSON.stringify({ events: [{ category: 'weight', op: 'modify', amount: intent.amount }], savedLogIds: [], unparsedSegments: [], awaitingAction: 'weight_modify_confirm' })
      });
      await handleWeightModify(env, event, { db, pet, pets, explicitPet, amount: intent.amount, lineUserId, ownerId, smid: wSmid, baseUrl });
      return;
    }

    case 'fixLast': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      await handleFixLast(env, event, pet, intent, lineUserId);
      return;
    }

    case 'fixMatch': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      await handleFixMatch(env, event, pet, intent, lineUserId);
      return;
    }

    case 'foodAdjust': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      await handleFoodAdjust(env, event, pet, intent, lineUserId);
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
        await replyOrPush(env, event, '吃了幾克？直接打數字，例如 30\n（先當罐頭記，之後可在管家後台改）\n\n💡 熟了更快：直接打「罐頭 品名 30」。');
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
      await replyOrPush(env, event, '要修正紀錄：\n改成 54（把最近一餐改成實吃 54）\n改 皇家罐頭 24（指定品名／類型改）\n剩 20（這餐剩 20，其餘算吃掉，保留原餵量）\n扣 20（從實吃量再扣掉 20）\n刪除（整筆刪掉）');
      return;
    }

    case 'invalid': {
      await logTextInput(db, { lineUserId, ownerId, petId: '', rawText: event.message?.text || '', parseStatus: 'invalid', failReason: intent.reason || '', sourceMessageId: String(event.message?.id || ''), resolvedPetId: '', linkedLogId: '', parsedResult: JSON.stringify({ events: [], savedLogIds: [], unparsedSegments: [event.message?.text || ''], awaitingAction: '', category: intent.category, reason: intent.reason }) });
      if (intent.reason === 'missing_amount' && intent.category === 'food' && pet) {
        await updateUser(db, lineUserId, { pendingAction: `amount|${text}` });
        await replyOrPush(env, event, '幾克呢？直接打數字就好');
        return;
      }
      await replyOrPush(env, event, invalidReply(intent.reason, intent.category));
      return;
    }

    // 泡水歧義：只給了「加水/泡水＋數字」、沒有食物克數 → 不預設，二選一，確認前不寫入
    case 'foodWaterAmbiguous': {
      if (!explicitPet && needsCatPick(user, pets)) { await askWhichCat(env, event, pets); return; }
      const ft = intent.foodType; const n = intent.amount;
      await logTextInput(db, { lineUserId, ownerId, petId: pet?.petId || '', rawText: event.message?.text || '', parseStatus: 'awaiting_food_selection', failReason: 'amount_ambiguous', sourceMessageId: String(event.message?.id || ''), resolvedPetId: pet?.petId || '', linkedLogId: '', parsedResult: JSON.stringify({ events: [], savedLogIds: [], unparsedSegments: [], awaitingAction: 'amount_choice', foodType: ft, amount: n }) });
      await replyOrPushQuick(env, event, `你說的 ${n} 是：\nA. ${ft} ${n} 克\nB. 加水 ${n} ml`, [
        qrPost(`A. ${ft} ${n}克`, `action=foodAmbigG&t=${encodeURIComponent(ft)}&g=${n}`, `${ft} ${n} 克`),
        qrPost(`B. 加水 ${n}ml`, `action=foodAmbigW&t=${encodeURIComponent(ft)}&aw=${n}`, `加水 ${n} ml`)
      ]);
      return;
    }

    default: {
      // §10 純品牌名（沒有數字）剛好命中已建立品項 → 問份量，不當死路、也不亂記成 0g
      if (await handleBrandOnly(env, event, db, pet, ownerId, text)) return;
      // 看不懂不當死路：教打字 ＋ 這隻貓的一鍵捷徑，順手就能記
      await logTextInput(db, { lineUserId, ownerId, petId: '', rawText: event.message?.text || '', parseStatus: 'unknown', failReason: 'unrecognized', sourceMessageId: String(event.message?.id || ''), resolvedPetId: '', linkedLogId: '', parsedResult: JSON.stringify({ events: [], savedLogIds: [], unparsedSegments: [event.message?.text || ''], awaitingAction: '' }) });
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
// 由「原紀錄＋調整意圖」算出實吃／實喝量與（剩餘語意時的）原餵量／剩餘量。
//  - set（改成 N）：實量＝N。
//  - leftover（剩 N）：原餵量取「已記的 servedAmount，沒有就用目前 amount」，實量＝原餵量−N，並保留 served/leftover。
//  - subtract（扣/減 N）：實量＝目前 amount−N（相對扣減，不記剩餘量）。
export function computeAdjust(target, intent) {
  const old = Number(target.amount) || 0;
  const hadServed = target.servedAmount != null && Number(target.servedAmount) > 0;
  const servedBase = hadServed ? Number(target.servedAmount) : old;
  let served = null;
  let leftover = null;
  let consumed;
  if (intent.mode === 'set') {
    consumed = intent.amount;
  } else if (intent.mode === 'leftover') {
    served = servedBase;
    leftover = intent.amount;
    consumed = Math.round((served - leftover) * 10) / 10;
  } else { // subtract
    consumed = Math.round((old - intent.amount) * 10) / 10;
  }
  return { consumed, served, leftover, servedBase, alreadyAdjusted: hadServed };
}

// P0-2：把「剩/扣/改成」對到「正確的那一餐」再調整——以貓為範圍找最近一筆食物（沒食物才退回最近喝水），
// 不再用 getLastLogByUser（可能抓到別隻貓或非食物紀錄）。amount 一律＝實吃量、統計語意不變；
// 剩餘語意會保留 servedAmount／leftoverAmount。實量<0 不寫、請使用者確認；=0 也會提示整份沒吃/喝。
export async function handleFixLast(env, event, pet, intent, actorId) {
  const db = env.DB;
  await ensureTaskSchema(db); // 內含 servedAmount／leftoverAmount 欄位的冪等建立
  if (!pet) { await replyOrPush(env, event, '找不到可以調整的食物紀錄'); return; }
  const recent = (await getRecentLogsByPet(db, pet.petId, 30)) || [];
  const foods = recent.filter((l) => l.category === 'food');

  // 找目標：明確講「沒喝完」→ 最近一筆喝水；否則預設最近一餐食物；沒有食物但最近一筆是喝水 → 退回調整喝水
  let target = null;
  if (intent.target === 'water') target = recent.find((l) => l.category === 'water') || null;
  if (!target) target = foods[0] || null;
  if (!target && recent[0]?.category === 'water') target = recent[0];
  if (!target) { await replyOrPush(env, event, '找不到可以調整的食物紀錄'); return; }

  await applyAdjustToLog(env, event, db, target, intent, actorId);
}

// 對「已鎖定的那一筆」套用調整（fixLast 找到最近一餐、fixMatch 選定品項、或歧義確認後的 postback 共用）。
export async function applyAdjustToLog(env, event, db, target, intent, actorId) {
  const isWater = target.category === 'water';
  const { consumed, served, leftover, servedBase, alreadyAdjusted } = computeAdjust(target, intent);

  if (consumed < 0) {
    const base = isWater ? '喝' : '吃';
    await replyOrPush(env, event, `這樣算出來會變成負的（原本${isWater ? '倒' : '餵'} ${servedBase}、${intent.mode === 'leftover' ? `剩 ${intent.amount}` : `扣 ${intent.amount}`}）。\n請確認數字，或直接打「改成 N」重設實際${base}掉的量。`);
    return;
  }

  const fields = { amount: consumed };
  if (isWater) {
    fields.waterMl = consumed;
  } else {
    const food = target.foodId ? await getFood(db, target.foodId) : null;
    const derived = deriveFoodFields(consumed, target.foodType, food);
    fields.kcal = derived.kcal;
    fields.waterMl = derived.waterMl;
  }
  if (intent.mode === 'leftover') { fields.servedAmount = served; fields.leftoverAmount = leftover; }

  const updated = await updateLog(db, target.logId, fields, actorId);
  const eventDate = String(updated.eventDateTime).slice(0, 10);
  const summary = await recomputeDay(db, updated.petId, eventDate);
  const cardPet = await getPet(db, updated.petId);

  const subParts = [];
  if (!isWater && updated.kcal) subParts.push(`${updated.kcal} kcal`);
  if (!isWater && updated.waterMl) subParts.push(`水 ${updated.waterMl} ml`);
  if (intent.mode === 'leftover') subParts.push(`原${isWater ? '倒' : '餵'} ${servedBase}・剩 ${leftover}`);
  else if (intent.mode === 'subtract') subParts.push(`扣掉 ${intent.amount}`);
  if (consumed === 0) subParts.push(`整份沒${isWater ? '喝' : '吃'}`);
  if (alreadyAdjusted && intent.mode === 'leftover') subParts.push('（已依原餵量重算）');

  const categoryKey = isWater ? 'water' : (isWetFoodType(updated.foodType) ? 'wet' : 'dry');
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

// 「改 皇家罐頭 24」：找最近一筆符合品名/類型的食物，改它的克數（連帶重算熱量/含水）。
// P0-2：以貓為範圍找符合品名/類型的食物；若有「多筆都對得上」→ 不亂猜、出確認卡讓使用者選是哪一餐。
export async function handleFixMatch(env, event, pet, intent, actorId) {
  const db = env.DB;
  await ensureTaskSchema(db);
  if (!pet) { await replyOrPush(env, event, '找不到可以調整的食物紀錄'); return; }
  const q = intent.query;
  const recent = (await getRecentLogsByPet(db, pet.petId, 30)) || [];
  const foods = recent.filter((l) => l.category === 'food' && !l.isDeleted);
  // 先比品名，全都對不上再比類型；蒐集「所有」符合的，判斷是否需要選餐
  let matches = foods.filter((l) => l.itemName && (l.itemName.includes(q) || q.includes(l.itemName)));
  if (!matches.length) matches = foods.filter((l) => l.foodType && (l.foodType.includes(q) || q.includes(l.foodType)));
  if (!matches.length) {
    await replyOrPush(env, event, `找不到可以調整的食物紀錄（「${q}」）。\n・想改最近一餐：直接打「改 ${intent.amount}」\n・或到管家後台點那筆改`);
    return;
  }
  const setIntent = { mode: 'set', amount: intent.amount };
  if (matches.length === 1) {
    await applyAdjustToLog(env, event, db, matches[0], setIntent, actorId);
    return;
  }
  // 多筆都對得上 → 出快速選單，點哪一餐就改哪一餐（不亂猜）
  const btns = matches.slice(0, 8).map((l) => {
    const t = String(l.eventDateTime).slice(11, 16) || String(l.eventDateTime).slice(5, 10);
    const label = `${t} ${l.itemName || l.foodType} ${Math.round(Number(l.amount) || 0)}g`;
    return qrPost(label.slice(0, 20), `action=fixPick&logId=${encodeURIComponent(l.logId)}&amt=${intent.amount}`, label);
  });
  await replyOrPushQuick(env, event, `有 ${matches.length} 餐都對得上「${q}」，要改哪一餐成 ${intent.amount}？`, btns);
}

// 超口語調整「乾乾減5克 / 主食扣3 / 主食-3」：以貓為範圍、只找該 foodType 的近期食物紀錄再扣減。
// 安全定位（沿用 fixMatch 精神）：先鎖貓（呼叫端已做）→ 只看該貓、未刪、同 foodType 的食物 →
//   confirm=false（有明確動詞）：唯一候選直接扣、多筆出選餐確認卡。
//   confirm=true（-N 過度簡略）：即使唯一候選也先出短確認卡（對，扣 N 克／不是），確認後才 update。
// 一律不碰別隻貓、不碰其他 foodType、不新增紀錄。
export async function handleFoodAdjust(env, event, pet, intent, actorId) {
  const db = env.DB;
  await ensureTaskSchema(db);
  if (!pet) { await replyOrPush(env, event, '找不到可以調整的食物紀錄'); return; }
  const foodType = intent.foodType;
  const amount = intent.amount;
  const mode = intent.mode === 'leftover' ? 'leftover' : 'subtract'; // 扣（相對）或 剩（原餵量−剩）
  const verb = mode === 'leftover' ? '剩' : '扣'; // 訊息用字
  const recent = (await getRecentLogsByPet(db, pet.petId, 30)) || [];
  const matches = recent.filter((l) => l.category === 'food' && !l.isDeleted && l.foodType === foodType);

  if (!matches.length) {
    await replyOrPush(env, event, `找不到可以調整的${foodType}紀錄。\n・想改最近一餐：直接打「${verb} ${amount}」\n・或到管家後台點那筆改`);
    return;
  }

  // 過度簡略（-N）或多筆候選 → 一律先確認/選餐，確認後才透過 fixPick 落地；不直接寫入。
  if (intent.confirm || matches.length > 1) {
    if (matches.length === 1) {
      const l = matches[0];
      const btns = [
        qrPost(`對，${verb} ${amount} 克`, `action=fixPick&logId=${encodeURIComponent(l.logId)}&amt=${amount}&mode=${mode}`, `${verb} ${amount} 克`),
        qrPost('不是', 'action=adjustCancel', '不是')
      ];
      await replyOrPushQuick(env, event, `你是要把最近一筆${foodType}${verb} ${amount} 克嗎？`, btns);
      return;
    }
    // 多筆合理候選：先列出候選餐次讓使用者選是哪一筆；每個按鈕已載明動作＝選定即確認。
    const btns = matches.slice(0, 8).map((l) => {
      const t = String(l.eventDateTime).slice(11, 16) || String(l.eventDateTime).slice(5, 10);
      const label = `${t} ${l.itemName || l.foodType} ${Math.round(Number(l.amount) || 0)}g`;
      return qrPost(label.slice(0, 20), `action=fixPick&logId=${encodeURIComponent(l.logId)}&amt=${amount}&mode=${mode}`, label);
    });
    await replyOrPushQuick(env, event, `有 ${matches.length} 筆${foodType}都對得上，你要調整哪一筆？（${verb} ${amount} 克）`, btns);
    return;
  }

  // 明確動詞＋唯一候選 → 直接套用（扣＝相對扣減；剩＝原餵量−剩、保留 served/leftover）
  await applyAdjustToLog(env, event, db, matches[0], { mode, amount }, actorId);
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
  if (last.category === 'weight') await resyncPetWeight(db, last.petId); // 目前體重回退上一筆
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

// 確認「改成 Xkg」的資料操作（可被 postback 與測試共用）：改最近一筆體重的 amount、保留原日期、resync 目前體重。
// 冪等：重複套用同一 logId 只是覆寫同值、不會多出紀錄。
export async function applyWeightModify(db, { logId, amount, ownerId, actorId }) {
  const log = await getLog(db, logId);
  if (!log || log.lineUserId !== ownerId || log.isDeleted || log.category !== 'weight') return { ok: false, reason: 'not_found' };
  if (!(Number(amount) > 0)) return { ok: false, reason: 'bad_amount' };
  const oldKg = log.amount;
  // 冪等／相同值：目標值與現值相同（標準化）→ 不重複更新、不動 updatedAt、不 resync
  if (weightEquals(oldKg, amount)) return { ok: true, unchanged: true, log, oldKg, newKg: Number(amount) };
  await updateLog(db, log.logId, { amount: Number(amount) }, actorId || ownerId);
  await recomputeDay(db, log.petId, String(log.eventDateTime).slice(0, 10));
  await resyncPetWeight(db, log.petId); // 改舊紀錄時，目前體重仍取真正最新那筆
  return { ok: true, log, oldKg, newKg: Number(amount) };
}

// 確認「記為今天的新體重」的資料操作：新增一筆 today weight log、resync 目前體重。
// 冪等：同一原訊息 smid 已建過就回 { ok:false, reason:'dup' }，重複點不會多記一筆。
export async function applyWeightAddToday(db, { petId, amount, smid, ownerId, actorId, nowDateTime }) {
  if (!(Number(amount) > 0)) return { ok: false, reason: 'bad_amount' };
  if (smid) {
    const dup = await db.prepare("SELECT logId FROM logs WHERE petId = ? AND category = 'weight' AND sourceMessageId = ? AND isDeleted = 0 LIMIT 1").bind(petId, smid).first();
    if (dup) return { ok: false, reason: 'dup', logId: dup.logId };
  }
  const now = nowDateTime || taipeiNowDateTime();
  const saved = await insertLog(db, {
    lineUserId: ownerId, petId, eventDateTime: now, category: 'weight',
    amount: Number(amount), unit: 'kg', note: '', sourceMessageId: smid || '', recordedBy: actorId || ownerId, source: 'line', updatedBy: actorId || ownerId
  });
  const summary = await recomputeDay(db, petId, now.slice(0, 10));
  await resyncPetWeight(db, petId);
  return { ok: true, saved, summary, date: now.slice(0, 10) };
}

// 「改最近一次體重」入口：多貓沒指定貓 → 先選貓；否則直接進修改確認卡（規格一、三）。
export async function handleWeightModify(env, event, { db, pet, pets, explicitPet, amount, lineUserId, ownerId, smid, baseUrl }) {
  if (!(Number(amount) > 0)) { await replyOrPush(env, event, '體重數字看起來怪怪的，請重新輸入一次（例如「改 6 公斤」）。'); return; }
  // 多貓且沒指定貓名 → 先選貓（規格三：改6公斤＋多貓＝先選貓），帶著金額與原訊息 id
  if (!explicitPet && pets.length > 1) {
    const btns = pets.slice(0, 12).map((p) => qrPost(p.petName, `action=weightPick&petId=${p.petId}&amt=${amount}&smid=${encodeURIComponent(smid)}`, p.petName));
    await replyOrPushQuick(env, event, `要修改哪隻貓的體重成 ${amount} 公斤？`, btns);
    return;
  }
  if (!pet) { await replyOrPush(env, event, '還沒有建立貓咪，先建檔再記體重喔。'); return; }
  await showWeightModifyConfirm(env, event, { db, pet, amount, smid });
}

// 顯示體重修改確認卡。
//  - 沒有既有體重 → 問是否記為今天（規格二）。
//  - 明確修改語意（ambiguous=false，預設）→ 只給「改成 Xkg／取消」，不給新增（規格一、四）。
//  - 語意模糊（ambiguous=true）且最近一筆非今天 → 才給三選一；最近一筆是今天則收回新增選項（同日護欄）。
export async function showWeightModifyConfirm(env, event, { db, pet, amount, smid, ambiguous = false }) {
  const latest = await getLatestWeightLog(db, pet.petId);
  const smidEnc = encodeURIComponent(smid || '');
  if (!latest) {
    const keys = `amt=${amount}&petId=${pet.petId}&smid=${smidEnc}`;
    await replyOrPushFlex(env, event, weightNoRecordFlex({ pet, amount, keys }),
      `${pet.petName}還沒有可以修改的體重紀錄，要把 ${formatWeightKg(amount)}kg 記為今天的新體重嗎？`);
    return;
  }
  // 相同值護欄：新值與最近一筆相同（標準化比較）→ 無效修改，不進確認、不動 log/updatedAt/pets、不 resync
  if (weightEquals(latest.amount, amount)) {
    await replyOrPush(env, event, `${pet.petName}最近一次體重已經是 ${formatWeightKg(latest.amount)}kg，不需要修改。`);
    return;
  }
  const latestIsToday = String(latest.eventDateTime).slice(0, 10) === taipeiToday();
  const allowAddNew = ambiguous && !latestIsToday; // 明確修改一律 false；模糊但最近一筆是今天也 false（不製造同日重複）
  const keys = `logId=${latest.logId}&old=${latest.amount}&amt=${amount}&petId=${pet.petId}&smid=${smidEnc}`;
  const fallback = allowAddNew
    ? `要怎麼處理${pet.petName}的 ${formatWeightKg(amount)} 公斤？最近一次 ${formatWeightKg(latest.amount)}kg（${String(latest.eventDateTime).slice(0, 10)}）。回覆「改成 ${formatWeightKg(amount)}kg／記為今天的新體重／取消」。`
    : `把${pet.petName}最近一次體重（${formatWeightKg(latest.amount)}kg）改成 ${formatWeightKg(amount)}kg？回覆「改成 ${formatWeightKg(amount)}kg／取消」。`;
  await replyOrPushFlex(env, event, weightModifyConfirmFlex({ pet, amount, latest, keys, allowAddNew }), fallback);
}

// §10 只有品牌名、沒有數字（例如「巔峰羊」）：若整句剛好精確命中已建立品項 → 直接問份量，
// 複用既有 recFoodG 克數快捷（唯一）／pickFood 選品項（多個同名），不把品牌名硬記成 0g、也不亂猜。
// 只在「精確命中已存在 food_item」時觸發（exactFoodMatches），所以不會把任意中文當品牌（見 §20 負向）。
// 回傳 true＝已接手回覆；false＝不是純品牌名，交回原本的 unknown 引導。
export async function handleBrandOnly(env, event, db, pet, ownerId, rawText) {
  const name = String(rawText || '').trim();
  if (!pet || !name) return false;
  if (/\d/.test(name)) return false; // 帶數字 → 交給 item_lookup／record，不歸這裡
  const foods = await listFoods(db, ownerId);
  const hits = exactFoodMatches(foods, name);
  if (hits.length === 1) {
    const f = hits[0];
    const items = [
      ...[5, 10, 15, 20, 30].map((n) => qrPost(String(n), `action=recFoodG&foodId=${f.foodId}&g=${n}`, `${f.displayName} ${n}g`)),
      qrPost('其他克數', `action=recFoodGother&foodId=${f.foodId}`, '其他克數')
    ];
    await replyOrPushQuick(env, event, `「${f.displayName}」這次吃了多少？點一下就記好（或直接打數字）`, items);
    return true;
  }
  if (hits.length > 1) {
    const btns = hits.slice(0, 10).map((f) => qrPost(String(f.displayName).slice(0, 20), `action=pickFood&foodId=${f.foodId}`, f.displayName));
    await replyOrPushQuick(env, event, '你是指哪一個？選好再問份量：', btns);
    return true;
  }
  return false;
}

export async function handleRecord(env, event, pet, record, lineUserId, opts = {}) {
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
    // 來源訊息 id：文字輸入用 event.message.id；按鈕/澄清完成（postback 無 message）可由呼叫端帶原訊息 id 進來，
    // 讓這次寫入的 log 仍能歸屬到原訊息（撤銷／冪等追溯用）。
    sourceMessageId: String(opts.sourceMessageId || event.message?.id || ''),
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
    let matched = matchFood(foods, record.itemName, record.foodType); // ①句中明確品牌永遠優先
    const sameType = foods.filter((food) => !food.isDeleted && food.foodType === record.foodType);
    // ②沒指定品牌（itemName 空／沒匹配）時，若家庭有為這個 foodType 設定「預設品項」→ 直接套用它，
    //   不出品牌確認卡、不改用系統粗估值。失效預設（已刪／跨家庭／類型不符）由 resolveDefaultFood 回 null 安全略過。
    if (!matched && !record.itemName) {
      const def = await resolveDefaultFood(db, lineUserId, record.foodType);
      if (def) matched = def;
    }
    // ③（產品規則）只輸入類型／口語別名（沒指定品牌）且沒有預設 → 不猜品牌：直接記 generic 類型、用系統粗估值。
    //   刻意「不再」因為該類型剛好有 1 個或多個 food_items 就自動套或強迫選——自動帶品牌只由「預設食物」負責。
    //   （下方 deferDisambig／品牌確認卡都改為只在「有打品名 record.itemName」時才觸發。）
    // multiRecord（deferDisambig）：打了品名卻對不到 → 不 silent 猜、不寫入，回報「這一段」需確認，
    // 讓呼叫端只對這一段出品項確認卡（同句其他已成功片段照記）。
    if (!matched && opts.deferDisambig && record.itemName && sameType.length >= 1) {
      const guess = guessFood(sameType, record.itemName, record.foodType);
      return {
        needsDisambig: true,
        disambig: {
          foodType: record.foodType, typedName: record.itemName,
          grams: Number(record.amount) || 0, addedWaterMl: Number(record.addedWaterMl) || 0,
          options: sameType, guessId: guess?.foodId || ''
        }
      };
    }
    // 其他 silent 來源（pickcatFor 多筆）沒辦法互動確認 → 用保守模糊比對自動對應最接近的同類型品項，
    // 避免整批卡住（卡片仍會顯示對應到的品名可核對）。
    if (!matched && opts.silent && sameType.length >= 1) matched = guessFood(sameType, record.itemName, record.foodType);
    // 打了品名/品牌卻對不到、但這個類型有可選品項 → 先停下來問是哪一個（品牌歧義），別默默記錯品牌。
    //   ★只在「有打品名 record.itemName」時才問；純類型輸入（乾乾5）不走這裡，改記 generic（見上方 ③）。
    //     forceRaw＝使用者已在確認卡按「就先記著不算熱量」；silent＝一則多筆，不做互動式確認。
    if (!matched && record.itemName && !record.forceRaw && !opts.silent && sameType.length >= 1) {
      const guess = guessFood(sameType, record.itemName, record.foodType);
      await replyOrPushFlex(env, event, foodDisambigFlex({
        pet, foodType: record.foodType, typedName: record.itemName,
        grams: Number(record.amount) || 0, addedWaterMl: Number(record.addedWaterMl) || 0,
        smid: String(event.message?.id || ''), options: sameType, guessId: guess?.foodId || ''
      }), `「${record.itemName}」對不到已建立的品項，請選正確的${record.foodType}，熱量才算得到。`);
      return { disambiguated: true };
    }
    if (matched) {
      log.foodId = matched.foodId;
      log.itemName = matched.displayName;
      // 對到既有品牌 → 沿用該品牌原本的類型與 foodId（不重複建立、也不把既有罐頭品牌在這筆改標成主食罐/副食罐）
      log.foodType = matched.foodType || record.foodType;
      const derived = deriveFoodFields(record.amount, log.foodType, matched);
      log.kcal = derived.kcal;
      log.waterMl = derived.waterMl;
      description = `${foodLabel(log.foodType, matched.displayName)} ${record.amount} g`;
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
    description = `體重 ${formatWeightKg(record.amount)} kg`;
    // 「目前體重」延後到 insert 之後用 resyncPetWeight 依「最新未刪除體重」回算，
    // 避免補記舊日期體重時把目前體重錯設成舊值（規格六）。
  } else {
    description = `備註：${record.note}`;
  }

  // 罐頭另外加水：不塞進主文字（會讓品名那行太長），改在下方獨立一行顯示；並另計一筆喝水，讓當天總水分正確
  const addedWaterMl = record.category === 'food' ? Number(record.addedWaterMl) || 0 : 0;

  const mainText = description;
  const subParts = [];
  const infoParts = [];
  if (log.kcal) infoParts.push(`${estimated ? '≈' : ''}${log.kcal} kcal`);
  if (record.category === 'food' && log.waterMl) infoParts.push(`含水 ${log.waterMl} ml`);
  if (infoParts.length) subParts.push(infoParts.join('・'));
  // 另外加水改由卡片渲染成「粗體、水色」的獨立一行（與食物同層級，方便對照有沒有算進去），不放進灰色小字
  if (record.dayOffset || record.time) {
    const eventDay = eventDateTime.slice(0, 10);
    const stamp = `記在 ${Number(eventDay.slice(5, 7))}月${Number(eventDay.slice(8, 10))}日 ${eventDateTime.slice(11)}`;
    description += `\n（${stamp}）`;
    subParts.push(stamp);
  }

  const savedLog = await insertLog(db, log);
  let addedWaterLog = null; // 這次操作若含加水，另建的喝水 log（其 id 要一起回傳，讓 savedLogIds 完整）
  // 罐頭另外加的水 → 另存一筆喝水（沿用已驗證的喝水計算，不動食物固形/熱量公式）
  if (addedWaterMl > 0) {
    addedWaterLog = await insertLog(db, {
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
  // 體重：insert 後依「最新未刪除體重」回算目前體重（新增一定是最新→等於這筆；補舊日期則仍取真正最新）
  if (record.category === 'weight') {
    try { await resyncPetWeight(db, pet.petId); } catch (error) { console.warn('resync weightKg failed:', error.message); }
  }
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

  let tip = ['water', 'food'].includes(record.category)
    ? '記錯了？點下面「改數量」就能改'
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
    return { mainText, summary, eventDate, savedLog, addedWaterLog };
  }
  // 體重新增：用專屬卡（改重量／刪除這筆／開啟照護站），文案與行為和「修改」明確區分（規格五）。
  if (record.category === 'weight') {
    const wSite = await siteLink(env, opts.baseUrl, lineUserId);
    const wCard = weightAddedFlex({ pet, amount: record.amount, logId: savedLog?.logId || '', summary, date: eventDate, siteUrl: wSite });
    await replyOrPushFlex(env, event, wCard, `已記錄・${pet?.petName || '貓貓'}\n體重 ${formatWeightKg(record.amount)} kg`);
    if (opts.baseUrl) {
      try { await ensurePersonalRichMenu(env, opts.baseUrl, lineUserId); } catch (error) { console.error('personal richmenu refresh failed:', error.message); }
    }
    return { mainText, summary, eventDate, savedLog, addedWaterLog };
  }
  // 單筆記錄：一律回完整卡片（不再忽大忽小分級）。純文字為 LINE 通知/無法顯示卡片時的備援。
  const fallbackText = recordReply(description, pet, summary, hints, eventDate);
  const card = recordFlex({
    pet, categoryKey, mainText,
    subText: subParts.join('\n'),
    addedWaterMl,
    summary, date: eventDate,
    logId: savedLog?.logId || '',
    // 撤銷範圍＝這次操作建立的全部 log。文字輸入有 message id → 用 smid token（多筆也不塞爆 postback）；
    // 按鈕盤等無 message 的來源 → 內嵌 ≤2 個 id（食物＋連動加水）。
    undoData: (() => {
      const mid = event.message?.id;
      if (mid) return `smid=${mid}`;
      const ids = [savedLog?.logId, addedWaterLog?.logId].filter(Boolean);
      return ids.length ? `ids=${ids.join(',')}` : '';
    })(),
    // 撤銷鈕文案用：這次操作實際建立的正式紀錄筆數（食物＋連動加水最多 2 筆）。
    // 走到單筆 recordFlex 時，這個 smid 就只有本次這些 log（多筆流程改走 multiRecordFlex/靜默彙整卡）。
    undoCount: [savedLog?.logId, addedWaterLog?.logId].filter(Boolean).length,
    hints, tip, siteUrl: await siteLink(env, opts.baseUrl, lineUserId),
    warnNoKcal: record.category === 'food' && noKcal, foodType: record.foodType || '',
    estimated: record.category === 'food' && estimated, estKcalPerG
  });
  await replyOrPushFlex(env, event, card, fallbackText);
  // 記錄是每天最高頻的互動：順手把專屬圖文選單保持在最新版（版本相符時只是一次快取讀取，不重建）
  if (opts.baseUrl) {
    try { await ensurePersonalRichMenu(env, opts.baseUrl, lineUserId); } catch (error) { console.error('personal richmenu refresh failed:', error.message); }
  }
  return { mainText, summary, eventDate, savedLog, addedWaterLog };
}

// 每位使用者專屬的圖文選單：把本人登入連結烤進「喵喵照護站／回診資訊」，
// 之後點一下就直接進自己的照護站、免打字免跳卡片。第一次登入時在背景建立，
// 建好就存進 app_kv 快取；只有連結失效才重建。全程 try/catch，不影響任何回覆。
// 選單設計版本：改了選單圖片或區塊配置就把這個數字 +1，
// 現有使用者的快取版本不符就會強制重建，改版才推得到所有人。
// v6：更新選單圖（更深色版，使用者指定）。按鈕送出詞與標籤維持一致。
// v8：LINE 體驗改版——記一筆／近七天記錄／出報告 ・ 管家後台／說明・怎麼記／照護月曆。
//     今日記錄→近七天記錄（既有 week 卡）、給醫生看→出報告（就醫／照護）、
//     照護站→管家後台、拿掉與趨勢／後台重複的「記錄回顧」，右下改為「照護月曆」（在對話看）。
// v9：重新綁定既有六格與 LIFF 直開；圖片與標籤不變。
const RICHMENU_VERSION = 9;

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
  const W = 2500, H = 1686, colW = Math.round(W / 3), rowH = H / 2;
  const cell = (c, r, action) => ({ bounds: { x: c * colW, y: r * rowH, width: c === 2 ? W - 2 * colW : colW, height: rowH }, action });
  const send = (text) => ({ type: 'message', text });
  const menu = {
    size: { width: W, height: H }, selected: true, name: `owner-${lineUserId.slice(-8)}`, chatBarText: '選單',
    // v8：上排＝每天要做的（留對話），下排＝查看與前往
    // 送出的字＝選單標籤（自動回覆一致）：記一筆／近七天記錄／出報告 ・ 說明・怎麼記／照護月曆
    areas: [
      cell(0, 0, send('記一筆')),                  // 記一筆 → 快速記錄選單
      cell(1, 0, send('近七天記錄')),              // 近七天記錄 → 近 7 天卡（week）
      cell(2, 0, send('出報告')),                  // 出報告 → 就醫／照護 二選一
      cell(0, 1, { type: 'uri', uri: site }),      // 管家後台（網站）
      cell(1, 1, send('怎麼記')),                  // 說明・怎麼記 → 可點範例卡
      cell(2, 1, send('照護月曆'))                 // 照護月曆 → 在對話看月曆
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

// 食物歷史 LINE 回覆（§13）：簡短、依類型分組、每組最多幾項＋總數，太多就導去照護站看完整。
// 純函式，方便單測；「查看完整」連結由 handleQuery 依 siteLink 補上。
// 品牌／品項名比對（給時間軸「品牌多候選」用）：顯示名／品牌／產品名任一含查詢字（或反向包含）即命中。
export function foodNameHit(food, q) {
  const qq = String(q || '').toLowerCase();
  if (!qq) return false;
  return [food.displayName, food.brand, food.productName].some((v) => {
    const s = String(v || '').toLowerCase();
    return s && (s.includes(qq) || qq.includes(s));
  });
}

// 食物時間軸 LINE 回覆（§4）：短、可掃視、逐筆（M/D HH:MM　名稱　實吃 g；有原餵/剩則附註）。最多先顯示 8 筆。
export function buildFoodTimelineResult(rows, { scope = 'recent', sinceDays = 30, label = '食物', petName = '' } = {}) {
  const who = petName ? `${petName} ` : '';
  const range = scope === 'all' ? '全部' : (Number(sinceDays) === 30 || !sinceDays ? '最近 30 天' : `最近 ${sinceDays} 天`);
  if (!rows.length) return `${who}${range}沒有找到${label}紀錄。`;
  const MAX = 8;
  const lines = [`${who}${range}的${label}紀錄：`];
  for (const r of rows.slice(0, MAX)) {
    const at = String(r.at || '');
    const md = at.length >= 10 ? `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))}` : at.slice(0, 10);
    const hm = at.slice(11, 16);
    const amt = `${Math.round(Number(r.amount) || 0)}g`;
    const served = Number(r.servedAmount) > 0
      ? `（原 ${Math.round(Number(r.servedAmount))}g，剩 ${Math.round(Number(r.leftoverAmount) || 0)}g）`
      : '';
    lines.push(`${md}${hm ? ' ' + hm : ''}　${r.name}　${amt}${served}`);
  }
  if (rows.length > MAX) lines.push('…還有更多，完整看管家後台');
  return lines.join('\n');
}

// 送出食物時間軸回覆：有資料 → Flex 逐筆＋每筆「修改」（§2）；無資料 → 文字。文字備援永遠附上（通知列/降級）。
async function replyFoodTimeline(env, event, baseUrl, lineUserId, rows, opts) {
  const body = buildFoodTimelineResult(rows, opts);
  if (!rows.length) { await replyOrPush(env, event, body); return; }
  const url = await siteLink(env, baseUrl, lineUserId, 'eaten');
  const range = opts.scope === 'all' ? '全部' : (Number(opts.sinceDays) === 30 || !opts.sinceDays ? '最近 30 天' : `最近 ${opts.sinceDays} 天`);
  const card = foodTimelineFlex({ rows, petName: opts.petName || '', label: opts.label || '食物', range, siteUrl: url });
  await replyOrPushFlex(env, event, card, url ? `${body}\n\n查看更多紀錄：${url}` : body);
}

export function buildFoodHistoryResult(rows, { scope = 'recent', sinceDays = 30, foodType = '', petName = '' } = {}) {
  const who = petName ? `${petName} ` : '';
  const rangeLabel = scope === 'all' ? '以前' : (Number(sinceDays) === 30 || !sinceDays ? '最近 30 天' : `最近 ${sinceDays} 天`);
  const typeLabel = foodType ? `的${foodType}` : '';
  if (!rows.length) {
    return `${who}${rangeLabel}${typeLabel}還沒有吃東西的紀錄喔 🐟\n記一筆試試：主食3、乾乾10、巔峰羊35`;
  }
  const order = [];
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.foodType)) { groups.set(r.foodType, []); order.push(r.foodType); }
    groups.get(r.foodType).push(r);
  }
  const MAX_PER_GROUP = 5;
  const lines = [`${who}${rangeLabel}${typeLabel}吃過：`];
  let truncated = 0;
  for (const ft of order) {
    const items = groups.get(ft);
    lines.push('', ft);
    for (const it of items.slice(0, MAX_PER_GROUP)) {
      const times = Number(it.times) > 1 ? `（${it.times} 次）` : '';
      lines.push(`・${it.name}${times}`);
    }
    if (items.length > MAX_PER_GROUP) truncated += items.length - MAX_PER_GROUP;
  }
  if (truncated > 0) lines.push('', `…還有 ${truncated} 項，完整清單看管家後台`);
  return lines.join('\n');
}

async function handleQuery(env, event, user, pet, query, baseUrl, lineUserId, ownerId = lineUserId, intent = {}) {
  const db = env.DB;
  const today = taipeiToday();

  if (query === 'foodHistory') {
    if (!pet) { await replyOrPush(env, event, '還沒有貓貓資料，先幫貓貓建個檔吧！'); return; }
    const rows = await getFoodHistory(db, pet.petId, { sinceDays: intent.sinceDays, foodType: intent.foodType || '' });
    const body = buildFoodHistoryResult(rows, { scope: intent.scope || 'recent', sinceDays: intent.sinceDays, foodType: intent.foodType || '', petName: pet.petName });
    const url = rows.length ? await siteLink(env, baseUrl, lineUserId) : '';
    await replyOrPush(env, event, url ? `${body}\n\n查看完整吃過紀錄：${url}` : body);
    return;
  }

  // 食物「時間軸」（何時吃什麼，逐筆）——與 foodHistory 聚合分流；只查 logs、多貓只查該貓。
  if (query === 'foodTimeline') {
    if (!pet) { await replyOrPush(env, event, '還沒有貓貓資料，先幫貓貓建個檔吧！'); return; }
    const scope = intent.scope || 'recent';
    const sinceDays = intent.sinceDays;
    const nameQuery = String(intent.nameQuery || '');
    // 品牌／品項名：先看家庭 food_items 是否有多款符合 → 多款不猜、先問是哪一款
    if (nameQuery) {
      const foods = await listFoods(db, ownerId);
      const hits = foods.filter((f) => !f.isDeleted && foodNameHit(f, nameQuery));
      if (hits.length > 1) {
        const btns = hits.slice(0, 8).map((f) => qrPost(String(f.displayName).slice(0, 20), `action=foodTimelinePick&foodId=${encodeURIComponent(f.foodId)}&petId=${encodeURIComponent(pet.petId)}&days=${Number(sinceDays) || 0}`, f.displayName));
        await replyOrPushQuick(env, event, `「${nameQuery}」有幾款，你是指哪一款？`, btns);
        return;
      }
      const foodId = hits.length === 1 ? hits[0].foodId : '';
      const label = hits.length === 1 ? hits[0].displayName : nameQuery;
      const rows = await getFoodTimeline(db, pet.petId, { sinceDays, foodId, nameQuery: foodId ? '' : nameQuery });
      await replyFoodTimeline(env, event, baseUrl, lineUserId, rows, { scope, sinceDays, label, petName: pet.petName });
      return;
    }
    const foodType = intent.foodType || '';
    const rows = await getFoodTimeline(db, pet.petId, { sinceDays, foodType });
    await replyFoodTimeline(env, event, baseUrl, lineUserId, rows, { scope, sinceDays, label: foodType || '食物', petName: pet.petName });
    return;
  }

  if (query === 'report') {
    const doctorUrl = await siteLink(env, baseUrl, lineUserId, 'doctor');
    const careUrl = await siteLink(env, baseUrl, lineUserId, 'care');
    await replyOrPushFlex(env, event, reportChoiceFlex(doctorUrl, careUrl),
      '這次要給誰？\n🏥 給醫生看：' + doctorUrl + '\n🐾 給照護者：' + careUrl);
    return;
  }

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
        + '① 直接說（最快，不用學格式）：\n　主食3・喝水30・嘔吐 白沫\n　沒吃完：乾乾減5\n\n'
        + '② 或點下面你常記的，一下就好：'
      : '點你常記的，一下就好 👇\n（也可直接說：主食3・喝水30・嘔吐 白沫）';
    await replyOrPushQuick(env, event, text, items);
    return;
  }

  if (query === 'recordButtons') {
    await replyOrPushFlex(env, event, recordMenuFlex(), recordPrompt(''));
    return;
  }

  // 模糊回顧詞（紀錄／記錄／最近／查看紀錄…）→「想看哪種紀錄？」入口卡，不直接猜類型。
  if (query === 'reviewMenu') {
    await track(db, lineUserId, 'menu_review');
    const url = await siteLink(env, baseUrl, lineUserId);
    await replyOrPushFlex(env, event, reviewMenuFlex(url),
      '想看哪種紀錄？\n· 吃過的食物 → 打「最近吃什麼」\n· 今日喝水／用藥／狀況 → 打「今天」\n· 完整紀錄 → 開管家後台');
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

  if (query === 'handoff') {
    const logs = await getLogsForDay(db, pet.petId, today);
    const data = buildHandoff(pet, logs);
    const dateLabel = shortDate(today);
    await replyOrPushFlex(env, event, handoffFlex(pet, dateLabel, data), handoffReply(pet, dateLabel, data));
    return;
  }

  if (query === 'week') {
    const rows = await getRecentSummaries(db, pet.petId, today, 7);
    // 折線圖（體重・水分・熱量）在後台趨勢頁；卡片底鈕一鍵直接開那頁
    const trendUrl = await siteLink(env, baseUrl, lineUserId, 'trend');
    await replyOrPushFlex(env, event, weekFlex(pet.petName, rows, trendUrl), weekReply(pet.petName, rows));
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
