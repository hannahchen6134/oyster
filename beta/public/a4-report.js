// A4 回診摘要版型（純函式，資料 → HTML 字串）。只排版、不抓資料、不重算、不改數值定義。
// 由 index.html 以 <script type="module"> 載入並掛到 window.buildA4Report；node 測試直接 import。
// 供「存成照片給醫生」離屏渲染成 2480×3508 PNG（每頁一張）。圖表用 inline SVG（向量、清晰）。
// 版面：第1頁 頁首＋體重/水分/熱量趨勢；第2頁起 水分來源＋飲食組成＋回診重點；之後 每日照護明細。

const DAILY_PER_PAGE = 26;   // 每頁明細列數（A4 下 ≥8.5pt 仍清楚）
const DIGEST_PER_PAGE = 16;  // 每頁回診重點列數

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function n0(v) { return String(Math.round(Number(v) || 0)); }
function n1(v) { return String(Math.round((Number(v) || 0) * 10) / 10); }
// 體重顯示（與 src/util.js formatWeightKg 相同規則）：最多兩位小數、移除尾端 0、不降精度（4.27→4.27、4.2→4.2）
function formatWeightKg(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : ''; }
function mmdd(date) { const s = String(date || ''); return s.length >= 10 ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : s; }

// 百分比湊 100：先各自四捨五入，再把餘數補到最大的一項，避免顯示 33%+33%+33%=99%
function pcts(values, total) {
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (Number(v) || 0) / total * 100);
  const rounded = raw.map((x) => Math.round(x));
  let diff = 100 - rounded.reduce((t, x) => t + x, 0);
  if (diff !== 0) {
    // 補到數值最大的一項（且 >0）
    let idx = -1, best = -1;
    values.forEach((v, i) => { if (v > 0 && v > best) { best = v; idx = i; } });
    if (idx >= 0) rounded[idx] += diff;
  }
  return rounded;
}

function deltaText(pct) {
  if (pct == null) return '';
  if (pct === 0) return '<span class="a4-delta">→ 持平</span>';
  return `<span class="a4-delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
}

// 迷你折線圖：points=[{date,value|null}]，null 不連線。dotsOnly＝只畫點（稀疏體重用，不畫誤導趨勢線）。
function sparkline(points, color, opts = {}) {
  const W = 520, H = 120, padX = 6, padT = 12, padB = 12;
  const vals = points.map((p) => (p && p.value != null ? Number(p.value) : null));
  const nums = vals.filter((v) => v != null);
  if (nums.length === 0) return `<svg class="a4-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  let min = Math.min(...nums), max = Math.max(...nums);
  if (min === max) { min -= 1; max += 1; }
  const n = vals.length;
  const x = (i) => padX + (n <= 1 ? (W - 2 * padX) / 2 : (i / (n - 1)) * (W - 2 * padX));
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  let d = '', dots = '', started = false;
  vals.forEach((v, i) => {
    if (v == null) { started = false; return; }
    if (!opts.dotsOnly) { d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; started = true; }
    if (opts.dots || opts.dotsOnly) dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2" fill="${color}"/>`;
  });
  const line = d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  return `<svg class="a4-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${line}${dots}</svg>`;
}

function fullHeader(d) {
  const avatar = d.avatarUrl ? `<img class="a4-avatar" src="${esc(d.avatarUrl)}" alt="">` : '';
  return `
    <header class="a4-head">
      <div class="a4-head-l">
        ${avatar}
        <div>
          <div class="a4-head-name">${esc(d.petName || '毛孩')}</div>
          <h1 class="a4-head-title">${esc(d.reportName || '回診摘要')}</h1>
        </div>
      </div>
      <div class="a4-head-meta">
        <div><b>報告期間：</b>${esc(d.dateRangeLabel || '—')}</div>
        <div><b>產生日期：</b>${esc(d.generatedAt || '')}</div>
        <div><b>資料來源：</b>${esc(d.source || '喵喵照護站')}</div>
      </div>
    </header>`;
}
function miniHeader(d) {
  return `<div class="a4-rhead"><span class="a4-rhead-name">${esc(d.petName || '毛孩')}・${esc(d.reportName || '回診摘要')}</span><span class="a4-rhead-range">${esc(d.dateRangeLabel || '')}</span></div>`;
}
function pageFooter(d, pageNo, totalPages) {
  return `
    <footer class="a4-foot">
      <p class="a4-disc">※ 本報告整理自飼主日常紀錄，可能存在遺漏或誤差，僅供回診溝通與照護參考，不作為診斷依據，實際狀況請由獸醫師判斷。</p>
      <div class="a4-foot-row"><span>${esc(d.source || '喵喵照護站')}</span><span>${esc(d.generatedAt || '')}</span><span>${pageNo}／${totalPages}</span></div>
    </footer>`;
}

function metricCard(title, valueHtml, spark, note) {
  return `<div class="a4-metric"><div class="a4-metric-t">${title}${note ? `<span class="a4-mnote">${note}</span>` : ''}</div><div class="a4-metric-val">${valueHtml}</div>${spark || ''}</div>`;
}
function trendSection(d) {
  const w = d.weight || {}, water = d.water || {}, kcal = d.kcal || {};
  // 體重：資料點少（<3）不畫趨勢線，只畫點＋文字，避免誤導
  let weightCard;
  if (w.latest == null) {
    weightCard = metricCard('體重', '<span class="a4-none">尚無體重紀錄</span><span class="a4-sub">可於照護站補充</span>', '');
  } else if ((w.count || 0) < 3) {
    const trend = w.deltaPct == null || w.deltaPct === 0 ? '體重持平' : (w.deltaPct > 0 ? '體重略升' : '體重略降');
    weightCard = metricCard('體重', `${formatWeightKg(w.latest)}<small>kg</small>`, sparkline(w.points || [], '#734921', { dotsOnly: true }), `近期紀錄 ${w.count} 筆・${trend}`);
  } else {
    weightCard = metricCard('體重', `${formatWeightKg(w.latest)}<small>kg</small> ${deltaText(w.deltaPct)}`, sparkline(w.points || [], '#734921', { dots: true }));
  }
  const kcalNote = kcal.estimated ? '<span class="a4-est">部分估算</span>' : '';
  return `
    <section class="a4-card">
      <h2 class="a4-h2">體重・飲水・熱量趨勢<span class="a4-range">近 ${esc(String(d.rangeDays || 14))} 天</span></h2>
      <div class="a4-metrics">
        ${weightCard}
        ${metricCard('總水分（最近一日）', `${n0(water.latest)}<small>ml</small> ${deltaText(water.deltaPct)}`, sparkline(water.points || [], '#1e7a52'))}
        ${metricCard(`熱量（最近一日）${kcalNote}`, `${n0(kcal.latest)}<small>kcal</small> ${deltaText(kcal.deltaPct)}`, sparkline(kcal.points || [], '#b3703f'))}
      </div>
      <p class="a4-cmp">↑／↓ 百分比＝「最近 7 天平均」與「前 7 天平均」相比（體重為最近兩次量測相比）。</p>
    </section>`;
}

function bar(segs) {
  return `<div class="a4-bar">${segs.filter((s) => s.v > 0).map((s) => `<i style="width:${Math.max(2, s.v / s.tot * 100)}%;background:${s.color}"></i>`).join('')}</div>`;
}
function compositionSection(d) {
  const c = d.composition || {};
  const rangeTag = `<span class="a4-range">近 ${esc(String(d.rangeDays || 14))} 天</span>`;
  if (!c.hasData) {
    return `<section class="a4-card"><h2 class="a4-h2">飲食與水分組成${rangeTag}</h2><div class="a4-empty">此期間無紀錄</div></section>`;
  }
  const W1 = '#2B7A66', W2 = '#8FB7A8', DRY = '#B07C2E', WET = '#5C7031', OTH = '#C2B29A';
  const w = c.water || {}, f = c.food || {};
  const wp = pcts([w.own, w.food], w.total);
  const legend = (color, label, v, unit, p) => `<div class="a4-lg"><span class="a4-dot" style="background:${color}"></span><span class="a4-lg-nm">${label}</span><span class="a4-lg-v">${n1(v)} ${unit}</span><span class="a4-lg-p">${p}%</span></div>`;
  let foodBlock = '';
  if (f.total > 0) {
    const fp = pcts([f.dry, f.wet, f.other], f.total);
    foodBlock = `
      <div class="a4-comp-block">
        <div class="a4-comp-h"><span>飲食組成</span><b>${n1(f.total)} <small>g 合計</small></b></div>
        ${bar([{ v: f.dry, tot: f.total, color: DRY }, { v: f.wet, tot: f.total, color: WET }, { v: f.other, tot: f.total, color: OTH }])}
        <div class="a4-legend">
          ${f.dry > 0 ? legend(DRY, '乾糧', f.dry, 'g', fp[0]) : ''}
          ${f.wet > 0 ? legend(WET, '濕食', f.wet, 'g', fp[1]) : ''}
          ${f.other > 0 ? legend(OTH, '其他', f.other, 'g', fp[2]) : ''}
        </div>
      </div>`;
  }
  return `
    <section class="a4-card">
      <h2 class="a4-h2">飲食與水分組成${rangeTag}</h2>
      <div class="a4-comp">
        <div class="a4-comp-block">
          <div class="a4-comp-h"><span>水分來源</span><b>${n1(w.total)} <small>ml 合計</small></b></div>
          ${bar([{ v: w.own, tot: w.total, color: W1 }, { v: w.food, tot: w.total, color: W2 }])}
          <div class="a4-legend">
            ${legend(W1, '自己喝的水', w.own, 'ml', wp[0])}
            ${legend(W2, '食物內含的水', w.food, 'ml', wp[1])}
          </div>
        </div>
        ${foodBlock}
      </div>
    </section>`;
}

function digestSection(d, rows, part, parts) {
  const missed = d.missedMed && d.missedMed.count > 0
    ? `<div class="a4-flag">⚠ 近 ${esc(String(d.rangeDays || 14))} 天漏藥 ${d.missedMed.count} 天（${esc((d.missedMed.days || []).map(mmdd).join('、'))}）</div>`
    : '';
  const suffix = parts > 1 ? `（${part}/${parts}）` : '';
  const body = rows.length
    ? `<table class="a4-digest"><tbody>${rows.map((it) => `
        <tr>
          <td class="a4-dg-date">${esc(mmdd(it.date))}${it.time ? `<div class="a4-dg-time">${esc(it.time)}</div>` : ''}</td>
          <td class="a4-dg-type"><span class="a4-tag t-${esc(it.tone || 'note')}">${esc(it.typeLabel || '備註')}</span></td>
          <td class="a4-dg-text">${esc(it.text || '')}</td>
        </tr>`).join('')}</tbody></table>`
    : (part === 1 && !missed ? '<div class="a4-empty">此期間無症狀或備註紀錄</div>' : '');
  return `
    <section class="a4-card">
      <h2 class="a4-h2">回診重點事項${suffix}<span class="a4-range">近 ${esc(String(d.rangeDays || 14))} 天・新→舊</span></h2>
      ${part === 1 ? missed : ''}
      ${body}
    </section>`;
}

function dailyTable(rows) {
  const head = `<thead><tr>
    <th class="a4-td-date">日期</th><th>水分<small>ml</small></th><th>濕食/罐頭<small>g</small></th><th>乾糧<small>g</small></th><th>熱量<small>kcal</small></th>
  </tr></thead>`;
  const body = rows.map((r) => `<tr>
    <td class="a4-td-date">${esc(mmdd(r.date))}</td><td>${n0(r.waterMl)}</td><td>${n0(r.wetG)}</td><td>${n0(r.dryG)}</td><td>${n0(r.kcal)}${r.kcalEstimated ? '<sup class="a4-est-mark">估</sup>' : ''}</td>
  </tr>`).join('');
  return `<table class="a4-daily">${head}<tbody>${body}</tbody></table>`;
}

function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

// 各區塊估算高度（px，96dpi；保守略估上界，寧可稍留白也不要塞爆被裁）。用於「一頁塞滿才換頁」的貪婪打包。
function estCompositionH(d) { const c = d.composition || {}; if (!c.hasData) return 100; return (c.food && c.food.total > 0) ? 230 : 150; }

// 依內容高度把區塊「一頁塞滿才換頁」，杜絕每頁只放一區塊而下方大片空白。回傳 { html, pages }。
export function buildA4Report(data) {
  const d = data || {};
  const digest = (Array.isArray(d.digest) ? d.digest : []).slice()
    .sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`)); // 新→舊
  const daily = (Array.isArray(d.daily) ? d.daily : []).filter((r) => r && r.date);

  // 1) 組出可獨立擺放的區塊（每塊 break-inside 不切開），並估算高度
  const blocks = [];
  blocks.push({ h: 230, html: trendSection(d) });
  blocks.push({ h: estCompositionH(d), html: compositionSection(d) });
  const digestChunks = chunk(digest, DIGEST_PER_PAGE);
  const dParts = Math.max(1, digestChunks.length);
  (digestChunks.length ? digestChunks : [[]]).forEach((c, i) => {
    const missedH = (i === 0 && d.missedMed && d.missedMed.count > 0) ? 46 : 0;
    blocks.push({ h: 60 + missedH + (c.length ? c.length * 36 : 60), html: digestSection(d, c, i + 1, dParts) });
  });
  const dayChunks = daily.length ? chunk(daily, DAILY_PER_PAGE) : [[]];
  dayChunks.forEach((c, i) => {
    const inner = c.length ? dailyTable(c) : '<div class="a4-empty">此期間尚無每日紀錄</div>';
    const suffix = dayChunks.length > 1 ? `（${i + 1}/${dayChunks.length}）` : '';
    blocks.push({ h: 60 + (c.length ? 30 + c.length * 31 : 70), html: `<section class="a4-card"><h2 class="a4-h2 a4-h2-page">每日照護明細${suffix}<span class="a4-range">日期新→舊，單位見表頭</span></h2>${inner}</section>` });
  });

  // 2) 貪婪打包：一頁塞到快滿才換頁（第1頁完整頁首較高、之後精簡頁首）
  const PAGE = 1123, PAD = 92, FOOTER = 80, HFULL = 100, HMINI = 40;
  const cap = (isFirst) => PAGE - PAD - FOOTER - (isFirst ? HFULL : HMINI);
  const pageBlocks = [];
  let cur = [], curH = 0;
  for (const b of blocks) {
    const capNow = cap(pageBlocks.length === 0);
    if (cur.length && curH + b.h > capNow) { pageBlocks.push(cur); cur = []; curH = 0; }
    cur.push(b.html); curH += b.h;
  }
  if (cur.length) pageBlocks.push(cur);

  const total = pageBlocks.length || 1;
  const pages = (pageBlocks.length ? pageBlocks : [['']]).map((arr, i) =>
    `<div class="a4-page"><div class="a4-body">${i === 0 ? fullHeader(d) : miniHeader(d)}${arr.join('')}</div>${pageFooter(d, i + 1, total)}</div>`).join('');
  return { html: `<div class="a4-doc">${pages}</div>`, pages: total };
}

// 多頁報告的檔名：單頁＝base.png；多頁＝base_1.png、base_2.png…（每頁獨立、可辨識頁碼）
export function a4PageFilenames(base, total) {
  const b = String(base || '報告');
  const n = Math.max(1, Number(total) || 1);
  if (n === 1) return [`${b}.png`];
  return Array.from({ length: n }, (_, i) => `${b}_${i + 1}.png`);
}

// 一次分享全部：把每一頁各自的 dataUrl → 獨立 Blob/File，全部交給系統分享面板。
// 以相依注入（deps）讓瀏覽器 API 可測：{ fetchBlob(dataUrl)->Blob, makeFile(blob,name)->File,
// canShare(files)->bool, share(files)->Promise }。支援多檔才分享；不支援回 needManual（不假裝成功）。
export async function a4ShareAll(items, deps) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { shared: 0, pages: 0, needManual: false };
  const files = [];
  for (const it of list) files.push(deps.makeFile(await deps.fetchBlob(it.dataUrl), it.name));
  if (deps.canShare(files)) { await deps.share(files); return { shared: files.length, pages: list.length, needManual: false }; }
  return { shared: 0, pages: list.length, needManual: true }; // 裝置不支援多檔分享 → 請改用每頁儲存
}

// 儲存/分享「單一頁」：必須用該 pageIndex 自己的 dataUrl/檔名，不得永遠指向第 1 頁。
export async function a4SharePage(items, idx, deps) {
  const list = Array.isArray(items) ? items : [];
  const it = list[idx];
  if (!it) return { shared: 0, needManual: false, error: 'no_such_page' };
  const file = deps.makeFile(await deps.fetchBlob(it.dataUrl), it.name);
  if (deps.canShare([file])) { await deps.share([file]); return { shared: 1, name: it.name, needManual: false }; }
  return { shared: 0, name: it.name, needManual: true }; // 不支援分享 → 提示長按這一頁
}

if (typeof window !== 'undefined') {
  window.buildA4Report = buildA4Report;
  window.a4PageFilenames = a4PageFilenames;
  window.a4ShareAll = a4ShareAll;
  window.a4SharePage = a4SharePage;
}
