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
    'a4Export', 'reportSaveBtn', 'reportRangeChips'
  ];
  for (const id of need) assert.ok(html.includes(`id="${id}"`), `缺少關鍵元素 #${id}`);
});

test('A4 匯出：離屏容器 #a4Export 放畫面外、模組已引入、且移除列印 A4 按鈕', () => {
  // #a4Export 必須是離屏（不影響手機/網頁版）——position:fixed + 大負左位移
  const m = html.match(/#a4Export\s*\{[^}]*\}/);
  assert.ok(m, '需有 #a4Export 樣式');
  assert.ok(/position:\s*fixed/.test(m[0]) && /left:\s*-\d{5,}px/.test(m[0]), '#a4Export 必須離屏（fixed + 大負 left）');
  // 已改為單一「存成照片給醫生」，移除「列印／下載 A4」按鈕
  assert.ok(!html.includes('reportPrintBtn'), '不得再有列印 A4 按鈕');
  assert.ok(html.includes('存成照片給醫生'), '保留存成照片按鈕');
  // A4 版面模組已引入（允許帶 cache-busting 版本參數）
  assert.ok(/src="\/a4-report\.js(\?v=[^"]*)?"/.test(html), '需引入 a4-report.js 模組');
  // 單一統計範圍控制存在（7/14/30）
  assert.ok(html.includes('id="reportRangeChips"') && html.includes('data-range="14"'), '單一 reportRange 控制存在');
});

// 今日紀錄／最近／月曆單日：weight 必須顯示「數值＋單位」，不得只剩「體重」標籤（實機回報的漏值 bug）
test('體重顯示：formatWeightKg 規則正確，且 4.27 不變 4.3、4.2 不變 4.20', () => {
  // 從 index.html 抽出真正的 formatWeightKg 執行，驗顯示規則（非只看原始碼字串）
  const m = html.match(/function formatWeightKg\(value\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(m, '需有 formatWeightKg helper');
  // eslint-disable-next-line no-new-func
  const formatWeightKg = new Function(`${m[0]}; return formatWeightKg;`)();
  assert.equal(formatWeightKg(4.27), '4.27');
  assert.equal(formatWeightKg(4.2), '4.2');
  assert.equal(formatWeightKg(4.20), '4.2');
  assert.equal(formatWeightKg(4), '4');
  assert.equal(`${formatWeightKg(4.27)} kg`, '4.27 kg');
  assert.notEqual(`${formatWeightKg(4.27)} kg`, '4.3 kg');
});

test('今日紀錄／最近清單：兩個 renderer 都有 weight 分支，輸出數值＋單位（不只標籤）', () => {
  // renderLogs（今日預覽卡／查看全部／月曆單日 共用）與 renderRecent（最近）都要畫 weight 值
  const renderLogs = html.slice(html.indexOf('function renderLogs'), html.indexOf('function renderRecent'));
  const renderRecent = html.slice(html.indexOf('function renderRecent'), html.indexOf('function renderRecent') + 3000);
  for (const [name, body] of [['renderLogs', renderLogs], ['renderRecent', renderRecent]]) {
    assert.ok(/log\.category === 'weight'/.test(body), `${name} 需有 weight 分支`);
    assert.ok(/formatWeightKg\(log\.amount\)/.test(body), `${name} weight 值需用 formatWeightKg`);
    assert.ok(/log\.unit \|\| 'kg'/.test(body), `${name} weight 需帶單位`);
  }
  // 編輯／刪除按鈕仍在（只加了顯示 chip，不動操作）
  assert.ok(/data-edit=/.test(renderLogs) && /data-del=/.test(renderLogs), 'renderLogs 仍有編輯/刪除按鈕');
});

test('describeLogFront：體重用 formatWeightKg（不再 toFixed 成一位小數）', () => {
  const fn = html.slice(html.indexOf('function describeLogFront'), html.indexOf('function describeLogFront') + 700);
  assert.ok(/category === 'weight'\) return `體重 \$\{formatWeightKg\(log\.amount\)\} kg`/.test(fn), '體重描述需用 formatWeightKg');
});
