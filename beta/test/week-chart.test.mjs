// 近七天卡（weekFlex）：每天同時顯示「水分」與「熱量」兩條長條（與後台同色票）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekFlex } from '../src/flex.js';

function mkRows() {
  // 7 天：含一天無紀錄、一天有警示（嘔吐）
  const base = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06', '2026-02-07'];
  return base.map((date, i) => ({
    petId: 'p1', date,
    totalWaterMl: i === 2 ? 0 : 80 + i * 15,
    kcal: i === 2 ? 0 : 150 + i * 20,
    vomitCount: i === 5 ? 1 : 0, medIssueCount: 0,
    entryCount: i === 2 ? 0 : 3,
    kcalEstimated: false, kcalIncomplete: false
  }));
}

test('每天有水分＋熱量兩條長條（兩種主色都出現），且有圖例', () => {
  const s = JSON.stringify(weekFlex('蚵仔', mkRows()));
  assert.ok(s.includes('#2B7A66'), '水分色（湖水綠）應出現');
  assert.ok(s.includes('#5A4A84'), '熱量色（藕紫）應出現');
  assert.ok(s.includes('水分 ml') && s.includes('熱量 kcal'), '應有水分／熱量圖例');
});

test('每日兩條長條各自對 7 天高峰做比例（最高水分那天水分條＝100%）', () => {
  const rows = mkRows();
  const s = JSON.stringify(weekFlex('蚵仔', rows));
  // 最高水分 = 第 7 天（i=6）= 80+90=170 → 應出現 width:100%
  assert.ok(s.includes('"width":"100%"'), '高峰那天長條應為滿格');
});

test('無紀錄的那天不畫長條（顯示 —），不會假裝有資料', () => {
  const rows = mkRows();
  const s = JSON.stringify(weekFlex('蚵仔', rows));
  assert.ok(s.includes('—'), '無紀錄日以破折號表示');
});

test('alt text 同時提到日均水分與日均熱量', () => {
  const rows = mkRows();
  const flex = weekFlex('蚵仔', rows);
  assert.ok(flex.altText.includes('日均水分') && flex.altText.includes('日均熱量'), 'alt 應含兩個日均');
});
