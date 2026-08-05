// A4 報告版型（純函式 buildA4Report）結構測試：斷言區塊、標題、數值、空狀態、分頁、日期不重不漏、
// 估算標示、無互動提示。列印像素/裁切屬瀏覽器視覺，需人工在 Chrome 列印預覽確認（此處不假裝自動化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildA4Report } from '../public/a4-report.js';

function daily(nDays) {
  const rows = [];
  for (let i = 0; i < nDays; i += 1) {
    const d = new Date(Date.UTC(2026, 6, 29) - i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, waterMl: 100 + i, wetG: 80, dryG: 15, kcal: 170 + i, kcalEstimated: false });
  }
  return rows; // 新→舊
}
function baseData(over = {}) {
  return {
    petName: '蚵仔', source: '喵喵照護站', dateRangeLabel: '2026-06-30 ~ 2026-07-29',
    generatedAt: '2026-07-29 12:30', trendRangeDays: 30, compRangeDays: 7, digestRangeDays: 14,
    weight: { latest: 4.18, unit: 'kg', points: [{ date: '2026-07-20', value: 4.2 }, { date: '2026-07-29', value: 4.18 }], deltaPct: -1 },
    water: { latest: 181, unit: 'ml', points: [{ date: '2026-07-28', value: 175 }, { date: '2026-07-29', value: 181 }], deltaPct: 12 },
    kcal: { latest: 175, unit: 'kcal', points: [{ date: '2026-07-28', value: 170 }, { date: '2026-07-29', value: 175 }], deltaPct: -2, estimated: false },
    digest: [{ date: '2026-07-26', typeLabel: '嘔吐', tone: 'warn', text: '晚上吐膠囊狀，疑似有點想吐' }],
    missedMed: null,
    composition: { rangeDays: 7, hasData: true, water: { total: 1567.4, own: 913.9, food: 653.5 }, food: { total: 956.3, dry: 139.3, wet: 817, other: 0 } },
    daily: daily(28),
    ...over
  };
}
const countOccurrences = (s, sub) => s.split(sub).length - 1;

test('完整資料：四大區塊＋頁首/頁尾/統計範圍/免責都在，第一頁摘要＋明細分頁', () => {
  const html = buildA4Report(baseData());
  for (const s of ['蚵仔', '照護紀錄', '飲食・飲水・熱量趨勢', '回診重點事項', '飲食與水分組成', '每日照護明細']) {
    assert.ok(html.includes(s), `應含「${s}」`);
  }
  assert.ok(html.includes('統計範圍：近 30 天') && html.includes('統計範圍：近 14 天') && html.includes('統計範圍：近 7 天'), '三種統計範圍標示');
  assert.ok(html.includes('不作為診斷依據'), '頁尾免責');
  assert.ok(html.includes('第 1 / 2 頁') && html.includes('第 2 / 2 頁'), '頁碼 1/2、2/2');
  assert.equal(countOccurrences(html, 'class="a4-page"'), 2, '28 天 → 2 頁（摘要＋明細）');
});

test('每日明細：日期不重不漏、五欄、單位在表頭', () => {
  const data = baseData();
  const html = buildA4Report(data);
  // 表頭五欄＋單位
  for (const h of ['日期', '水分', '濕食/罐頭', '乾糧', '熱量']) assert.ok(html.includes(h), `表頭含「${h}」`);
  assert.ok(html.includes('<small>ml</small>') && html.includes('<small>kcal</small>'), '單位在表頭');
  // 每一天在「明細表」都出現一次（不重不漏）——限定明細日期格 class，避免與回診重點同日期混算
  for (const r of data.daily) {
    const md = `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`;
    assert.equal(countOccurrences(html, `class="a4-td-date">${md}</td>`), 1, `明細日期 ${md} 應恰出現一次`);
  }
});

test('沒有體重：顯示「目前尚無體重紀錄」＋照護站補充小字，不出現互動提示', () => {
  const html = buildA4Report(baseData({ weight: { latest: null, unit: 'kg', points: [], deltaPct: null } }));
  assert.ok(html.includes('目前尚無體重紀錄'));
  assert.ok(html.includes('可於照護站補充體重紀錄'));
  assert.ok(!html.includes('＋記體重') && !html.includes('＋記錄體重') && !html.includes('點右上角'), '不得有互動按鈕/提示');
});

test('沒有症狀/備註：顯示「此期間尚無症狀或備註紀錄」，卡片仍在', () => {
  const html = buildA4Report(baseData({ digest: [], missedMed: null }));
  assert.ok(html.includes('此期間尚無症狀或備註紀錄'));
  assert.ok(html.includes('回診重點事項'), '卡片標題仍在');
});

test('只有一天資料：不破版、明細頁只列一列、頁碼 2/2', () => {
  const html = buildA4Report(baseData({ daily: daily(1) }));
  assert.equal(countOccurrences(html, 'class="a4-page"'), 2);
  assert.equal(countOccurrences(html, 'class="a4-daily"'), 1);
  assert.ok(html.includes('第 2 / 2 頁'));
});

test('很長症狀文字：完整呈現、不截斷成省略號', () => {
  const long = '連續三天晚上都在半夜嘔吐透明帶泡沫的液體，量不多但次數變多，白天食慾略降，喝水正常，已預約回診請醫生評估腸胃狀況與是否需要進一步檢查';
  const html = buildA4Report(baseData({ digest: [{ date: '2026-07-26', typeLabel: '備註', tone: 'note', text: long }] }));
  assert.ok(html.includes(long), '長文字完整保留');
  assert.ok(!html.includes('…') && !html.includes('...'), '不得出現省略號');
});

test('很長毛孩名稱：頁首不遺失名稱（不裁字）', () => {
  const name = '大橘子波波毛毛蟲隊長三世';
  const html = buildA4Report(baseData({ petName: name }));
  assert.ok(html.includes(name));
});

test('估算熱量：明細標「估」上標，不冒充精確值', () => {
  const rows = daily(3);
  rows[0].kcalEstimated = true;
  const html = buildA4Report(baseData({ daily: rows }));
  assert.ok(html.includes('a4-est-mark') && html.includes('估'), '估算列有「估」標示');
});

test('大量資料（40 天）自然分頁：明細跨多頁，頁數正確', () => {
  const html = buildA4Report(baseData({ daily: daily(40) }));
  // 1 摘要頁 + ceil(40/30)=2 明細頁 = 3 頁
  assert.equal(countOccurrences(html, 'class="a4-page"'), 3);
  assert.ok(html.includes('第 3 / 3 頁'));
  assert.ok(html.includes('每日照護明細（1/2）') && html.includes('每日照護明細（2/2）'), '明細分頁標序');
});

test('空資料整體：不丟例外，仍輸出頁首/免責/「尚無」文字', () => {
  const html = buildA4Report({ petName: '小白', daily: [] });
  assert.ok(html.includes('小白') && html.includes('照護紀錄'));
  assert.ok(html.includes('此期間尚無每日紀錄'));
  assert.ok(html.includes('不作為診斷依據'));
});
