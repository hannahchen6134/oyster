// 用預裝的 Chromium 把 richmenu.html 渲染成 2500×1686 的選單 PNG。
// 用法：node richmenu/render.mjs [輸入.html] [輸出.png]
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const input = resolve(process.argv[2] || join(dir, 'richmenu.html'));
const output = resolve(process.argv[3] || join(dir, '..', 'public', 'richmenu.png'));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1250, height: 843 }, deviceScaleFactor: 2 });
await page.goto('file://' + input);
await page.waitForTimeout(300);
await page.screenshot({ path: output, clip: { x: 0, y: 0, width: 1250, height: 843 } });
await browser.close();
console.log('rendered →', output);
