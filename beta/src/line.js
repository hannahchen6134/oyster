// LINE Messaging API：驗簽、回覆、推播、取得使用者名稱
// Beta 設計原則：後端夠快，一律優先用免費的 reply，push 僅作為備援。

const LINE_API_BASE = 'https://api.line.me/v2/bot';
const MAX_TEXT_LENGTH = 4900;

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
  const response = await fetch(`${LINE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN || ''}`
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

export async function getProfile(env, userId) {
  try {
    const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN || ''}` }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}
