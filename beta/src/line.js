// LINE Messaging API：驗簽、回覆、推播、取得使用者名稱
// Beta 設計原則：後端夠快，一律優先用免費的 reply，push 僅作為備援。

import { appKvGet, appKvSet } from './db.js';

const LINE_API_BASE = 'https://api.line.me/v2/bot';
const LINE_OAUTH_URL = 'https://api.line.me/v2/oauth/accessToken';
const MAX_TEXT_LENGTH = 4900;

// ── 存取權杖自動換發（永不因權杖過期而停止回覆）──────────────────────────
// 設計原則：只要設定了 LINE_CHANNEL_ID + LINE_CHANNEL_SECRET，Worker 會自己向
// LINE 換發 30 天效期的權杖、快取在 D1、到期前 3 天自動換新。任何一步失敗，
// 一律退回原本的固定權杖 env.LINE_CHANNEL_ACCESS_TOKEN——確保行為不會比現在更差。
// 未設定 Channel ID 時，完全沿用固定權杖（與過去行為相同）。
const TOKEN_KV_KEY = 'line_access_token';
const REFRESH_BEFORE_MS = 3 * 24 * 60 * 60 * 1000; // 到期前 3 天就換新
let cachedToken = null; // 單一 isolate 內記憶：{ token, expiresAt(ms) }

async function mintToken(env) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(env.LINE_CHANNEL_ID || ''),
    client_secret: String(env.LINE_CHANNEL_SECRET || '')
  });
  const res = await fetch(LINE_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`mint token failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = String(data.access_token || '');
  if (!token) throw new Error('mint token: empty access_token');
  return { token, expiresAt: Date.now() + Number(data.expires_in || 0) * 1000 };
}

// 是否啟用自動換發（有 Channel ID + Secret + DB 才啟用）
function selfRenewEnabled(env) {
  return Boolean(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET && env.DB);
}

export async function getAccessToken(env) {
  if (!selfRenewEnabled(env)) return env.LINE_CHANNEL_ACCESS_TOKEN || '';
  try {
    const now = Date.now();
    if (cachedToken?.token && cachedToken.expiresAt - now > REFRESH_BEFORE_MS) {
      return cachedToken.token;
    }
    const stored = await appKvGet(env.DB, TOKEN_KV_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token && parsed.expiresAt - now > REFRESH_BEFORE_MS) {
        cachedToken = parsed;
        return parsed.token;
      }
    }
    const minted = await mintToken(env);
    cachedToken = minted;
    await appKvSet(env.DB, TOKEN_KV_KEY, JSON.stringify(minted));
    return minted.token;
  } catch (error) {
    console.error('getAccessToken self-renew failed, fallback to static token:', error.message);
    return env.LINE_CHANNEL_ACCESS_TOKEN || '';
  }
}

// 供每日 cron 呼叫：主動確認/換新權杖，回報狀態（不外洩權杖本身）
export async function checkAccessToken(env) {
  const staticToken = env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!selfRenewEnabled(env)) {
    return { mode: 'static', hasStatic: Boolean(staticToken) };
  }
  const token = await getAccessToken(env);
  const usingStatic = token === staticToken;
  const expiresInDays = cachedToken?.expiresAt
    ? Math.round((cachedToken.expiresAt - Date.now()) / 86400000)
    : null;
  return { mode: usingStatic ? 'static-fallback' : 'self-renew', hasStatic: Boolean(staticToken), expiresInDays };
}

export async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return arrayBufferToBase64(digest) === signature;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function truncate(text) {
  const value = String(text || '');
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
}

async function callLineApi(env, path, body) {
  const token = await getAccessToken(env);
  const response = await fetch(`${LINE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`LINE API ${path} failed ${response.status}: ${await response.text()}`);
  }
  return response;
}

export async function replyText(env, replyToken, text) {
  await callLineApi(env, '/message/reply', {
    replyToken,
    messages: [{ type: 'text', text: truncate(text) }]
  });
}

export async function pushText(env, to, text) {
  await callLineApi(env, '/message/push', {
    to,
    messages: [{ type: 'text', text: truncate(text) }]
  });
}

export async function replyMessages(env, replyToken, messages) {
  await callLineApi(env, '/message/reply', { replyToken, messages });
}

export async function pushMessages(env, to, messages) {
  await callLineApi(env, '/message/push', { to, messages });
}

// Flex 卡片備援鏈：reply 卡片 → reply 純文字 → push 卡片 → push 純文字
export async function replyOrPushFlex(env, event, flexMessage, fallbackText) {
  const targetId = String(event?.source?.userId || '').trim();
  if (event?.replyToken) {
    try {
      await replyMessages(env, event.replyToken, [flexMessage]);
      return;
    } catch (error) {
      console.warn('flex reply failed:', error.message);
      try {
        await replyMessages(env, event.replyToken, [{type:'text',text:truncate(fallbackText),...(flexMessage.quickReply?{quickReply:flexMessage.quickReply}:{})}]);
        return;
      } catch (textError) {
        console.warn('text reply failed too:', textError.message);
      }
    }
  }
  if (!targetId) return;
  try {
    await pushMessages(env, targetId, [flexMessage]);
  } catch (error) {
    console.warn('flex push failed, fallback to text:', error.message);
    await pushMessages(env, targetId, [{type:'text',text:truncate(fallbackText),...(flexMessage.quickReply?{quickReply:flexMessage.quickReply}:{})}]);
  }
}

// 帶 Quick Reply 的文字訊息（鍵盤上方一排大圓鈕，最直覺的點按；reply 失敗改 push）
export async function replyOrPushQuick(env, event, text, items) {
  const msg = { type: 'text', text: truncate(text), quickReply: { items } };
  const targetId = String(event?.source?.userId || '').trim();
  if (event?.replyToken) {
    try { await replyMessages(env, event.replyToken, [msg]); return; }
    catch (error) { console.warn('quick reply failed, fallback push:', error.message); }
  }
  if (targetId) await pushMessages(env, targetId, [msg]);
}

// reply 失敗（例如 token 過期）時改用 push 備援
export async function replyOrPush(env, event, text) {
  const targetId = String(event?.source?.userId || '').trim();
  if (event?.replyToken) {
    try {
      await replyText(env, event.replyToken, text);
      return;
    } catch (error) {
      console.warn('reply failed, fallback to push:', error.message);
    }
  }
  if (targetId) await pushText(env, targetId, text);
}

// 「管家處理中…」載入動畫（免費、不算一則訊息、只在 1:1 聊天有效）：
// 在進 parser 前先亮一顆動態點點，回覆（已記錄卡）一到就自動消失，做出「處理中→已記錄」的體感。
// 失敗一律吞掉：這只是視覺提示，不能影響任何實際回覆。
export async function showLoadingAnimation(env, chatId, loadingSeconds = 5) {
  const to = String(chatId || '').trim();
  if (!to) return;
  try {
    // 秒數需為 5 的倍數、上限 60；夾在合理範圍
    const secs = Math.max(5, Math.min(60, Math.round(loadingSeconds / 5) * 5));
    await callLineApi(env, '/chat/loading/start', { chatId: to, loadingSeconds: secs });
  } catch (error) {
    console.warn('loading animation failed (non-blocking):', error.message);
  }
}

export async function getProfile(env, userId) {
  try {
    const token = await getAccessToken(env);
    const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}
