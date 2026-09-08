import { addDays, taipeiToday } from './util.js';
// Only aggregated counts leave the DB; no identities or care contents are embedded.
export async function loadAdminTrends(db,today=taipeiToday()) {
 const actor="COALESCE(NULLIF(recordedBy,''),NULLIF(lineUserId,''))";
 const valid="source IN ('line','web') AND date(createdAt) IS NOT NULL";
 const {results:days}=await db.prepare(`SELECT date(createdAt,'+8 hours') day,COUNT(*) records,COUNT(DISTINCT ${actor}) active FROM logs WHERE ${valid} AND date(createdAt,'+8 hours') BETWEEN ? AND ? GROUP BY day ORDER BY day`).bind(addDays(today,-180),today).all();
 const {results:first}=await db.prepare(`SELECT day,COUNT(*) newcomers FROM (SELECT ${actor} actor,MIN(date(createdAt,'+8 hours')) day FROM logs WHERE ${valid} AND ${actor} IS NOT NULL GROUP BY actor) WHERE day BETWEEN ? AND ? GROUP BY day`).bind(addDays(today,-180),today).all();
 const coverage=await db.prepare(`SELECT MIN(date(createdAt,'+8 hours')) start FROM logs WHERE ${valid}`).first();
 return {today,start:coverage?.start||null,days:days||[],first:first||[]};
}
export function renderAdminTrends(data) {
 const json=JSON.stringify(data).replace(/</g,'\\u003c');
 return `<section class="admin-trends" aria-label="每日使用趨勢"><div class="trend-toolbar"><h2>每日使用趨勢</h2><label>統計期間 <select id="trendPeriod"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select></label></div><p class="muted">依台灣時間與實際提交日期統計，今天累計中。</p><div id="trendCharts"></div><details class="method-note"><summary>折線圖怎麼計算？</summary><p>人數以實際記錄帳戶去重，包含共同照護者。只計 LINE 與管家頁面建立的紀錄，不含匯入來源；補登算在提交當天。後來刪除的紀錄仍計入成功新增筆數。最早可用紀錄之前留白；若歷史資料曾移除，無法還原。比較以完整日期為準，不含今天。</p></details><script type="application/json" id="trendData">${json}</script><script src="/admin-trends.js" defer></script></section>`;
}
