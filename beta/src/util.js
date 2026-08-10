// 共用小工具：時間（Asia/Taipei，台灣無日光節約，直接用 UTC+8 位移）、ID 產生

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 體重統一顯示規則（唯一真源）：最多兩位小數、移除尾端多餘的 0、不擅自降低使用者輸入精度。
// 體重是健康追蹤資料——嚴禁 toFixed(1)／四捨五入到一位，4.27 必須顯示 4.27。
// 註：public/index.html 與 public/a4-report.js 為瀏覽器包、無法 import 本檔，需各自保留同規則的複本。
export function formatWeightKg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100); // 例：4→"4"、4.2→"4.2"、4.20→"4.2"、4.27→"4.27"、4.25→"4.25"
}

// 體重相等比較（標準化到兩位小數）：4.2 與 4.20 相同、4.27 與 4.270 相同，不因字串格式誤判。
// 用於「相同值不需修改」護欄與確認鈕冪等（避免無效修改、不動 updatedAt）。
export function weightEquals(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 100) === Math.round(y * 100);
}

// 報告截圖是否已過期（預設建立後 6 小時失效）。即使 D1 尚未被 cron 實體清除，過期就不再供圖。
// createdAt 為 ISO 字串；壞掉/缺失一律視為過期（安全預設，不供圖）。
export function shotExpired(createdAtIso, nowMs = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000) {
  const t = Date.parse(String(createdAtIso || ''));
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeMs;
}

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
