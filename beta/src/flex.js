// LINE Flex Message 卡片（貓貓照護管家）
// 視覺沿用照護站：暖棕 #734921、紙白、朱紅只做警示。
// 每張卡都附 altText（通知列預覽）與文字備援由呼叫端處理。

import { goalSection } from './replies.js';

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
    type: 'box', layout: 'vertical', backgroundColor: C.brand,
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
        type: 'box', layout: 'vertical', backgroundColor: '#EDE8DB',
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
    { type: 'separator', margin: 'lg', color: C.line },
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

function quickReply() {
  const item = (label, textValue) => ({
    type: 'action',
    action: { type: 'message', label, text: textValue }
  });
  return {
    items: [
      item('📊 今天', '今天'),
      item('📈 近7天', '近7天'),
      item('🏥 回診', '回診'),
      item('🔗 網站', '網站'),
      item('📖 說明', '說明')
    ]
  };
}

function bubble(altText, contents) {
  return { type: 'flex', altText: altText.slice(0, 390), contents, quickReply: quickReply() };
}

// ---------- 記錄確認卡 ----------
export function recordFlex({ pet, categoryKey, mainText, subText, summary, date, logId, hints = [] }) {
  const style = CATEGORY_STYLE[categoryKey] || CATEGORY_STYLE.note;
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: C.sheet,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag(style.label, style)] },
      text(mainText, { size: 'xl', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      ...(subText ? [text(subText, { size: 'xs', color: C.muted, wrap: true, margin: 'sm' })] : []),
      { type: 'separator', margin: 'lg', color: C.line },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statRow('水分', `${fmt(summary.totalWaterMl)} ml`),
      statRow('食物', `${fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0))} g`),
      statRow('熱量', `${fmt(summary.kcal)} kcal`),
      ...goalContents(pet, summary, date),
      ...hints.filter(Boolean).map((hint) =>
        text(`※ ${hint.replace(/\n/g, '')}`, { size: 'xs', color: C.muted, wrap: true, margin: 'md' }))
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px',
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.muted,
        action: { type: 'postback', label: '刪除這筆', data: `action=delLog&logId=${logId}`, displayText: '刪除剛剛那筆' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '網站' } }
    ]
  };
  return bubble(`已記錄 ${mainText}`, { type: 'bubble', size: 'mega', header: header(`✓ 已記錄・${pet?.petName || '貓貓'}`), body, footer });
}

// ---------- 今日總結卡 ----------
export function todayFlex({ pet, date, summary, dateLabel }) {
  const meds = summary.meds || [];
  const medValue = meds.length
    ? meds.map((m) => `${[m.slot, m.name].filter(Boolean).join(' ')}${m.status === '已吃' ? '✓' : m.status}`).join('、')
    : '尚無紀錄';
  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount}`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount}`);

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: C.sheet,
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
    type: 'box', layout: 'horizontal', paddingAll: '10px',
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
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: C.sheet, spacing: 'sm',
    contents: [
      text('點下方按鈕直接登入，', { size: 'sm', color: C.inkSoft, wrap: true }),
      text('可看月曆、趨勢、血檢，', { size: 'sm', color: C.inkSoft, wrap: true }),
      text('修改任何一筆紀錄。', { size: 'sm', color: C.inkSoft, wrap: true }),
      { type: 'separator', margin: 'lg', color: C.line },
      text('連結會隨使用自動延長效期，請勿轉傳給別人。', { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px',
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟照護站', uri: url } }
    ]
  };
  return bubble('照護站登入連結', { type: 'bubble', size: 'mega', header: header('🔗 照護站'), body, footer });
}
