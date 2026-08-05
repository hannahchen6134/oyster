// A4 照護報告版型（純函式，資料 → HTML 字串）。
// 只負責「把已算好的 report data 排成 A4 版面」，不抓資料、不重算、不改數值定義。
// 由 index.html 以 <script type="module"> 載入並掛到 window.buildA4Report；node 測試直接 import。
// 圖表用 inline SVG（向量，列印清晰、可選取文字；不轉整頁圖片、不引入 PDF 套件）。

const ROWS_PER_PAGE = 30; // 每日明細每頁列數（A4 可用高度下 ≥ 8.5pt 仍清楚；超過就自然分頁）

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function n0(v) { return String(Math.round(Number(v) || 0)); }
function n1(v) { const x = Math.round((Number(v) || 0) * 10) / 10; return String(x); }
function n2(v) { return (Number(v) || 0).toFixed(2); }
function pctOf(v, tot) { return tot > 0 ? Math.round((Number(v) || 0) / tot * 100) : 0; }
function mmdd(date) { const s = String(date || ''); return s.length >= 10 ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : s; }

// 與 deltaBadge 同定義：回文字箭頭（列印黑白也可讀），不只靠顏色
function deltaText(pct) {
  if (pct == null) return '';
  if (pct === 0) return '<span class="a4-delta">→ 持平</span>';
  return `<span class="a4-delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
}

// 迷你折線圖：points=[{date,value|null}]，null 為缺值不連線（稀疏點也可只畫點）
function sparkline(points, color, opts = {}) {
  const W = 300, H = 64, padX = 4, padT = 8, padB = 8;
  const vals = points.map((p) => (p && p.value != null ? Number(p.value) : null));
  const nums = vals.filter((v) => v != null);
  if (nums.length === 0) return `<svg class="a4-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  let min = Math.min(...nums), max = Math.max(...nums);
  if (min === max) { min -= 1; max += 1; }
  const n = vals.length;
  const x = (i) => padX + (n <= 1 ? (W - 2 * padX) / 2 : (i / (n - 1)) * (W - 2 * padX));
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  let d = '';
  let dots = '';
  let started = false;
  vals.forEach((v, i) => {
    if (v == null) { started = false; return; }
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    started = true;
    if (opts.dots) dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${color}"/>`;
  });
  const line = d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  return `<svg class="a4-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${line}${dots}</svg>`;
}

function pageHeader(d, { compact } = {}) {
  const title = `${esc(d.petName || '毛孩')}・照護紀錄`;
  if (compact) {
    return `<div class="a4-rhead"><span class="a4-rhead-name">${title}</span><span class="a4-rhead-range">${esc(d.dateRangeLabel || '')}</span></div>`;
  }
  return `
    <header class="a4-head">
      <div class="a4-head-main">
        <div class="a4-head-name">${esc(d.petName || '毛孩')}</div>
        <h1 class="a4-head-title">照護紀錄</h1>
      </div>
      <div class="a4-head-meta">
        <div>報告期間：${esc(d.dateRangeLabel || '—')}</div>
        <div>產生時間：${esc(d.generatedAt || '')}</div>
        <div>來源：${esc(d.source || '喵喵照護站')}</div>
      </div>
    </header>`;
}

function pageFooter(d, pageNo, totalPages) {
  return `
    <footer class="a4-foot">
      <p class="a4-disc">※ 本報告整理自飼主日常紀錄，可能存在遺漏或誤差，僅供回診溝通與照護參考，不作為診斷依據，實際狀況請由獸醫師判斷。</p>
      <div class="a4-foot-row">
        <span>${esc(d.source || '喵喵照護站')}</span>
        <span>${esc(d.generatedAt || '')}</span>
        <span>第 ${pageNo} / ${totalPages} 頁</span>
      </div>
    </footer>`;
}

function trendSection(d) {
  const w = d.weight || {};
  const water = d.water || {};
  const kcal = d.kcal || {};
  const weightBody = (w.latest != null)
    ? `<div class="a4-metric-val">${n2(w.latest)}<small>kg</small> ${deltaText(w.deltaPct)}</div>
       ${sparkline(w.points || [], '#734921', { dots: true })}`
    : `<div class="a4-empty-sm">目前尚無體重紀錄<span>可於照護站補充體重紀錄</span></div>`;
  const kcalNote = kcal.estimated ? '<span class="a4-est">部分為估算</span>' : '';
  return `
    <section class="a4-card">
      <h2 class="a4-h2">飲食・飲水・熱量趨勢<span class="a4-range">統計範圍：近 ${esc(String(d.trendRangeDays || 30))} 天</span></h2>
      <div class="a4-metrics">
        <div class="a4-metric">
          <div class="a4-metric-t">體重</div>
          ${weightBody}
        </div>
        <div class="a4-metric">
          <div class="a4-metric-t">總水分（最近一日）</div>
          <div class="a4-metric-val" style="color:#1e7a52">${n0(water.latest)}<small>ml</small> ${deltaText(water.deltaPct)}</div>
          ${sparkline(water.points || [], '#1e7a52')}
        </div>
        <div class="a4-metric">
          <div class="a4-metric-t">熱量（最近一日）${kcalNote}</div>
          <div class="a4-metric-val" style="color:#b3703f">${n0(kcal.latest)}<small>kcal</small> ${deltaText(kcal.deltaPct)}</div>
          ${sparkline(kcal.points || [], '#b3703f')}
        </div>
      </div>
    </section>`;
}

function digestSection(d) {
  const items = Array.isArray(d.digest) ? d.digest : [];
  const missed = d.missedMed && d.missedMed.count > 0
    ? `<div class="a4-flag">⚠ 近 ${esc(String(d.digestRangeDays || 14))} 天漏藥 ${d.missedMed.count} 天（${esc((d.missedMed.days || []).map(mmdd).join('、'))}）</div>`
    : '';
  const body = items.length
    ? `<table class="a4-digest"><tbody>${items.map((it) => `
        <tr>
          <td class="a4-dg-date">${esc(mmdd(it.date))}</td>
          <td class="a4-dg-type"><span class="a4-tag">${esc(it.typeLabel || '備註')}</span></td>
          <td class="a4-dg-text">${esc(it.text || '')}</td>
        </tr>`).join('')}</tbody></table>`
    : (missed ? '' : '<div class="a4-empty-sm">此期間尚無症狀或備註紀錄</div>');
  return `
    <section class="a4-card">
      <h2 class="a4-h2">回診重點事項<span class="a4-range">統計範圍：近 ${esc(String(d.digestRangeDays || 14))} 天</span></h2>
      ${missed}
      ${body}
    </section>`;
}

function bar(segs) {
  return `<div class="a4-bar">${segs.filter((s) => s.v > 0).map((s) => `<i style="width:${Math.max(2, s.v / s.tot * 100)}%;background:${s.color}"></i>`).join('')}</div>`;
}
function legendRow(color, label, v, tot, unit) {
  return `<div class="a4-lg"><span class="a4-dot" style="background:${color}"></span><span class="a4-lg-nm">${esc(label)}</span><span class="a4-lg-v">${n1(v)} ${unit}</span><span class="a4-lg-p">${pctOf(v, tot)}%</span></div>`;
}
function compositionSection(d) {
  const c = d.composition || {};
  if (!c.hasData) {
    return `<section class="a4-card"><h2 class="a4-h2">飲食與水分組成<span class="a4-range">統計範圍：近 ${esc(String(c.rangeDays || 7))} 天</span></h2><div class="a4-empty-sm">此期間尚無吃喝紀錄</div></section>`;
  }
  const W = '#2B7A66', W2 = '#8FB7A8', DRY = '#B07C2E', WET = '#5C7031', OTH = '#C2B29A';
  const w = c.water || {}; const f = c.food || {};
  const foodBlock = (f.total > 0) ? `
      <div class="a4-comp-block">
        <div class="a4-comp-h"><span>飲食組成</span><b>${n1(f.total)} <small>g 合計</small></b></div>
        ${bar([{ v: f.dry, tot: f.total, color: DRY }, { v: f.wet, tot: f.total, color: WET }, { v: f.other, tot: f.total, color: OTH }])}
        <div class="a4-legend">
          ${f.dry > 0 ? legendRow(DRY, '乾糧', f.dry, f.total, 'g') : ''}
          ${f.wet > 0 ? legendRow(WET, '濕食', f.wet, f.total, 'g') : ''}
          ${f.other > 0 ? legendRow(OTH, '其他', f.other, f.total, 'g') : ''}
        </div>
      </div>` : '';
  return `
    <section class="a4-card">
      <h2 class="a4-h2">飲食與水分組成<span class="a4-range">統計範圍：近 ${esc(String(c.rangeDays || 7))} 天</span></h2>
      <div class="a4-comp">
        <div class="a4-comp-block">
          <div class="a4-comp-h"><span>水分來源</span><b>${n1(w.total)} <small>ml 合計</small></b></div>
          ${bar([{ v: w.own, tot: w.total, color: W }, { v: w.food, tot: w.total, color: W2 }])}
          <div class="a4-legend">
            ${legendRow(W, '自己喝的水', w.own, w.total, 'ml')}
            ${legendRow(W2, '食物內含的水', w.food, w.total, 'ml')}
          </div>
        </div>
        ${foodBlock}
      </div>
    </section>`;
}

function dailyTable(rows) {
  const head = `<thead><tr>
    <th class="a4-td-date">日期</th>
    <th>水分<small>ml</small></th>
    <th>濕食/罐頭<small>g</small></th>
    <th>乾糧<small>g</small></th>
    <th>熱量<small>kcal</small></th>
  </tr></thead>`;
  const body = rows.map((r) => `<tr>
    <td class="a4-td-date">${esc(mmdd(r.date))}</td>
    <td>${n0(r.waterMl)}</td>
    <td>${n0(r.wetG)}</td>
    <td>${n0(r.dryG)}</td>
    <td>${n0(r.kcal)}${r.kcalEstimated ? '<sup class="a4-est-mark">估</sup>' : ''}</td>
  </tr>`).join('');
  return `<table class="a4-daily">${head}<tbody>${body}</tbody></table>`;
}

function totalPagesFor(d) {
  const rows = Array.isArray(d.daily) ? d.daily : [];
  return 1 + Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE) || 1) - (rows.length ? 0 : 0);
}

export function buildA4Report(data) {
  const d = data || {};
  const rows = Array.isArray(d.daily) ? d.daily.filter((r) => r && r.date) : [];
  const chunks = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) chunks.push(rows.slice(i, i + ROWS_PER_PAGE));
  const detailPages = chunks.length || 1; // 至少一頁（即使無資料也顯示「尚無資料」）
  const totalPages = 1 + detailPages;

  const pages = [];
  // 第 1 頁：摘要（頁首＋趨勢＋回診重點＋組成）
  pages.push(`
    <div class="a4-page">
      <div class="a4-body">
        ${pageHeader(d)}
        ${trendSection(d)}
        ${digestSection(d)}
        ${compositionSection(d)}
      </div>
      ${pageFooter(d, 1, totalPages)}
    </div>`);
  // 第 2 頁起：每日照護明細
  (chunks.length ? chunks : [[]]).forEach((chunk, idx) => {
    const inner = chunk.length ? dailyTable(chunk) : '<div class="a4-empty-sm">此期間尚無每日紀錄</div>';
    pages.push(`
      <div class="a4-page">
        <div class="a4-body">
          ${pageHeader(d, { compact: true })}
          <h2 class="a4-h2 a4-h2-page">每日照護明細${detailPages > 1 ? `（${idx + 1}/${detailPages}）` : ''}<span class="a4-range">日期新→舊，單位見表頭</span></h2>
          ${inner}
        </div>
        ${pageFooter(d, 2 + idx, totalPages)}
      </div>`);
  });
  return `<div class="a4-doc">${pages.join('')}</div>`;
}

if (typeof window !== 'undefined') window.buildA4Report = buildA4Report;
