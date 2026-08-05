// 網站冒煙測試：index.html 是手改的大檔，最容易「改一改語法壞掉、整頁白畫面」。
// 這裡不開瀏覽器，而是：(1) 用 new Function 解析 <script>，語法錯誤會當場丟；
// (2) 檢查關鍵畫面元素 id 還在，避免誤刪。抓「整頁壞掉」這類最嚴重的網站回歸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, '../public/index.html'), 'utf8');

test('index.html 的 <script> 通過 JS 語法解析（不會整頁壞掉）', () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1, '找不到內嵌 <script>');
  for (const body of blocks) {
    // new Function 只解析＋建立函式、不執行；語法錯誤會在這裡丟 SyntaxError
    assert.doesNotThrow(() => new Function(body), 'index.html 的 JS 有語法錯誤');
  }
});

test('關鍵畫面元素 id 都在（手改 HTML 時誤刪會被抓到）', () => {
  const need = [
    'appView', 'todayView', 'calendarView', 'trendView', 'settingsView',
    'calGrid', 'dayPicker', 'todayProgress', 'confirmList', 'settingsList',
    'printReport', 'reportPrintBtn'
  ];
  for (const id of need) assert.ok(html.includes(`id="${id}"`), `缺少關鍵元素 #${id}`);
});

test('A4 報告：列印樣式只作用於 @media print、預設隱藏，手機/網頁版不受影響', () => {
  // #printReport 預設 display:none（畫面上不顯示）
  assert.ok(/#printReport\s*\{\s*display:\s*none/.test(html), '#printReport 預設必須隱藏');
  // A4 版面尺寸只出現在 @media print 區塊內（避免 210mm 套到手機頁）
  const printBlock = html.slice(html.indexOf('@media print'), html.indexOf('@media (max-width'));
  assert.ok(printBlock.includes('size: A4 portrait'), 'A4 @page 設定在 @media print');
  assert.ok(printBlock.includes('210mm') && printBlock.includes('297mm'), 'A4 尺寸在 print 區塊');
  // 210mm 不得出現在 @media print 以外（不會套到一般畫面）
  const nonPrint = html.replace(printBlock, '');
  assert.ok(!nonPrint.includes('210mm'), '210mm 不得出現在列印區塊外');
  // 模組有被引入
  assert.ok(html.includes('src="/a4-report.js"'), '需引入 a4-report.js 模組');
});
