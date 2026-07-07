const APPS_SCRIPT_RETRY_DELAYS_MS = [0, 1200, 3000];
const LINE_API_RETRY_DELAYS_MS = [0, 800, 2000];
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_EARLY_ACK_TEXT = "已收到，整理中...";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "oyster-care-line-cloudflare-worker",
        now: new Date().toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return jsonResponse({ ok: false, message: "Not found" }, 404);
  }
};

async function handleWebhook(request, env, ctx) {
  const signature = request.headers.get("x-line-signature") || "";
  const rawBody = await request.text();

  if (!(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET || ""))) {
    return jsonResponse({ ok: false, message: "Invalid signature" }, 401);
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    return jsonResponse({ ok: false, message: "Invalid JSON body" }, 400);
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const textEvents = events.filter(
    (event) => event && event.type === "message" && event.message && event.message.type === "text"
  );

  const earlyAckJobs = textEvents.map((event) => sendEarlyAckIfPossible(event, env));
  const earlyAckResults = await Promise.all(earlyAckJobs);

  ctx.waitUntil(
    Promise.all(
      textEvents.map((event, index) =>
        processTextEvent({
          event,
          env,
          earlyAckSent: Boolean(earlyAckResults[index])
        })
      )
    )
  );

  return jsonResponse({
    ok: true,
    queuedEvents: textEvents.length
  });
}

async function processTextEvent({ event, env, earlyAckSent }) {
  const messageText = String(event?.message?.text || "");
  const targetId = getPushTargetId(event);

  console.log(
    JSON.stringify({
      step: "incoming_text",
      messageId: String(event?.message?.id || ""),
      sourceType: String(event?.source?.type || ""),
      text: messageText
    })
  );

  try {
    const result = await saveLineMessageToAppsScript(event, env);
    const replyText = String(result?.replyText || "").trim();

    console.log(
      JSON.stringify({
        step: "apps_script_saved",
        ok: Boolean(result?.ok),
        hasReplyText: Boolean(replyText)
      })
    );

    if (!replyText) {
      return;
    }

    if (earlyAckSent) {
      if (!targetId) {
        console.warn("skip push summary: no push target after early ack");
        return;
      }
      await pushLineText(targetId, replyText, env);
      console.log(JSON.stringify({ step: "summary_sent", strategy: "push_after_ack" }));
      return;
    }

    if (event?.replyToken) {
      try {
        await replyLineText(event.replyToken, replyText, env);
        console.log(JSON.stringify({ step: "summary_sent", strategy: "reply_direct" }));
        return;
      } catch (error) {
        console.warn(`reply summary failed: ${error.message}`);
      }
    }

    if (targetId) {
      await pushLineText(targetId, replyText, env);
      console.log(JSON.stringify({ step: "summary_sent", strategy: "push_fallback" }));
      return;
    }

    console.warn("skip summary: no reply token and no push target");
  } catch (error) {
    console.error(
      JSON.stringify({
        step: "process_error",
        message: error.message,
        text: messageText
      })
    );
  }
}

async function saveLineMessageToAppsScript(event, env) {
  const body = new URLSearchParams({
    action: "saveLineMessage",
    apiToken: String(env.APPS_SCRIPT_API_TOKEN || ""),
    messageText: String(event?.message?.text || ""),
    timestamp: String(event?.timestamp || ""),
    replyToken: String(event?.replyToken || ""),
    sourceType: String(event?.source?.type || ""),
    userId: String(event?.source?.userId || ""),
    groupId: String(event?.source?.groupId || ""),
    roomId: String(event?.source?.roomId || ""),
    messageId: String(event?.message?.id || "")
  });

  const response = await fetchWithRetry(
    String(env.APPS_SCRIPT_API_URL || ""),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body
    },
    APPS_SCRIPT_RETRY_DELAYS_MS,
    "Apps Script"
  );

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || `Apps Script error ${response.status}`);
  }

  return data;
}

async function sendEarlyAckIfPossible(event, env) {
  const replyToken = String(event?.replyToken || "").trim();
  if (!replyToken) return false;

  try {
    await replyLineText(
      replyToken,
      String(env.EARLY_ACK_TEXT || DEFAULT_EARLY_ACK_TEXT),
      env
    );
    console.log(JSON.stringify({ step: "early_ack_sent" }));
    return true;
  } catch (error) {
    console.warn(`early ack failed: ${error.message}`);
    return false;
  }
}

async function replyLineText(replyToken, text, env) {
  const response = await fetchWithRetry(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: buildLineHeaders(env),
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }]
      })
    },
    LINE_API_RETRY_DELAYS_MS,
    "LINE reply"
  );

  if (!response.ok) {
    throw new Error(`LINE reply failed ${response.status}: ${await response.text()}`);
  }
}

async function pushLineText(targetId, text, env) {
  const response = await fetchWithRetry(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: buildLineHeaders(env),
      body: JSON.stringify({
        to: targetId,
        messages: [{ type: "text", text }]
      })
    },
    LINE_API_RETRY_DELAYS_MS,
    "LINE push"
  );

  if (!response.ok) {
    throw new Error(`LINE push failed ${response.status}: ${await response.text()}`);
  }
}

function buildLineHeaders(env) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(env.LINE_CHANNEL_ACCESS_TOKEN || "")}`
  };
}

function getPushTargetId(event) {
  return String(
    event?.source?.userId ||
      event?.source?.groupId ||
      event?.source?.roomId ||
      ""
  ).trim();
}

async function fetchWithRetry(url, init, retryDelaysMs, label) {
  let lastError = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      const response = await fetchWithTimeout(url, init, REQUEST_TIMEOUT_MS);
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

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetryStatus(statusCode) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digestBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const digestBase64 = arrayBufferToBase64(digestBuffer);
  return digestBase64 === signature;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
