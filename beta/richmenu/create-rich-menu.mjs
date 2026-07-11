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
  areas: [
    cell(0, 0, send('紀錄')),
    cell(1, 0, send('今天')),
    cell(2, 0, send('回診摘要')),
    // 喵喵照護站：直接開網站（回訪者已登入一點就進；新朋友會看到登入引導頁）
    cell(0, 1, { type: 'uri', uri: 'https://cat-care-beta.hannahchen6134.workers.dev/' }),
    cell(1, 1, send('月曆')),
    cell(2, 1, send('安心上手'))
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
