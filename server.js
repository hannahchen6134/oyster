import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

loadDotEnv_();

const DEPRECATED_APPS_SCRIPT_URLS = new Set([
  'https://script.google.com/macros/s/AKfycbwlJl-3pZQoEK_Ly8BV9bq9STg5HonveFkm9bUCPL1FOgIQ9l79wSBiXgsGaOUp9yG4/exec',
  'https://script.google.com/macros/s/AKfycbyJXkvmRNcMvkuCUoBQcbnrkWaXrL3gdp_bgv0igfiZ49_YZQR0aXo1vfFMVoYiMtgy3Q/exec',
  'https://script.google.com/macros/s/AKfycbxQTFyQ7PBl1SD6IkKk5_dYRixGuzKMYZfdEXs4HxsRa6TSu_XekY_kqUphTC2H29Df2A/exec'
]);
const CURRENT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxAtjdHf6slobcUIt9FnO7P4Nxof21nWvX04pQrb_7ae-wur19phGk-C8Tfo3xXJ5G3nQ/exec';

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || '',
  appsScriptApiUrl: normalizeAppsScriptUrl_(process.env.APPS_SCRIPT_API_URL || ''),
  appsScriptApiToken: process.env.APPS_SCRIPT_API_TOKEN || ''
};

const REQUEST_TIMEOUT_MS = 15000;
const APPS_SCRIPT_RETRY_DELAYS_MS = [0, 1200, 3000];
const LINE_REPLY_RETRY_DELAYS_MS = [0, 800];
const LINE_PUSH_RETRY_DELAYS_MS = [0, 800, 2000];
const processedEventKeys = new Map();
const pendingEvents = [];
let isQueueRunning = false;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyLineSignature(rawBody, signature) {
  if (!CONFIG.lineChannelSecret || !signature) return false;
  const digest = crypto
    .createHmac('sha256', CONFIG.lineChannelSecret)
    .update(rawBody)
    .digest('base64');
  return digest === signature;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(statusCode) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function fetchWithRetry(url, options, retryDelaysMs, label) {
  let lastError = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.ok || !shouldRetryStatus(response.status) || attempt === retryDelaysMs.length - 1) {
        return response;
      }

      lastError = new Error(`${label} temporary failure ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retryDelaysMs.length - 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error(`${label} failed`);
}

function getEventKey(event) {
  return [
    String(event.timestamp || ''),
    String(event.replyToken || ''),
    String(event.source?.type || ''),
    String(event.source?.userId || ''),
    String(event.source?.groupId || ''),
    String(event.source?.roomId || ''),
    String(event.message?.id || ''),
    String(event.message?.text || '')
  ].join('|');
}

function rememberProcessedEvent(eventKey) {
  processedEventKeys.set(eventKey, Date.now());
  pruneProcessedEvents();
}

function hasProcessedEvent(eventKey) {
  pruneProcessedEvents();
  return processedEventKeys.has(eventKey);
}

function pruneProcessedEvents() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 12;
  for (const [eventKey, timestamp] of processedEventKeys.entries()) {
    if (timestamp < cutoff) {
      processedEventKeys.delete(eventKey);
    }
  }
}

async function saveLineMessageToAppsScript(event) {
  const body = new URLSearchParams({
    action: 'saveLineMessage',
    apiToken: CONFIG.appsScriptApiToken,
    messageText: String(event.message?.text || ''),
    timestamp: String(event.timestamp || ''),
    replyToken: String(event.replyToken || ''),
    sourceType: String(event.source?.type || ''),
    userId: String(event.source?.userId || ''),
    groupId: String(event.source?.groupId || ''),
    roomId: String(event.source?.roomId || '')
  });

  const response = await fetchWithRetry(CONFIG.appsScriptApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body
  }, APPS_SCRIPT_RETRY_DELAYS_MS, 'Apps Script');

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || `Apps Script error ${response.status}`);
  }
  return data;
}

async function replyLineText(replyToken, text) {
  const response = await fetchWithRetry('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.lineChannelAccessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  }, LINE_REPLY_RETRY_DELAYS_MS, 'LINE reply');

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed ${response.status}: ${body}`);
  }
}

function getPushTargetId(event) {
  return String(
    event?.source?.userId ||
    event?.source?.groupId ||
    event?.source?.roomId ||
    ''
  ).trim();
}

async function pushLineText(targetId, text) {
  const response = await fetchWithRetry('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.lineChannelAccessToken}`
    },
    body: JSON.stringify({
      to: targetId,
      messages: [{ type: 'text', text }]
    })
  }, LINE_PUSH_RETRY_DELAYS_MS, 'LINE push');

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE push failed ${response.status}: ${body}`);
  }
}

async function sendLineSummaryWithFallback(event, text) {
  const targetId = getPushTargetId(event);

  if (event.replyToken) {
    try {
      await replyLineText(event.replyToken, text);
      console.log('[line] reply sent');
      return 'reply';
    } catch (error) {
      console.warn('[line] reply failed, trying push fallback:', error.message);
    }
  }

  if (targetId) {
    await pushLineText(targetId, text);
    console.log('[line] push fallback sent');
    return 'push';
  }

  throw new Error('No replyToken or push target available');
}

async function processTextEvent(job) {
  const { event, eventKey } = job;

  try {
    console.log(
      '[line] incoming text:',
      JSON.stringify({
        eventKey,
        timestamp: event.timestamp || '',
        sourceType: event.source?.type || '',
        text: String(event.message?.text || '')
      })
    );
    const result = await saveLineMessageToAppsScript(event);
    console.log(
      '[line] apps-script saved:',
      JSON.stringify({
        ok: !!result.ok,
        replyText: String(result.replyText || '').slice(0, 120)
      })
    );
    if (result.replyText) {
      const strategy = await sendLineSummaryWithFallback(event, result.replyText);
      console.log('[line] summary delivery strategy:', strategy);
    }

    rememberProcessedEvent(eventKey);
  } catch (error) {
    console.error('Webhook handling failed:', eventKey, error);
  }
}

async function runPendingQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;

  try {
    while (pendingEvents.length > 0) {
      const job = pendingEvents.shift();
      await processTextEvent(job);
    }
  } finally {
    isQueueRunning = false;
    if (pendingEvents.length > 0) {
      void runPendingQueue();
    }
  }
}

function enqueueEvent(event) {
  const eventKey = getEventKey(event);

  if (hasProcessedEvent(eventKey) || pendingEvents.some((job) => job.eventKey === eventKey)) {
    console.log('[line] duplicated event skipped:', eventKey);
    return;
  }

  pendingEvents.push({ event, eventKey });
  void runPendingQueue();
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifyLineSignature(rawBody, signature)) {
    return sendJson(res, 401, { ok: false, message: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody.toString('utf8') || '{}');
  const events = Array.isArray(payload.events) ? payload.events : [];

  for (const event of events) {
    if (!event || event.type !== 'message' || event.message?.type !== 'text') continue;
    enqueueEvent(event);
  }

  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'oyster-care-line-backend',
      queueLength: pendingEvents.length,
      processedEventCacheSize: processedEventKeys.size
    });
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    try {
      return await handleWebhook(req, res);
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  return sendJson(res, 404, { ok: false, message: 'Not found' });
});

server.listen(CONFIG.port, () => {
  console.log(`oyster-care-line-backend listening on ${CONFIG.port}`);
});

function normalizeAppsScriptUrl_(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return CURRENT_APPS_SCRIPT_URL;
  if (DEPRECATED_APPS_SCRIPT_URLS.has(normalized)) return CURRENT_APPS_SCRIPT_URL;
  return normalized;
}

function loadDotEnv_() {
  var envPath = new URL('./.env', import.meta.url);
  if (!fs.existsSync(envPath)) return;

  var content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(function(line) {
    var trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    var separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    var key = trimmed.slice(0, separatorIndex).trim();
    var value = trimmed.slice(separatorIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}
