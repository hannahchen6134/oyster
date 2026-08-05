// A4 回診摘要版型（純函式 buildA4Report）結構測試：斷言區塊、單一 rangeDays 一致、頁首/頁尾、
// 空狀態、分頁、日期不重不漏、估算標示、百分比湊 100%、體重稀疏、回診事項新→舊。
// 圖片實際 2480×3508 像素/清晰度屬瀏覽器渲染，需人工在手機（含 LINE LIFF）驗證，不假裝自動化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildA4Report } from '../public/a4-report.js';

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

test('回傳 { html, pages }，四大區塊＋頁首（毛孩/報告名/期間/產生日期/來源）＋頁尾免責齊全', () => {
  const { html, pages } = buildA4Report(baseData());
  assert.equal(typeof html, 'string');
  assert.ok(pages >= 2);
  for (const s of ['蚵仔', '回診摘要', '報告期間：', '產生日期：', '資料來源：', '體重・飲水・熱量趨勢', '飲食與水分組成', '回診重點事項', '每日照護明細']) {
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
