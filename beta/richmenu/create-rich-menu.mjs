// 建立並套用 LINE 圖文選單（Phase 8）
// 用法：
//   export LINE_CHANNEL_ACCESS_TOKEN=...   # Beta channel 的 access token
//   node richmenu/create-rich-menu.mjs richmenu/richmenu.png
//
// 會依序：建立 rich menu → 上傳圖片 → 設為所有使用者的預設選單，
// 並列出/刪除舊的同名選單避免堆積。

import { readFile } from 'node:fs/promises';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error('請先設定 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}
const imagePath = process.argv[2] || 'richmenu/richmenu.png';
const MENU_NAME = 'cat-care-beta-main';
// 與 Worker 使用同一個 LIFF 設定；備援選單也直接開登入，不經訊息卡。
const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const liffId = process.env.LIFF_ID || config.match(/^LIFF_ID\s*=\s*"([^"]+)"/m)?.[1];
const siteUrl = liffId ? `https://liff.line.me/${liffId}` : 'https://cat-care-beta.hannahchen6134.workers.dev/';

const W = 2500;
const H = 1686;
const colW = Math.round(W / 3); // 833
const rowH = H / 2;             // 843

const cell = (col, row, action) => ({
  bounds: { x: col * colW, y: row * rowH, width: col === 2 ? W - 2 * colW : colW, height: rowH },
  action
});
const send = (text) => ({ type: 'message', text });

const menu = {
  size: { width: W, height: H },
  selected: true,
  name: MENU_NAME,
  chatBarText: '選單',
  // v8：上排＝每天要做的（留對話），下排＝查看與前往
  // 註：實際線上用的是 index.js 的「每人專屬選單」ensurePersonalRichMenu（會烤本人登入連結）；
  //     這支靜態版僅作備援／初始化，送出詞與標籤需與專屬版一致。
  areas: [
    cell(0, 0, send('記一筆')),                  // 記一筆
    cell(1, 0, send('近七天記錄')),              // 近七天記錄（week 卡）
    cell(2, 0, send('出報告')),                  // 出報告（就醫／照護）
    // 管家後台：直接開網站（回訪者已登入一點就進；新朋友會看到登入引導頁）
    cell(0, 1, { type: 'uri', uri: siteUrl }),
    cell(1, 1, send('怎麼記')),                  // 說明・怎麼記
    // 照護月曆：直接在對話裡回月曆卡（不用開網站，點日期看那天細節）
    cell(2, 1, send('照護月曆'))
  ]
};

const api = async (url, options) => {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} → ${response.status}: ${body}`);
  return body ? JSON.parse(body) : {};
};

// 移除舊的同名選單
const { richmenus = [] } = await api('https://api.line.me/v2/bot/richmenu/list', { method: 'GET' });
for (const existing of richmenus) {
  if (existing.name === MENU_NAME) {
    await api(`https://api.line.me/v2/bot/richmenu/${existing.richMenuId}`, { method: 'DELETE' });
    console.log('已刪除舊選單', existing.richMenuId);
  }
}

const { richMenuId } = await api('https://api.line.me/v2/bot/richmenu', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(menu)
});
console.log('已建立選單', richMenuId);

const image = await readFile(imagePath);
const contentType = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
await api(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST',
  headers: { 'Content-Type': contentType },
  body: image
});
console.log('已上傳圖片', imagePath);

await api(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
console.log('已設為預設選單，完成 ✓');
