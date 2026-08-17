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
  // 主操作＝儲存完整報告（存成圖片，不需先傳 LINE）；傳到 LINE 降為次要分享；文案不再把 LINE 當唯一用途
  assert.ok(html.includes('儲存完整報告'), '主按鈕＝儲存完整報告');
  assert.ok(html.includes('id="reportSendLineBtn"') && html.includes('傳到 LINE'), '次要入口＝傳到 LINE');
  assert.ok(!html.includes('傳完整報告到我的 LINE'), '主按鈕不再是「傳完整報告到我的 LINE」');
  assert.ok(/可儲存成圖片，也可以直接傳到 LINE/.test(html), '說明文：可儲存成圖片，也可以直接傳到 LINE');
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

// 網站體重編輯表單：category=weight 時顯示「體重(kg)」欄、預填原值、驗證擋空/0/負/非數字
test('編輯表單：weight 欄位存在、預填 log.amount、最多兩位小數、可見性受 category 控制', () => {
  // logFormFields 有 weightAmount 欄，且 category=weight 時預填 log.amount
  assert.ok(/name="weightAmount"[^>]*step="0\.01"/.test(html), 'weight 欄需 step=0.01（最多兩位）');
  assert.ok(/class="field log-weight"/.test(html), '需有 .log-weight 欄位容器');
  assert.ok(/category === 'weight' \? esc\(log\?\.amount \?\? ''\) : ''/.test(html), 'weight 欄需預填 log.amount');
  // 可見性切換：category=weight 顯示 log-weight、其餘（水/食/藥）隱藏
  assert.ok(/\.log-weight'\)\.forEach\(\(el\) => el\.classList\.toggle\('hidden', category !== 'weight'\)\)/.test(html), 'syncLogFormVisibility 需切換 .log-weight');
});

test('編輯表單：collectLogForm 對 weight 擋空/0/負/非數字，並存兩位小數（不清成 0）', () => {
  const collect = html.slice(html.indexOf('function collectLogForm'), html.indexOf('function collectLogForm') + 1800);
  assert.ok(/category === 'weight'/.test(collect), 'collectLogForm 需有 weight 分支');
  assert.ok(/n <= 0/.test(collect) && /Number\.isFinite\(n\)/.test(collect), '需擋 <=0 與非數字');
  assert.ok(/Math\.round\(n \* 100\) \/ 100/.test(collect), '需存最多兩位小數');
  assert.ok(/throw new Error/.test(collect), '無效值需丟錯（不送出）');
});

// 多頁 A4 存圖／分享：每頁自己的儲存鈕（綁 data-idx，走 a4SharePage(items, idx)）＋一次分享全部；
// 不得只留單一模糊按鈕、不得共用 items[0]、不得把多頁合成一張長圖。
test('A4 存圖：每頁有「儲存第N張」鈕綁 data-idx，逐頁用 a4SharePage(items, idx)，非固定 items[0]', () => {
  const fn = html.slice(html.indexOf('function showReportImages'), html.indexOf('function showReportImages') + 3400);
  assert.ok(/imgbox-savepage/.test(fn) && /data-idx="\$\{i\}"/.test(fn), '每頁需有 儲存第N張 鈕、綁 data-idx');
  assert.ok(/Number\(b\.dataset\.idx\)/.test(fn), '點擊讀自己的 pageIndex');
  assert.ok(/a4SharePage\(items, idx/.test(fn), '逐頁走 a4SharePage(items, idx)，不共用 items[0]');
  assert.ok(/a4ShareAll\(items/.test(fn), '一次分享全部走 a4ShareAll(items)');
  assert.ok(/第 \$\{i \+ 1\} 頁／共 \$\{items\.length\} 頁/.test(fn), '多頁標示第N頁／共M頁');
  // 文案：navigator.share 會開系統分享面板，用「分享／儲存」較不誤導；單頁 vs 多頁
  assert.ok(/分享／儲存這張/.test(fn) && /分享／儲存第 \$\{i \+ 1\} 張/.test(fn), '單頁「分享／儲存這張」、多頁「分享／儲存第N張」');
  assert.ok(/一次分享全部/.test(fn), '多頁主鈕「一次分享全部」');
  assert.ok(/請依序按下方的/.test(fn), '不支援多檔分享時要明確要求逐頁分享／儲存（不假裝成功）');
  // 不得把兩頁合成一張長圖：仍是每個 .a4-page 各自渲染成 2480×3508
  assert.ok(/TARGET_W = 2480, TARGET_H = 3508/.test(html), '每頁固定 2480×3508');
  assert.ok(/for \(const node of nodes\)/.test(html), '逐頁節點各自產圖，不合成長圖');
  // 頁數與實際張數不符時不假裝已產生 N 張（規格六）
  assert.ok(/pngs\.length < pages/.test(html), '頁數不符時報錯，不假裝已產生');
  assert.ok(/a4PageFilenames\(base, pngs\.length\)/.test(html), '用 a4PageFilenames 產生每頁檔名');
});

// 儲存完整報告（主要入口）：存成圖片，不經 LINE、不上傳 /shot，沿用 a4RenderPages + showReportImages
test('儲存完整報告：主按鈕存圖不經 LINE、防連點、snapshot 資料渲染、多頁完整保留', () => {
  const fn = html.slice(html.indexOf("$('reportSaveBtn').addEventListener"), html.indexOf("$('reportSaveBtn').addEventListener") + 2000);
  // 防連點：與「傳到 LINE」互斥
  assert.ok(/let reportSaving = false/.test(html) && /if \(reportSaving \|\| reportSending\) return/.test(fn), '需有防連點鎖（與傳 LINE 互斥）');
  assert.ok(/reportSaving = true/.test(fn) && /reportSaving = false/.test(fn), '處理中鎖定、完成後解除');
  // snapshot：同步 collectA4Data + 用 snap.data 渲染
  assert.ok(/const snap = \{/.test(fn) && /data: collectA4Data\(\)/.test(fn), '需 snapshot petId/資料');
  assert.ok(/a4RenderPages\(snap\.data\)/.test(fn), '用 snapshot 資料渲染');
  // 存圖不經 LINE、不上傳 /shot；每頁 dataUrl 直接交給 showReportImages（多頁完整保留）
  assert.ok(!/a4UploadShot/.test(fn) && !/a4SendReport/.test(fn), '存圖不上傳 /shot、不送 LINE');
  assert.ok(/pngs\.map\(\(png, i\) => \(\{ dataUrl: png/.test(fn), '每頁 dataUrl 供分享／長按儲存');
  assert.ok(/showReportImages\(items\)/.test(fn), '交給既有儲存 UI 顯示每一頁');
  assert.ok(/trackEvent\('report_save'\)/.test(fn), '記錄 report_save 事件');
});

// 傳到 LINE（次要入口，liff.sendMessages 主流程）：防連點、snapshot、上傳全成才送、fallback、preview
test('傳到 LINE：次要入口文案、防連點鎖、snapshot 資料渲染、送前再驗家庭', () => {
  assert.ok(html.includes('傳到 LINE'), '次要入口＝傳到 LINE');
  const fn = html.slice(html.indexOf("$('reportSendLineBtn').addEventListener"), html.indexOf("$('reportSendLineBtn').addEventListener") + 5400);
  // 防連點
  assert.ok(/let reportSending = false/.test(html) && /if \(reportSending \|\| reportSaving\) return/.test(fn), '需有防連點鎖');
  assert.ok(/reportSending = true/.test(fn) && /reportSending = false/.test(fn), '處理中鎖定、完成後解除');
  // snapshot：同步 collectA4Data + 用 snap.data 渲染（不吃後續 state 切換）
  assert.ok(/const snap = \{/.test(fn) && /data: collectA4Data\(\)/.test(fn), '需 snapshot petId/資料');
  assert.ok(/a4RenderPages\(snap\.data\)/.test(fn), '用 snapshot 資料渲染');
  // 送前再次確認 snapshot 的貓仍屬本家庭
  assert.ok(/some\(\(p\) => p\.petId === snap\.petId\)/.test(fn), '送出前再驗貓仍在家庭');
  // 處理中/成功文案
  assert.ok(/正在整理完整報告/.test(fn) && /完整報告已傳到聊天室/.test(fn), '處理中與成功文案');
});

test('傳到 LINE：先全部上傳、再用 a4SendReport 一次送；deps 綁 liff.sendMessages＋fallback', () => {
  const fn = html.slice(html.indexOf("$('reportSendLineBtn').addEventListener"), html.indexOf("$('reportSendLineBtn').addEventListener") + 5400);
  // 全部頁上傳完成才送（迴圈 push items 後才呼叫 a4SendReport）
  assert.ok(/for \(let i = 0; i < pngs\.length/.test(fn) && /a4UploadShot\(png\)/.test(fn), '逐頁上傳');
  assert.ok(/window\.a4SendReport\(items, deps\)/.test(fn), '用 a4SendReport 一次送全部');
  // deps：sendMessages 主、shareTargetPicker 次、showReportImages 最後
  // canSend 綜合判斷（inClient＋非 external＋授權非 unavailable），不得用 isApiAvailable('sendMessages')
  assert.ok(/canSend: \(\) =>[^\n]*inClient[^\n]*ctxType !== 'external'[^\n]*chatWrite !== 'unavailable'/.test(fn), 'canSend 綜合判斷');
  assert.ok(!/isApiAvailable\('sendMessages'\)/.test(html), '不得用 isApiAvailable(sendMessages)（官方不支援此 apiName）');
  assert.ok(/send: \(messages\) => window\.liff\.sendMessages\(messages\)/.test(fn), 'send＝liff.sendMessages（最終以實際呼叫為準）');
  assert.ok(/share: \(messages\) => window\.liff\.shareTargetPicker\(messages\)/.test(fn), 'fallback＝shareTargetPicker');
  assert.ok(/manual: \(its\) => showReportImages\(its\)/.test(fn), '最後 fallback＝頁面長按');
  // preview 保險：>1MB 才產，且實測 <=1MB（a4BuildPreview 逐步縮＋a4WithinPreviewLimit）；縮不下去→oversize→manual
  assert.ok(/a4NeedsSmallerPreview\(png\)/.test(fn) && /a4BuildPreview\(png\)/.test(fn), 'preview 僅在 >1MB 時另產');
  assert.ok(/a4WithinPreviewLimit\(window\.dataUrlBytes\(small\)\)/.test(html), 'preview 產出後實測 <=1MB');
  assert.ok(/a4WithinOriginalLimit\(window\.dataUrlBytes\(png\)\)/.test(fn), 'original >10MB → 不送 LINE');
  assert.ok(/oversize: true/.test(fn), '超規格頁標記 oversize（轉 manual）');
  // 結果文案：>5 頁 too_many_pages、圖過大 image_too_large 都明確要求改用分享
  assert.ok(/too_many_pages/.test(fn) && /image_too_large/.test(fn), '超上限/過大都有明確提示');
  assert.ok(/請從下方分享完整報告/.test(fn), '超上限提示改用分享完整報告');
  // LIFF init：用 permission.query('chat_message.write') 取授權狀態，不用 isApiAvailable('sendMessages')
  assert.ok(/permission\.query\('chat_message\.write'\)/.test(html), 'init 用 permission.query 取 chat_message.write 授權');
});

// 吃過的食物（照護時間軸）：回顧 tab 內的入口、逐筆時間軸、類型／範圍 filter、誠實顯示 generic、deep link
test('吃過的食物：入口在回顧、逐筆時間軸、資料走 food-timeline API、generic 只顯示類型', () => {
  // 入口與名稱（不叫品牌歷史／food history）
  assert.ok(/id="eatenFold"/.test(html) && html.includes('吃過的食物'), '回顧內有「吃過的食物」fold');
  assert.ok(html.includes('看看最近什麼時候吃了哪一款'), '副標語氣');
  assert.ok(!/id="eatenFold"[\s\S]{0,400}品牌歷史/.test(html), '入口不叫「品牌歷史」（generic 可能沒品牌）');
  // 類型 chips 顯示正式名稱（口語別名只在 LINE parser）
  for (const t of ['全部', '主食罐', '副食罐', '罐頭', '乾糧', '零食']) assert.ok(html.includes(`>${t}</button>`), `類型 chip：${t}`);
  // 時間範圍 chips（近 7／近 30／全部）
  assert.ok(/data-days="7"/.test(html) && /data-days="30"[^>]*class="active"/.test(html) && /data-days="all"/.test(html), '範圍 chips，預設近 30 天');
  // 資料來源：呼叫 food-timeline API（pet scoped，帶 days/limit）
  const load = html.slice(html.indexOf('async function loadFoodTimeline'), html.indexOf('async function loadFoodTimeline') + 900);
  assert.ok(/food-timeline\?petId=\$\{state\.petId\}&days=\$\{days\}&limit=\$\{limit\}/.test(load), '走 food-timeline API、pet scoped、帶 days/limit');
  // 效能：limit（避免第一次載入大量歷史）＋查看更多
  assert.ok(/eatenMoreBtn/.test(html) && /state\.eaten\.limit \+= 100/.test(html), '有「查看更多」拉高上限');
  // generic 誠實顯示：名稱===類型 → 不加品牌 tag；不顯示 foodId
  const render = html.slice(html.indexOf('function renderFoodTimeline'), html.indexOf('function renderFoodTimeline') + 1600);
  assert.ok(/const isGeneric = name === String\(r\.foodType/.test(render), 'generic（名稱===類型）判斷');
  assert.ok(!/r\.foodId/.test(render), '時間軸不顯示 foodId');
  // 實吃 amount；有原餵/剩餘才附註（不得把剩餘量當實吃）
  assert.ok(/原 \$\{fmt\(served\)\}g・剩 \$\{fmt\(leftover\)\}g/.test(render) && /Number\(served\) > 0/.test(render), '附原餵/剩餘，不把剩餘當實吃');
  // 空狀態（不是空白頁）＋誠實品牌教學
  assert.ok(/還沒有吃飯紀錄/.test(html) && /之後就能在這裡回顧/.test(html), '空狀態文案');
  assert.ok(/只記「乾乾5」這類簡略紀錄，如果沒有預設食物，就只會顯示「乾糧」/.test(html), '誠實的品牌教學');
  // deep link：沿用既有 go= 機制（go=eaten 開回顧並展開），不另建 URL 系統
  assert.ok(/goTarget === 'eaten'/.test(html) && /switchTab\('trend'\)/.test(html), 'go=eaten deep link 進回顧');
});

// 資訊層級重整：品牌／品項名為主，時間・類型・實吃量為輔（不是三欄資料表）
test('吃過的食物 UI：品項名為主層、時間/類型/實吃為輔層、generic 不重複類型、時間軸節點', () => {
  const render = html.slice(html.indexOf('function renderFoodTimeline'), html.indexOf('function renderFoodTimeline') + 2600);
  // 第一層＝品項名（.eaten-name 為獨立主層，且排在 meta 之前）
  const nameIdx = render.indexOf('class="eaten-name"');
  const metaIdx = render.indexOf('class="eaten-meta"');
  assert.ok(nameIdx > 0 && metaIdx > nameIdx, '品項名為第一層、在輔助行之前');
  // 第二層＝時間・類型・實吃量（同一 meta 行）
  assert.ok(render.includes('class="eaten-meta"') && render.includes('<span class="t">'), '輔助行含時間');
  assert.ok(render.includes('實吃 ') && /<span class="g">實吃/.test(render), '實吃量在輔助行（不做右側巨大數字）');
  // generic：類型不重複進 meta（名稱本身就是類型）
  assert.ok(/isGeneric \? '' : /.test(render) && render.includes('class="ty"'), 'generic 不重複顯示類型');
  // 不再是三欄表格：舊的 .eaten-amt 右欄與彩色 .eaten-type-tag 皆已移除
  assert.ok(!/class="eaten-amt"/.test(html) && !/class="eaten-type-tag"/.test(html), '移除右側大數字欄與彩色類型 pill');
  // 時間軸節奏：淡 rail + 小節點（非粗水平線）；每筆保留 data-log-id 供日後接單筆修改
  assert.ok(/\.eaten-list::before/.test(html) && /\.eaten-item::before/.test(html), '時間軸 rail＋節點');
  assert.ok(/data-log-id="\$\{esc\(r\.logId \|\| ''\)\}"/.test(render), '每筆帶 data-log-id（可延伸，不綁 handler）');
  // 輕量 filter：chips 字級比內容標題小、padding 縮小、保留橫向捲動
  assert.ok(/\.eaten-chips button \{[^}]*font-size: 12px[^}]*padding: 4px 11px/.test(html), 'filter chips 視覺縮小');
  assert.ok(/\.eaten-chips \{[^}]*overflow-x: auto/.test(html), 'chips 保留橫向捲動');
  // 實吃/剩食不回歸
  assert.ok(/原 \$\{fmt\(served\)\}g・剩 \$\{fmt\(leftover\)\}g/.test(render), 'served/leftover 顯示不回歸');
});

// 家裡習慣的叫法：食物設定頁的別名區塊＋新增/儲存/刪除接到 /api/food-aliases
test('家裡習慣的叫法：食物頁有別名區塊，走 food-aliases API，不露 foodId/alias 技術詞', () => {
  assert.ok(/function renderAliasBlock\(\)/.test(html), '有 renderAliasBlock');
  assert.ok(html.includes('家裡習慣的叫法'), '區塊標題（生活化用詞）');
  assert.ok(/state\.foodAliases = \(await api\('food-aliases'\)\)\.rows/.test(html), '食物頁載入別名');
  assert.ok(/api\('food-aliases', \{ method: 'POST'/.test(html), '新增走 POST food-aliases');
  assert.ok(/api\(`food-aliases\?alias=\$\{encodeURIComponent\(alias\)\}`, \{ method: 'DELETE'/.test(html), '刪除走 DELETE');
  // 目標選單用 type:/item: 前綴，前端不必看到 targetType/foodId 名詞
  assert.ok(/value="type:\$\{esc\(t\)\}"/.test(html) && /value="item:\$\{esc\(f\.foodId\)\}"/.test(html), '類型/品項選項用前綴，UI 不露技術欄位');
  assert.ok(!/alias.*mapping|kcalSource/.test(html), '不顯示 mapping/kcalSource 這類技術詞');
});

// /shot 6 小時失效
test('/shot 6h 失效：shotExpired 規則（5h59m 可讀、>6h 不可讀），GET 端已接上', async () => {
  const { shotExpired } = await import('../src/util.js');
  const now = Date.parse('2026-08-06T12:00:00Z');
  assert.equal(shotExpired('2026-08-06T06:01:00Z', now), false, '5h59m 內可讀');
  assert.equal(shotExpired('2026-08-06T05:59:00Z', now), true, '>6h 不可讀');
  assert.equal(shotExpired('', now), true, '缺 createdAt → 視為過期（安全）');
  // GET /shot/:id 已接上 shotExpired → 回 410
  assert.ok(/if \(shotExpired\(row\.createdAt\)\) return new Response\('gone', \{ status: 410 \}\)/.test(readFileSync(join(dir, '../src/index.js'), 'utf8')), 'GET /shot 過期回 410');
});
