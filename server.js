import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

loadDotEnv_();

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || '',
  appsScriptApiUrl: process.env.APPS_SCRIPT_API_URL || '',
  appsScriptApiToken: process.env.APPS_SCRIPT_API_TOKEN || ''
};

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

  const response = await fetch(CONFIG.appsScriptApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || `Apps Script error ${response.status}`);
  }
  return data;
}

async function replyLineText(replyToken, text) {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.lineChannelAccessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed ${response.status}: ${body}`);
  }
}

async function processTextEvent(event) {
  try {
    console.log(
      '[line] incoming text:',
      JSON.stringify({
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
    if (event.replyToken && result.replyText) {
      await replyLineText(event.replyToken, result.replyText);
      console.log('[line] reply sent');
    }
  } catch (error) {
    console.error('Webhook handling failed:', error);
  }
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
    queueMicrotask(() => {
      processTextEvent(event);
    });
  }

  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'oyster-care-line-backend'
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
