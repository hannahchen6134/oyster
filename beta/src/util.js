// 共用小工具：時間（Asia/Taipei，台灣無日光節約，直接用 UTC+8 位移）、ID 產生

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function taipeiDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + TAIPEI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

// YYYY-MM-DD（台北時間的今天）
export function taipeiToday() {
  const p = taipeiDateParts();
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// YYYY-MM-DD HH:MM（台北時間的現在）
export function taipeiNowDateTime() {
  const p = taipeiDateParts();
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// dateStr: YYYY-MM-DD，回傳位移 n 天後的 YYYY-MM-DD
export function addDays(dateStr, n) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + n));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export function isValidDateTime(value) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value || ''));
}

export function newId() {
  return crypto.randomUUID();
}

export function newToken() {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
