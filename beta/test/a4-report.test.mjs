// A4 回診摘要版型（純函式 buildA4Report）結構測試：斷言區塊、單一 rangeDays 一致、頁首/頁尾、
// 空狀態、分頁、日期不重不漏、估算標示、百分比湊 100%、體重稀疏、回診事項新→舊。
// 圖片實際 2480×3508 像素/清晰度屬瀏覽器渲染，需人工在手機（含 LINE LIFF）驗證，不假裝自動化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildA4Report, a4PageFilenames, a4ShareAll, a4SharePage, dataUrlBytes, a4NeedsSmallerPreview, a4WithinOriginalLimit, a4WithinPreviewLimit, a4BuildImageMessages, a4ShareResultCancelled, a4SendReport } from '../public/a4-report.js';

function daily(nDays) {
  const rows = [];
  for (let i = 0; i < nDays; i += 1) {
    const d = new Date(Date.UTC(2026, 6, 29) - i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, waterMl: 100 + i, wetG: 80, dryG: 15, kcal: 170 + i, kcalEstimated: false });
  }
  return rows;
}
function baseData(over = {}) {
  return {
    petName: '蚵仔', reportName: '回診摘要', source: '喵喵照護站',
    dateRangeLabel: '2026/07/23－2026/08/05（近 14 天）', generatedAt: '2026-08-05 08:29', rangeDays: 14,
    weight: { latest: 4.18, unit: 'kg', points: [{ date: '2026-07-16', value: 4.3 }, { date: '2026-07-23', value: 4.25 }, { date: '2026-07-30', value: 4.18 }], deltaPct: -1, count: 3 },
    water: { latest: 181, unit: 'ml', points: [{ date: '2026-07-28', value: 175 }, { date: '2026-07-29', value: 181 }], deltaPct: 12 },
    kcal: { latest: 175, unit: 'kcal', points: [{ date: '2026-07-28', value: 170 }, { date: '2026-07-29', value: 175 }], deltaPct: -2, estimated: false },
    digest: [
      { date: '2026-07-26', time: '21:00', typeLabel: '嘔吐', tone: 'warn', text: '晚上吐膠囊狀' },
      { date: '2026-08-04', time: '06:59', typeLabel: '嘔吐', tone: 'warn', text: '乾乾+水' }
    ],
    missedMed: null,
    composition: { rangeDays: 14, hasData: true, water: { total: 1567.4, own: 913.9, food: 653.5 }, food: { total: 956.3, dry: 139.3, wet: 817, other: 0 } },
    daily: daily(28),
    ...over
  };
}
const occ = (s, sub) => s.split(sub).length - 1;

test('回傳 { html, pages }，四大區塊＋頁首（毛孩/摘要名/期間/產生日期/來源）＋頁尾免責齊全', () => {
  const { html, pages } = buildA4Report(baseData());
  assert.equal(typeof html, 'string');
  assert.ok(pages >= 2);
  for (const s of ['蚵仔', '回診摘要', '摘要期間：', '產生日期：', '資料來源：', '體重・飲水・熱量趨勢', '飲食與水分組成', '回診重點事項', '每日照護明細']) {
    assert.ok(html.includes(s), `應含「${s}」`);
  }
  assert.ok(html.includes('2026/07/23－2026/08/05（近 14 天）'), '頁首顯示實際統計期間');
  assert.ok(html.includes('不作為診斷依據'), '頁尾免責');
  assert.equal(occ(html, 'class="a4-page"'), pages, 'pages 數與 .a4-page 數一致');
});

test('單一 reportRange：所有區塊統計範圍標籤都用同一 rangeDays（近14天），不混入 7/30', () => {
  const { html } = buildA4Report(baseData({ rangeDays: 14 }));
  // 只看 .a4-range 標籤（排除比較說明裡的「最近 7 天平均」等字樣）
  const labels = [...html.matchAll(/class="a4-range">近 (\d+) 天/g)].map((m) => Number(m[1]));
  assert.ok(labels.length >= 3, '趨勢/組成/回診重點都要有範圍標籤');
  assert.ok(labels.every((n) => n === 14), `所有區塊範圍標籤都必須是 14，實際 ${labels.join(',')}`);
});

test('每日明細：日期不重不漏、五欄、單位在表頭', () => {
  const data = baseData();
  const { html } = buildA4Report(data);
  for (const h of ['日期', '水分', '濕食/罐頭', '乾糧', '熱量']) assert.ok(html.includes(h));
  assert.ok(html.includes('<small>ml</small>') && html.includes('<small>kcal</small>'));
  for (const r of data.daily) {
    const md = `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`;
    assert.equal(occ(html, `class="a4-td-date">${md}</td>`), 1, `明細日期 ${md} 恰一次`);
  }
});

test('回診重點事項：新→舊排序（8/04 在 7/26 前），含日期/時間/類型/內容', () => {
  const { html } = buildA4Report(baseData());
  const i0804 = html.indexOf('乾乾+水');   // 8/04
  const i0726 = html.indexOf('晚上吐膠囊狀'); // 7/26
  assert.ok(i0804 > -1 && i0726 > -1 && i0804 < i0726, '較新的 8/04 應排在 7/26 之前');
  assert.ok(html.includes('06:59') && html.includes('嘔吐'), '顯示時間與類型');
});

test('百分比湊 100：水分來源（自己喝＋食物含水）與飲食組成百分比各自加總為 100', () => {
  const { html } = buildA4Report(baseData());
  const ps = [...html.matchAll(/class="a4-lg-p">(\d+)%/g)].map((m) => Number(m[1]));
  // 水分兩段 + 飲食兩段（乾/濕）= 4 個百分比，前兩個為水分、後兩個為飲食
  assert.equal(ps.length, 4);
  assert.equal(ps[0] + ps[1], 100, '水分來源百分比和＝100');
  assert.equal(ps[2] + ps[3], 100, '飲食組成百分比和＝100');
});

test('沒有體重：顯示「尚無體重紀錄」，不出現互動提示（＋記體重）', () => {
  const { html } = buildA4Report(baseData({ weight: { latest: null, points: [], deltaPct: null, count: 0 } }));
  assert.ok(html.includes('尚無體重紀錄'));
  assert.ok(!html.includes('＋記體重') && !html.includes('點右上角'));
});

test('體重稀疏（<3 筆）：不畫誤導趨勢線，改標「近期紀錄 N 筆・體重持平」', () => {
  const { html } = buildA4Report(baseData({ weight: { latest: 4.3, points: [{ date: '2026-07-22', value: 4.3 }, { date: '2026-07-29', value: 4.3 }], deltaPct: 0, count: 2 } }));
  assert.ok(html.includes('近期紀錄 2 筆'), '標示筆數');
  assert.ok(html.includes('體重持平'));
});

test('沒有回診事項：顯示「此期間無症狀或備註紀錄」，卡片仍在', () => {
  const { html } = buildA4Report(baseData({ digest: [], missedMed: null }));
  assert.ok(html.includes('此期間無症狀或備註紀錄'));
  assert.ok(html.includes('回診重點事項'));
});

test('漏藥旗標：有漏藥時顯示漏藥警示', () => {
  const { html } = buildA4Report(baseData({ digest: [], missedMed: { count: 2, days: ['2026-07-25', '2026-08-01'] } }));
  assert.ok(html.includes('漏藥 2 天'));
});

test('比較期間說明：清楚寫出 ↑↓% 是最近7天與前7天平均相比', () => {
  const { html } = buildA4Report(baseData());
  assert.ok(html.includes('最近 7 天平均') && html.includes('前 7 天平均'), '有比較期間說明');
});

test('估算熱量：明細標「估」，不冒充精確值', () => {
  const rows = daily(3); rows[0].kcalEstimated = true;
  const { html } = buildA4Report(baseData({ daily: rows }));
  assert.ok(html.includes('a4-est-mark') && html.includes('估'));
});

test('分頁：28 天明細 → 頁尾出現 N／N 頁碼，且每頁一張 .a4-page', () => {
  const { html, pages } = buildA4Report(baseData({ daily: daily(28) }));
  assert.ok(html.includes(`／${pages}`), '頁碼含總頁數');
  assert.equal(occ(html, 'class="a4-page"'), pages);
});

test('30 天大量資料 → 明細自動分成多頁（區塊緊湊排版、少留白）', () => {
  const { html, pages } = buildA4Report(baseData({ daily: daily(30) }));
  assert.ok(occ(html, 'class="a4-daily"') >= 2, '30 天明細跨多張表');
  assert.ok(pages >= 3);
});

test('很長症狀文字完整保留、不截斷成省略號', () => {
  const long = '連續三天半夜嘔吐透明帶泡沫液體，量不多但次數變多，白天食慾略降，已預約回診請醫生評估腸胃狀況與是否需要進一步檢查與影像';
  const { html } = buildA4Report(baseData({ digest: [{ date: '2026-07-26', typeLabel: '備註', tone: 'note', text: long }] }));
  assert.ok(html.includes(long));
  assert.ok(!html.includes('…') && !html.includes('...'));
});

test('很長毛孩名稱：頁首不遺失名稱', () => {
  const name = '大橘子波波毛毛蟲隊長三世';
  const { html } = buildA4Report(baseData({ petName: name }));
  assert.ok(html.includes(name));
});

test('空資料整體：不丟例外，仍輸出頁首/免責/「尚無」文字', () => {
  const { html, pages } = buildA4Report({ petName: '小白', rangeDays: 14, daily: [] });
  assert.ok(html.includes('小白') && html.includes('回診摘要'));
  assert.ok(html.includes('此期間尚無每日紀錄') || html.includes('此期間無紀錄'));
  assert.ok(html.includes('不作為診斷依據'));
  assert.ok(pages >= 1);
});

// ── 多頁存圖／分享：每頁獨立 Blob/檔名、逐頁綁定自己的 pageIndex、一次分享含全部 File ──
// 用注入 deps 測真實分享編排（不需瀏覽器）；記錄實際交給 share 的檔名，驗不是只送 files[0]。
function mockDeps(canShareMultiple) {
  const calls = [];
  return {
    calls,
    fetchBlob: async (dataUrl) => ({ __blobOf: dataUrl }),
    makeFile: (blob, name) => ({ name, blob }),
    canShare: (files) => canShareMultiple || files.length === 1,
    share: async (files) => { calls.push(files.map((f) => f.name)); }
  };
}

test('多頁檔名：單頁 base.png；兩頁 base_1/base_2；三頁 base_1/2/3（各自可辨識頁碼）', () => {
  assert.deepEqual(a4PageFilenames('R', 1), ['R.png']);
  assert.deepEqual(a4PageFilenames('R', 2), ['R_1.png', 'R_2.png']);
  assert.deepEqual(a4PageFilenames('R', 3), ['R_1.png', 'R_2.png', 'R_3.png']);
});

test('兩頁：pages=2、不同 dataUrl、不同檔名（不得共用同一張）', () => {
  const names = a4PageFilenames('蚵仔_回診摘要', 2);
  const items = [{ dataUrl: 'DATA_1', name: names[0] }, { dataUrl: 'DATA_2', name: names[1] }];
  assert.equal(items.length, 2);
  assert.notEqual(items[0].dataUrl, items[1].dataUrl, '兩頁 Blob 來源不同');
  assert.notEqual(items[0].name, items[1].name, '兩頁檔名不同');
});

test('一次分享全部（支援多檔）：navigator.share 收到 2 個 File，不是只有 files[0]', async () => {
  const items = [{ dataUrl: 'D1', name: 'p_1.png' }, { dataUrl: 'D2', name: 'p_2.png' }];
  const deps = mockDeps(true);
  const r = await a4ShareAll(items, deps);
  assert.equal(r.shared, 2); assert.equal(r.needManual, false);
  assert.deepEqual(deps.calls, [['p_1.png', 'p_2.png']], 'share 一次收到 2 個 File');
});

test('儲存第 1 張取得第 1 頁、儲存第 2 張取得第 2 頁（不得兩顆都取第 1 頁）', async () => {
  const items = [{ dataUrl: 'D1', name: 'p_1.png' }, { dataUrl: 'D2', name: 'p_2.png' }];
  const d0 = mockDeps(false); await a4SharePage(items, 0, d0);
  const d1 = mockDeps(false); await a4SharePage(items, 1, d1);
  assert.deepEqual(d0.calls, [['p_1.png']], '第 1 張＝第 1 頁');
  assert.deepEqual(d1.calls, [['p_2.png']], '第 2 張＝第 2 頁（非 files[0]）');
});

test('裝置不支援多檔分享：a4ShareAll 回 needManual、pages=2（不假裝成功、不只送一張）', async () => {
  const items = [{ dataUrl: 'D1', name: 'p_1.png' }, { dataUrl: 'D2', name: 'p_2.png' }];
  const deps = mockDeps(false);
  const r = await a4ShareAll(items, deps);
  assert.equal(r.needManual, true); assert.equal(r.shared, 0); assert.equal(r.pages, 2);
  assert.deepEqual(deps.calls, [], '不支援時完全不呼叫 share（不會只送一張假裝成功）');
});

test('單頁分享：只含 1 個 File', async () => {
  const items = [{ dataUrl: 'D1', name: 'r.png' }];
  const deps = mockDeps(false);
  const r = await a4ShareAll(items, deps);
  assert.equal(r.shared, 1);
  assert.deepEqual(deps.calls, [['r.png']]);
});

test('三頁：一次分享包含 3 個 File；每頁也可分別儲存', async () => {
  const items = [{ dataUrl: 'A', name: 'a.png' }, { dataUrl: 'B', name: 'b.png' }, { dataUrl: 'C', name: 'c.png' }];
  const all = mockDeps(true); const r = await a4ShareAll(items, all);
  assert.equal(r.shared, 3); assert.deepEqual(all.calls, [['a.png', 'b.png', 'c.png']]);
  for (let i = 0; i < 3; i += 1) { const d = mockDeps(false); await a4SharePage(items, i, d); assert.deepEqual(d.calls, [[items[i].name]], `第 ${i + 1} 張綁定自己那頁`); }
});

// ── 傳完整摘要到 LINE（liff.sendMessages 主流程 + fallback）測試（規格 H）──────────────
const itemsN = (n) => Array.from({ length: n }, (_, i) => ({ url: `/shot/p${i + 1}`, previewUrl: '', dataUrl: `d${i + 1}`, name: `r_${i + 1}.png` }));
function sendMock(over = {}) {
  const calls = { send: [], share: [], manual: [] };
  const shareResult = 'shareResult' in over ? over.shareResult : { status: 'success' }; // 預設分享成功
  const base = {
    origin: 'https://cat.dev',
    canSend: () => false, canShare: () => false,
    send: async (m) => { calls.send.push(m); },
    share: async (m) => { calls.share.push(m); return shareResult; },
    manual: (its) => { calls.manual.push(its); }
  };
  const deps = { ...base, ...over }; delete deps.shareResult;
  return { deps, calls };
}

test('1 頁 → sendMessages 送 1 個 image message', async () => {
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(itemsN(1), deps);
  assert.equal(r.method, 'send'); assert.equal(r.pages, 1);
  assert.equal(calls.send[0].length, 1);
  assert.equal(calls.send[0][0].type, 'image');
});
test('2 頁 → 一次 sendMessages 送 2 個 image（不是只送第 1 張）', async () => {
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.pages, 2); assert.equal(calls.send[0].length, 2);
  assert.deepEqual(calls.send[0].map((m) => m.originalContentUrl), ['https://cat.dev/shot/p1', 'https://cat.dev/shot/p2']);
});
test('3 頁 → 一次送 3 個 image', async () => {
  const { deps, calls } = sendMock({ canSend: () => true });
  await a4SendReport(itemsN(3), deps);
  assert.equal(calls.send[0].length, 3);
});
test('5 頁 → 完整送 5 則（上限內不截斷）', async () => {
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(itemsN(5), deps);
  assert.equal(r.method, 'send'); assert.equal(calls.send[0].length, 5);
});
test('超過 5 頁 → 不截斷、不宣稱完整，走 manual（too_many_pages），保留全部頁；第 6 頁不被遺失', async () => {
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(itemsN(6), deps);
  assert.equal(r.ok, false); assert.equal(r.method, 'manual'); assert.equal(r.reason, 'too_many_pages'); assert.equal(r.pages, 6);
  assert.equal(calls.send.length, 0, '完全不呼叫 sendMessages（不送前 5 頁假裝完整）');
  assert.equal(calls.manual[0].length, 6, 'manual 收到全部 6 頁');
});
test('任一頁 upload 失敗（url 空）→ 不送 LINE、不宣稱成功，改走 manual（保留全部頁）', async () => {
  const items = itemsN(2); items[1].url = '';
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(items, deps);
  assert.equal(r.ok, false); assert.equal(r.method, 'manual'); assert.equal(r.reason, 'upload_incomplete');
  assert.equal(calls.send.length, 0, '完全沒呼叫 sendMessages');
  assert.equal(calls.manual[0].length, 2, 'manual 收到全部 2 頁');
});
test('sendMessages 丟錯（非取消）→ fallback shareTargetPicker，帶完整 pages', async () => {
  const { deps, calls } = sendMock({ canSend: () => true, canShare: () => true, send: async () => { throw new Error('boom'); } });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.method, 'share'); assert.equal(calls.share[0].length, 2);
});
test('非 LIFF client（canSend/canShare 皆 false）→ fallback manual，保留全部頁', async () => {
  const { deps, calls } = sendMock();
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.method, 'manual'); assert.equal(calls.manual[0].length, 2);
});
test('sendMessages unavailable 但可 share → 走 share（不是直接 manual）', async () => {
  const { deps, calls } = sendMock({ canShare: () => true });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.method, 'share'); assert.equal(calls.share[0].length, 2);
});
test('sendMessages 因 scope/情境失敗（403/LiffError）→ 落 shareTargetPicker（不永遠跳過、也不誤報成功）', async () => {
  const e = new Error('need chat_message.write'); e.name = 'LiffError';
  const { deps, calls } = sendMock({ canSend: () => true, canShare: () => true, send: async () => { throw e; } });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.method, 'share'); assert.equal(r.ok, true); assert.equal(calls.share[0].length, 2);
});
test('shareTargetPicker 取消語意：resolve undefined／null／AbortError → aborted（不成功、不跳 manual、不打擾）', async () => {
  for (const res of [undefined, null]) {
    const { deps, calls } = sendMock({ canShare: () => true, shareResult: res });
    const r = await a4SendReport(itemsN(2), deps);
    assert.equal(r.ok, false); assert.equal(r.reason, 'aborted');
    assert.equal(calls.manual.length, 0, '取消不跳 manual');
  }
  const err = new Error('cancel'); err.name = 'AbortError';
  const { deps, calls } = sendMock({ canShare: () => true, share: async () => { throw err; } });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.reason, 'aborted'); assert.equal(calls.manual.length, 0);
});
test('shareTargetPicker 成功（resolve {status:success}）→ ok share', async () => {
  const { deps } = sendMock({ canShare: () => true, shareResult: { status: 'success' } });
  const r = await a4SendReport(itemsN(2), deps);
  assert.equal(r.ok, true); assert.equal(r.method, 'share');
});
test('a4ShareResultCancelled：undefined／null／{status:cancel} 皆取消；{status:success} 非取消', () => {
  assert.equal(a4ShareResultCancelled(undefined), true);
  assert.equal(a4ShareResultCancelled(null), true);
  assert.equal(a4ShareResultCancelled({ status: 'cancel' }), true);
  assert.equal(a4ShareResultCancelled({ status: 'success' }), false);
});
test('檔案規格：original>10MB 或 preview 縮不到 <=1MB（oversize）→ 不送 LINE、走 manual（image_too_large）', async () => {
  const items = itemsN(2); items[1].oversize = true;
  const { deps, calls } = sendMock({ canSend: () => true });
  const r = await a4SendReport(items, deps);
  assert.equal(r.ok, false); assert.equal(r.method, 'manual'); assert.equal(r.reason, 'image_too_large');
  assert.equal(calls.send.length, 0, '有超規格頁 → 完全不送 LINE');
  assert.equal(calls.manual[0].length, 2);
});
test('大小上限工具：original<=10MB、preview<=1MB 邊界', () => {
  assert.equal(a4WithinOriginalLimit(10 * 1024 * 1024), true);
  assert.equal(a4WithinOriginalLimit(10 * 1024 * 1024 + 1), false);
  assert.equal(a4WithinPreviewLimit(1024 * 1024), true);
  assert.equal(a4WithinPreviewLimit(1024 * 1024 + 1), false);
});
test('多頁順序：page1 → page2 → page3 順序不變', async () => {
  const msgs = a4BuildImageMessages(itemsN(3), 'https://cat.dev');
  assert.deepEqual(msgs.map((m) => m.originalContentUrl), ['https://cat.dev/shot/p1', 'https://cat.dev/shot/p2', 'https://cat.dev/shot/p3']);
});
test('preview 保險：>1MB 需另產較小 preview；≤1MB 不多產（沿用 original）', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(1_500_000);
  const small = 'data:image/png;base64,' + 'A'.repeat(100_000);
  assert.equal(a4NeedsSmallerPreview(big), true);
  assert.equal(a4NeedsSmallerPreview(small), false);
  assert.ok(dataUrlBytes(big) > 1024 * 1024 && dataUrlBytes(small) < 1024 * 1024);
});
test('preview 共用/獨立：previewUrl 空＝與 original 同網址；有值＝用該 preview', () => {
  const msgs = a4BuildImageMessages([{ url: '/shot/o', previewUrl: '' }, { url: '/shot/o2', previewUrl: '/shot/pv' }], 'https://cat.dev');
  assert.equal(msgs[0].previewImageUrl, 'https://cat.dev/shot/o');       // 共用
  assert.equal(msgs[1].previewImageUrl, 'https://cat.dev/shot/pv');      // 獨立 preview
});
