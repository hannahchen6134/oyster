// LINE Flex Message 卡片（喵喵照護安心管家）
// 視覺沿用照護站：暖棕 #734921、紙白、朱紅只做警示。
// 每張卡都附 altText（通知列預覽）與文字備援由呼叫端處理。

import { goalSection, recordPrompt } from './replies.js';
import { BRAND, displayMedStatus } from './brand.js';

// 卡身：淺米色斜向漸層；標題：暖棕漸層
const BODY_BG = '#FFFFFF';
const HEADER_BG = { type: 'linearGradient', angle: '135deg', startColor: '#8A5A2C', endColor: '#6A4119' };
const FOOTER_COLOR = '#FFFFFF';

const C = {
  brand: '#734921',
  brandDark: '#5A3617',
  tint: '#F4EDE0',
  sheet: '#FDFDFB',
  soft: '#F7F4EC',
  ink: '#1B1D1A',
  inkSoft: '#4C5049',
  muted: '#878B80',
  line: '#E2E0D6',
  seal: '#BF3B20',
  sealTint: '#F9EBE5',
  olive: '#5D6C36',
  oliveTint: '#EEF1E1'
};

const CATEGORY_STYLE = {
  water: { label: '喝水', bg: C.oliveTint, fg: C.olive },
  dry: { label: '乾糧', bg: '#F5F1E3', fg: '#7A662F' },
  wet: { label: '罐頭/濕食', bg: '#F7EFE4', fg: '#8A5E35' },
  med: { label: '藥物', bg: C.tint, fg: C.brand },
  vomit: { label: '嘔吐', bg: C.sealTint, fg: C.seal },
  stool: { label: '便便', bg: C.soft, fg: C.inkSoft },
  mood: { label: '精神', bg: C.soft, fg: C.inkSoft },
  note: { label: '備註', bg: C.soft, fg: C.inkSoft }
};

function fmt(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function text(content, options = {}) {
  return { type: 'text', text: String(content || ' '), ...options };
}

function header(title) {
  return {
    type: 'box', layout: 'vertical', background: HEADER_BG,
    paddingAll: '14px', paddingStart: '18px',
    contents: [text(title, { color: '#FFFFFF', weight: 'bold', size: 'sm' })]
  };
}

function tag(label, style) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: style.bg,
    cornerRadius: '999px', paddingAll: '4px', paddingStart: '12px', paddingEnd: '12px',
    flex: 0,
    contents: [text(label, { color: style.fg, size: 'xs', weight: 'bold' })]
  };
}

function statRow(label, value) {
  return {
    type: 'box', layout: 'baseline', margin: 'sm',
    contents: [
      text(label, { color: C.muted, size: 'sm', flex: 3 }),
      text(value, { color: C.ink, size: 'sm', weight: 'bold', flex: 5, align: 'end' })
    ]
  };
}

function progressBar(label, value, goal) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(value) / Number(goal)) * 100)));
  const done = pct >= 100;
  return {
    type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
    contents: [
      {
        type: 'box', layout: 'baseline',
        contents: [
          text(label, { size: 'xs', color: C.inkSoft, flex: 7 }),
          text(`${pct}%`, { size: 'xs', color: done ? C.olive : C.muted, align: 'end', flex: 2 })
        ]
      },
      {
        type: 'box', layout: 'vertical', backgroundColor: '#EFEBE0',
        cornerRadius: '4px', height: '8px',
        contents: [{
          type: 'box', layout: 'vertical', backgroundColor: done ? C.olive : C.brand,
          cornerRadius: '4px', height: '8px', width: `${Math.max(pct, 4)}%`,
          contents: [{ type: 'filler' }]
        }]
      }
    ]
  };
}

function parseGoalSlots(pet) {
  try {
    const slots = JSON.parse(pet?.goalMedSlots || '[]');
    return Array.isArray(slots) ? slots.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

// 目標區（有設定才出現）：進度條 + 藥時段 + 鼓勵語
function goalContents(pet, summary, date) {
  const goalWater = Number(pet?.goalWaterMl) || 0;
  const goalKcal = Number(pet?.goalKcal) || 0;
  const slots = parseGoalSlots(pet);
  if (!goalWater && !goalKcal && !slots.length) return [];

  const contents = [
    { type: 'separator', margin: 'lg', color: '#EAE6DB' },
    text('今日目標', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' })
  ];
  if (goalWater > 0) contents.push(progressBar(`水分 ${fmt(summary.totalWaterMl)} / ${fmt(goalWater)} ml`, summary.totalWaterMl, goalWater));
  if (goalKcal > 0) contents.push(progressBar(`熱量 ${fmt(summary.kcal)} / ${fmt(goalKcal)} kcal`, summary.kcal, goalKcal));
  if (slots.length) {
    const doneSlots = new Set((summary.meds || []).filter((m) => m.status === '已吃').map((m) => m.slot));
    const parts = slots.map((slot) => `${slot} ${doneSlots.has(slot) ? '✓' : '—'}`).join('　');
    contents.push(statRow('藥', parts));
  }
  // 取文字版目標區的最後一行（鼓勵語）
  const section = goalSection(pet, summary, date);
  const lastLine = section.split('\n').filter(Boolean).pop() || '';
  if (lastLine && !lastLine.startsWith('──')) {
    contents.push(text(lastLine, { size: 'xs', color: C.inkSoft, wrap: true, margin: 'md' }));
  }
  return contents;
}

function bubble(altText, contents) {
  return { type: 'flex', altText: altText.slice(0, 390), contents };
}

// ---------- 記錄確認卡 ----------
export function recordFlex({ pet, categoryKey, mainText, subText, summary, date, logId, hints = [], title = '', tip = '' }) {
  const style = CATEGORY_STYLE[categoryKey] || CATEGORY_STYLE.note;
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag(style.label, style)] },
      text(mainText, { size: 'xl', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      ...(subText ? [text(subText, { size: 'xs', color: C.muted, wrap: true, margin: 'sm' })] : []),
      { type: 'separator', margin: 'lg', color: '#EAE6DB' },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statRow('水分', `${fmt(summary.totalWaterMl)} ml`),
      statRow('食物', `${fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0))} g`),
      statRow('熱量', `${fmt(summary.kcal)} kcal`),
      ...goalContents(pet, summary, date),
      ...hints.filter(Boolean).map((hint) =>
        text(`※ ${hint.replace(/\n/g, '')}`, { size: 'xs', color: C.muted, wrap: true, margin: 'md' })),
      ...(tip ? [text(tip, { size: 'xxs', color: C.muted, wrap: true, margin: 'lg' })] : [])
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.muted,
        action: { type: 'postback', label: '刪除這筆', data: `action=delLog&logId=${logId}`, displayText: '刪除剛剛那筆' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '網站' } }
    ]
  };
  const headerTitle = title || `✓ 已記錄・${pet?.petName || '貓貓'}`;
  return bubble(`${title ? '已更新' : '已記錄'} ${mainText}`, { type: 'bubble', size: 'mega', header: header(headerTitle), body, footer });
}

// ---------- 今日總結卡 ----------
export function todayFlex({ pet, date, summary, dateLabel }) {
  const meds = summary.meds || [];
  const medValue = meds.length
    ? meds.map((m) => `${[m.slot, m.name].filter(Boolean).join(' ')}${m.status === '已吃' ? '✓' : displayMedStatus(m.status)}`).join('、')
    : '尚無紀錄';
  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount}`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount}`);

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG,
    contents: [
      text(`共 ${summary.entryCount} 筆紀錄`, { size: 'xs', color: C.muted }),
      statRow('水分', `${fmt(summary.totalWaterMl)} ml`),
      statRow('食物', `${fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0))} g`),
      statRow('熱量', `${fmt(summary.kcal)} kcal`),
      statRow('藥', medValue),
      ...(gutParts.length ? [statRow('腸胃', gutParts.join('・'))] : []),
      ...goalContents(pet, summary, date)
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '網站' } }
    ]
  };
  return bubble(
    `${dateLabel}（${pet?.petName}）水分 ${fmt(summary.totalWaterMl)} ml・熱量 ${fmt(summary.kcal)} kcal`,
    { type: 'bubble', size: 'mega', header: header(`📅 ${dateLabel}・${pet?.petName || '貓貓'}`), body, footer }
  );
}

// ---------- 網站連結卡 ----------
export function websiteFlex(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, spacing: 'sm',
    contents: [
      text('點下方按鈕直接登入，', { size: 'sm', color: C.inkSoft, wrap: true }),
      text('可看月曆、趨勢、血檢，', { size: 'sm', color: C.inkSoft, wrap: true }),
      text('修改任何一筆紀錄。', { size: 'sm', color: C.inkSoft, wrap: true }),
      { type: 'separator', margin: 'lg', color: '#EAE6DB' },
      text('連結會隨使用自動延長效期，請勿轉傳給別人。', { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟照護站', uri: url } }
    ]
  };
  return bubble('照護站登入連結', { type: 'bubble', size: 'mega', header: header('🔗 照護站'), body, footer });
}

// ---------- 說明選單卡 ----------
function menuRow(label, sendText, primary = false) {
  return {
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: primary ? C.brand : '#F6F3EA',
    cornerRadius: '10px', paddingAll: '12px', margin: 'sm',
    action: { type: 'message', label, text: sendText },
    contents: [text(label, { align: 'center', weight: 'bold', size: 'sm', color: primary ? '#FFFFFF' : C.ink })]
  };
}

export function menuFlex() {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: BODY_BG,
    contents: [
      text(BRAND.tagline, { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      menuRow(BRAND.onboarding, '安心上手'),
      menuRow('如何記錄', '如何記錄'),
      menuRow('如何記餵藥', '如何記餵藥'),
      menuRow('今日照護確認', '今天'),
      menuRow('回診摘要', '回診摘要'),
      menuRow('開啟照護站', '照護站', true)
    ]
  };
  return bubble('使用說明選單', { type: 'bubble', size: 'mega', header: header('📖 想做什麼？'), body });
}

// ---------- 快速紀錄選單卡 ----------
export function recordMenuFlex() {
  // 小卡格：淺米底、細邊框、主標＋一行小字，質感取向
  const cell = (label, sub, sendText) => ({
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: '#FBF8F1', cornerRadius: '14px',
    borderColor: '#E9E0CE', borderWidth: '1px',
    paddingTop: '14px', paddingBottom: '13px', paddingStart: '8px', paddingEnd: '8px',
    action: { type: 'message', label, text: sendText },
    contents: [
      text(label, { align: 'center', weight: 'bold', size: 'md', color: '#3F2B18' }),
      text(sub, { align: 'center', size: 'xxs', color: C.muted, margin: 'sm' })
    ]
  });
  const row = (cells) => ({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('想記哪一種？點一下就開始', { size: 'xs', color: C.muted, align: 'center' }),
      row([cell('吃飯', '罐頭・乾糧・零食', '記吃飯'), cell('喝水', '今天喝了多少', '記喝水')]),
      row([cell('用藥', '已吃・沒餵到', '記用藥'), cell('嘔吐', '顏色與內容', '記嘔吐')]),
      row([cell('排便', '次數與形狀', '記排便'), cell('精神', '活動力如何', '記精神')]),
      row([cell('其他備註', '想補充的小事', '記備註')]),
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      text('補登昨天：昨天 21:30 水 20', { size: 'xxs', color: C.muted, align: 'center', margin: 'lg' })
    ]
  };
  return bubble('快速紀錄選單', { type: 'bubble', size: 'mega', header: header('✏️ 快速紀錄'), body });
}

// ---------- 近 7 天迷你圖卡（長條＝水分） ----------
export function weekFlex(petName, rows) {
  const maxWater = Math.max(1, ...rows.map((row) => Number(row.totalWaterMl) || 0));
  const recorded = rows.filter((row) => row.entryCount > 0);
  const avg = (selector) => (recorded.length
    ? recorded.reduce((total, row) => total + (Number(selector(row)) || 0), 0) / recorded.length
    : 0);

  const dayRows = rows.map((row) => {
    const day = `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`;
    const warn = row.vomitCount > 0 || row.medIssueCount > 0;
    const water = Number(row.totalWaterMl) || 0;
    const pct = Math.max(row.entryCount ? 4 : 0, Math.round((water / maxWater) * 100));
    return {
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        text(`${day}${warn ? '⚠' : ''}`, { size: 'xs', color: warn ? C.seal : C.muted, flex: 2, gravity: 'center' }),
        {
          type: 'box', layout: 'vertical', flex: 6, backgroundColor: '#EFEBE0',
          cornerRadius: '3px', height: '8px', margin: 'sm',
          contents: pct > 0
            ? [{ type: 'box', layout: 'vertical', backgroundColor: C.olive, cornerRadius: '3px', height: '8px', width: `${pct}%`, contents: [{ type: 'filler' }] }]
            : [{ type: 'filler' }]
        },
        text(row.entryCount ? fmt(water) : '—', { size: 'xs', color: C.inkSoft, flex: 2, align: 'end', gravity: 'center' })
      ]
    };
  });

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG,
    contents: [
      text('長條＝總水分（ml）', { size: 'xs', color: C.muted }),
      ...dayRows,
      { type: 'separator', margin: 'lg', color: '#EAE6DB' },
      statRow('日均水分', `${fmt(avg((row) => row.totalWaterMl))} ml`),
      statRow('日均熱量', `${fmt(avg((row) => row.kcal))} kcal`)
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站看完整趨勢', text: '網站' } }
    ]
  };
  return bubble(
    `近 7 天（${petName}）日均水分 ${fmt(avg((row) => row.totalWaterMl))} ml`,
    { type: 'bubble', size: 'mega', header: header(`📈 近 7 天・${petName}`), body, footer }
  );
}

// ---------- 照護提醒卡 ----------
export function reminderFlex(pet, lines) {
  const items = [];
  for (const line of lines) {
    const [main, ...subs] = String(line).split('\n');
    items.push({
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        text('・', { size: 'sm', color: C.seal, flex: 0 }),
        text(main, { size: 'sm', color: C.ink, wrap: true, flex: 1 })
      ]
    });
    for (const sub of subs) {
      items.push(text(sub.trim(), { size: 'xs', color: C.muted, wrap: true, margin: 'xs' }));
    }
  }
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG,
    contents: [
      ...items,
      { type: 'separator', margin: 'lg', color: '#EAE6DB' },
      text('做了但忘了記的話，補記一下就好；有不放心的狀況請諮詢獸醫師。',
        { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.inkSoft,
        action: { type: 'message', label: '看今天', text: '今天' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '網站' } }
    ]
  };
  return bubble(
    `照護提醒（${pet.petName}）${lines.length} 項`,
    { type: 'bubble', size: 'mega', header: header(`🔔 照護提醒・${pet.petName}`), body, footer }
  );
}

// ---------- 回診提醒卡 ----------
export function visitReminderFlex(pet, visits, vetsById, dateLabel) {
  const contents = [
    text(`明天 ${dateLabel}`, { size: 'xl', weight: 'bold', color: C.ink })
  ];
  for (const visit of visits) {
    if (visit.visitTime) contents.push(statRow('時間', visit.visitTime));
    const vet = vetsById[visit.vetId];
    const where = vet ? [vet.hospitalName, vet.doctorName].filter(Boolean).join('・') : '';
    if (where) contents.push(statRow('地點', where));
    if (visit.reason) contents.push(statRow('原因', visit.reason));
  }
  contents.push(
    { type: 'separator', margin: 'lg', color: '#EAE6DB' },
    text('回診前可先看「回診摘要」，或到照護站的「回診」頁一鍵複製給醫生 🐾',
      { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
  );
  const body = { type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, contents };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.inkSoft,
        action: { type: 'message', label: '回診摘要', text: '回診摘要' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '網站' } }
    ]
  };
  return bubble(
    `回診提醒：明天 ${dateLabel}`,
    { type: 'bubble', size: 'mega', header: header(`🏥 回診提醒・${pet.petName}`), body, footer }
  );
}
