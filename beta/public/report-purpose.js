// 報告用途整理：只使用已授權取得的指定貓資料，不從歷史紀錄推論照護指示。
const clean = (v) => String(v ?? '').trim();
const list = (v) => Array.isArray(v) ? v : [];
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
export const escapeReport = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function careDefaults(pet, meds, vets) {
  const vet = list(vets).find((v) => v.vetId === pet.defaultVetId);
  return {
    feeding: '',
    medicine: list(meds).filter((m) => !m.isDeleted && m.petId === pet.petId).map((m) => [m.medName, num(m.doseAmount) > 0 ? `${m.doseAmount}${m.doseUnit || ''}` : '', m.schedule, m.defaultTimes, m.instruction, m.note].filter(Boolean).join(' · ')).join('\n'),
    notes: clean(pet.conditionNote),
    emergency: vet ? [vet.hospitalName, vet.doctorName, vet.phone, vet.address].filter(Boolean).join(' · ') : ''
  };
}
export function careRecentRecords(petId, logs = [], from = '', to = '9999-12-31') {
  const sorted = list(logs).filter(r => r.petId === petId && !r.isDeleted && clean(r.eventDateTime).slice(0,10) >= from && clean(r.eventDateTime).slice(0,10) <= to).sort((a,b) => clean(b.eventDateTime).localeCompare(clean(a.eventDateTime)));
  return [['food','最近餵食紀錄'],['water','最近喝水紀錄'],['med','最近用藥紀錄']].flatMap(([category,label]) => {
    const row = sorted.find(r => r.category === category);
    return row ? [{label,text:`${row.eventDateTime}｜${[row.itemName,category === 'med' ? row.doseText : num(row.amount) > 0 ? `${row.amount}${row.unit || ''}` : '',category === 'med' ? row.medStatus || '狀態未填' : '',row.note].filter(Boolean).join(' · ') || '已記錄'}`}] : [];
  });
}
export function purposeReport({ purpose = 'doctor', pet, rows = [], highlights = [], weights = [], recentLogs = [], draft = {}, from, to, days = 14 }) {
  const sections = [];
  const add = (title, items, kind = '') => {
    const values = list(items).map(clean).filter(Boolean);
    if (values.length) sections.push({ title, items: values, kind });
  };
  const inRange = (date) => date >= from && date <= to;
  const recent = list(rows).filter((r) => inRange(r.date) && num(r.entryCount) > 0).sort((a,b) => a.date.localeCompare(b.date));
  const events = list(highlights).filter((r) => inRange(clean(r.eventDateTime).slice(0,10)));
  const labels = { vomit: '嘔吐', stool: '排便', urine: '排尿', mood: '精神', note: '觀察', vaccine: '疫苗', deworm: '驅蟲' };
  const eventText = (r) => `${r.eventDateTime}｜${labels[r.category] || '紀錄'}：${[r.itemName, num(r.amount) ? `${r.amount}${r.unit || ''}` : '', r.note].filter(Boolean).join('，') || '已記錄'}`;
  const abnormal = events.filter((r) => ['vomit','stool','urine','mood'].includes(r.category) && !/^(正常|成形|普通|良好)$/.test(clean(r.note))).sort((a,b) => b.eventDateTime.localeCompare(a.eventDateTime));
  if (purpose === 'care') {
    add('交接前最近紀錄（非本次安排）', careRecentRecords(pet.petId,recentLogs,from,to).map(r=>`${r.label}：${r.text}`), 'history');
    add('餵食與飲水', [draft.feeding]);
    add('用藥方式', [draft.medicine]);
    add('用品位置', [draft.supplies]);
    add('照顧注意事項', [draft.notes]);
    add('緊急聯絡與處理方式', [draft.emergency]);
    // 明確區分過去的觀察，絕不作為未來的餵食／用藥命令。
    add('最近已記錄的狀況（供觀察）', abnormal.slice(0, 5).map(eventText), 'history');
  } else {
    add('這次最想讓醫生知道', [draft.concern]);
    add('近期異常與症狀', abnormal.slice(0, 5).map(eventText), 'important');
    const ws = list(weights).filter((w) => inRange(w.date) && num(w.amount) > 0).sort((a,b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
    if (ws.length) {
      const first = ws[0], last = ws.at(-1);
      add('體重紀錄', [ws.length === 1 ? `${last.date}：${last.amount} kg（此期間 1 筆）` : `${first.date} ${first.amount} kg → ${last.date} ${last.amount} kg（此期間 ${ws.length} 筆）`]);
    }
    const medLines = [], medCounts = new Map();
    for (const r of recent.slice().reverse()) {
      let meds = []; try { meds = Array.isArray(r.medJson) ? r.medJson : JSON.parse(r.medJson || '[]'); } catch { /* 缺漏不推測 */ }
      for (const m of list(meds)) {
        medLines.push(`${r.date} ${m.time || m.slot || ''}｜${[m.name || '用藥', m.dose, m.status].filter(Boolean).join(' · ')}`);
        const label = `${m.name || '用藥'} · ${m.status || '未填狀態'}`;
        medCounts.set(label, (medCounts.get(label) || 0) + 1);
      }
    }
    add('用藥紀錄', [...medCounts].map(([label,count]) => `${label}：${count} 筆`));
    // 只比較有記錄的日子，未記錄不是 0；不替飼主判定「食慾變差」。
    const metrics = [];
    for (const [label, valueOf, unit] of [['食物總量',(r) => num(r.dryFoodG) + num(r.wetFoodG) + num(r.foodWaterMl) + num(r.otherFoodG),'g'],['總水分',(r) => num(r.totalWaterMl),'ml'],['熱量',(r) => num(r.kcal),'kcal']]) {
      const available = recent.filter((r) => valueOf(r) > 0);
      if (!available.length) continue;
      const first = available[0], last = available.at(-1);
      const format = (r) => Math.round(valueOf(r) * 10) / 10;
      metrics.push(available.length === 1 ? `${label}：${last.date} ${format(last)} ${unit}` : `${label}：${first.date} ${format(first)} ${unit} → ${last.date} ${format(last)} ${unit}（有紀錄 ${available.length} 天）`);
    }
    if (recent.some((r) => num(r.kcalEstimated))) metrics.push('部分熱量為估算值。');
    if (recent.some((r) => r.kcalIncomplete)) metrics.push('部分食物未設定熱量，未完整計入。');
    add('飲食與飲水紀錄變化', metrics);
    add('其他重要紀錄', events.filter((r) => !['vomit','stool','urine','mood'].includes(r.category)).sort((a,b) => b.eventDateTime.localeCompare(a.eventDateTime)).map(eventText));
    add('其餘異常紀錄', abnormal.slice(5).map(eventText), 'detail');
    add('用藥明細', medLines, 'detail');
    add('每日紀錄（詳細）', recent.slice().reverse().map((r) => `${r.date}｜水分 ${num(r.totalWaterMl)} ml · 食物 ${Math.round((num(r.dryFoodG) + num(r.wetFoodG) + num(r.foodWaterMl) + num(r.otherFoodG)) * 10) / 10} g · 熱量 ${num(r.kcal)} kcal${r.kcalIncomplete ? '（部分未計入）' : num(r.kcalEstimated) ? '（部分估算）' : ''}`), 'detail');
  }
  return {
    purpose, petId: pet.petId, petName: pet.petName,
    reportName: purpose === 'care' ? '照護交接單' : '就醫摘要', source: '喵喵管家',
    generatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0,16),
    dateRangeLabel: purpose === 'care' ? (clean(draft.period) ? `照護期間：${clean(draft.period)}` : `整理於 ${to}`) : `${from}－${to}（近 ${days} 天）`, rangeDays: days,
    sections,
    empty: purpose !== 'care' && !recent.length && !events.length && !list(weights).some((w) => inRange(w.date)),
    notice: purpose === 'care' ? (!clean(draft.feeding) ? '餵食與飲水方式尚未填寫，請先向主人確認。' : '照護方式由主人確認；下方歷史狀況僅供觀察。') : '僅整理已記錄的事實；沒有紀錄不代表沒有發生。'
  };
}
export function reportSectionHtml(section) {
  return `<section class="purpose-section"><h2>${escapeReport(section.title)}</h2>${section.items.map((text) => `<p>${escapeReport(text)}</p>`).join('')}</section>`;
}
export function reportPreview(data) {
  return `<header class="purpose-heading"><p>${escapeReport(data.petName)}</p><h1>${escapeReport(data.reportName)}</h1><p>${escapeReport(data.dateRangeLabel)}</p></header><p class="purpose-notice">${escapeReport(data.notice)}</p>${data.empty ? `<p class="purpose-empty">最近 ${data.rangeDays} 天沒有足夠紀錄。</p>` : ''}${data.sections.map((s) => s.kind === 'detail' ? `<details><summary>查看${escapeReport(s.title)}</summary>${reportSectionHtml(s)}</details>` : reportSectionHtml(s)).join('')}`;
}
