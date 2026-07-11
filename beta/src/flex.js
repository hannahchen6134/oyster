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
  ink: '#332417',        // 暖墨棕：主文字
  inkSoft: '#5C4A38',    // 暖棕灰：次要文字
  muted: '#9A8B7A',      // 暖沙灰：說明文字
  line: '#EDE4D6',
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
    type: 'box', layout: 'horizontal', background: HEADER_BG,
    paddingAll: '15px', paddingStart: '20px', paddingEnd: '16px',
    contents: [
      text(title, { color: '#FFFFFF', weight: 'bold', size: 'sm', flex: 1 }),
      text('喵喵照護', { color: '#D9C3A8', size: 'xxs', align: 'end', gravity: 'center', flex: 0 })
    ]
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

// 迷你數據卡：一排 2–3 格（同 menuCell 質感）
function statCell(label, value, unit) {
  return {
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: '#FBF8F1', cornerRadius: '12px',
    borderColor: '#E9E0CE', borderWidth: '1px',
    paddingTop: '10px', paddingBottom: '10px', paddingStart: '4px', paddingEnd: '4px',
    contents: [
      text(label, { size: 'xxs', color: C.muted, align: 'center' }),
      text(value, { size: 'lg', weight: 'bold', color: '#3F2B18', align: 'center', margin: 'xs' }),
      text(unit, { size: 'xxs', color: C.muted, align: 'center' })
    ]
  };
}

function statCellRow(cells) {
  return { type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells };
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
    { type: 'separator', margin: 'lg', color: '#F0EADF' },
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
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag(style.label, style)] },
      text(mainText, { size: 'xl', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      ...(subText ? [text(subText, { size: 'xs', color: C.muted, wrap: true, margin: 'sm' })] : []),
      { type: 'separator', margin: 'lg', color: '#F0EADF' },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml'),
        statCell('食物', fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0)), 'g'),
        statCell('熱量', fmt(summary.kcal), 'kcal')
      ]),
      ...goalContents(pet, summary, date),
      ...hints.filter(Boolean).map((hint) =>
        text(`※ ${hint.replace(/\n/g, '')}`, { size: 'xs', color: C.muted, wrap: true, margin: 'md' })),
      ...(tip ? [text(tip, { size: 'xxs', color: C.muted, wrap: true, margin: 'lg' })] : [])
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '刪除這筆', data: `action=delLog&logId=${logId}`, displayText: '刪除剛剛那筆' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '照護站' } }
    ]
  };
  const headerTitle = title || `已記錄・${pet?.petName || '貓貓'}`;
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

  const totalFood = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(`共 ${summary.entryCount} 筆紀錄`, { size: 'xs', color: C.muted, align: 'center' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml'),
        statCell('食物', fmt(totalFood), 'g'),
        statCell('熱量', fmt(summary.kcal), 'kcal')
      ]),
      statRow('藥', medValue),
      ...(gutParts.length ? [statRow('腸胃', gutParts.join('・'))] : []),
      ...goalContents(pet, summary, date)
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '照護站' } }
    ]
  };
  return bubble(
    `${dateLabel}（${pet?.petName}）水分 ${fmt(summary.totalWaterMl)} ml・熱量 ${fmt(summary.kcal)} kcal`,
    { type: 'bubble', size: 'mega', header: header(`${dateLabel}・${pet?.petName || '貓貓'}`), body, footer }
  );
}

// ---------- 網站連結卡 ----------
export function websiteFlex(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('點下方按鈕直接登入', { size: 'md', weight: 'bold', color: '#3F2B18', align: 'center' }),
      text('月曆・回診摘要・血檢趨勢\n每一筆紀錄都能修改補登', { size: 'xs', color: C.muted, wrap: true, align: 'center', margin: 'md' }),
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      text('連結會隨使用自動延長效期；就算過期，輸入「照護站」拿新連結，資料都不會消失。請勿轉傳給別人。', { size: 'xxs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟照護站', uri: url } }
    ]
  };
  return bubble('照護站登入連結', { type: 'bubble', size: 'mega', header: header('照護站'), body, footer });
}

// ---------- 引導流程卡（喵爸媽安心上手：一張卡一件事、大按鈕） ----------
export function onboardCard({ step = '', title, subtitle = '', rows = [], hint = '', alt = '', skip = null }) {
  const contents = [];
  if (step) contents.push(text(step, { size: 'xxs', color: C.brand, weight: 'bold', align: 'center' }));
  contents.push(text(title, { size: 'lg', weight: 'bold', color: C.ink, align: 'center', wrap: true, margin: step ? 'md' : 'none' }));
  if (subtitle) contents.push(text(subtitle, { size: 'sm', color: C.inkSoft, align: 'center', wrap: true, margin: 'md' }));
  for (const cells of rows) {
    contents.push({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells });
  }
  if (hint) contents.push(text(hint, { size: 'xxs', color: C.muted, align: 'center', wrap: true, margin: 'lg' }));
  if (skip) {
    contents.push({
      type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '6px',
      action: { type: 'message', label: skip.label, text: skip.send },
      contents: [text(`${skip.label} ›`, { size: 'xs', color: C.muted, align: 'center' })]
    });
  }
  return bubble(alt || title, {
    type: 'bubble', size: 'mega', header: header('喵爸媽安心上手'),
    body: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG, contents }
  });
}

// ---------- 已刪除：安心卡＋照護站按鈕 ----------
export function deletedCard(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('已刪除剛剛的資料囉', { size: 'md', weight: 'bold', color: '#3F2B18', align: 'center' }),
      text('若要刪除或調整其他紀錄，\n可以開啟照護站處理', { size: 'xs', color: C.muted, wrap: true, align: 'center', margin: 'md' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟照護站', uri: url } }
    ]
  };
  return bubble('已刪除剛剛的資料', { type: 'bubble', size: 'mega', header: header('已刪除'), body, footer });
}

// ---------- 補充貓咪資料：深連結到設定→貓咪資料 ----------
export function petDataFlex(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('補充貓咪資料', { size: 'md', weight: 'bold', color: '#3F2B18', align: 'center' }),
      text('晶片號碼・疾病・疫苗・品種\n點下方按鈕直接到填寫頁', { size: 'xs', color: C.muted, wrap: true, align: 'center', margin: 'md' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '前往填寫', uri: url } }
    ]
  };
  return bubble('補充貓咪資料', { type: 'bubble', size: 'mega', header: header('補充貓咪資料'), body, footer });
}

// ---------- 歡迎卡（加好友時） ----------
export function welcomeFlex() {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(BRAND.tagline, { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      text('每天忙碌又放不下貓貓？\n交給我陪你一起記。', { size: 'sm', weight: 'bold', color: '#3F2B18', wrap: true, margin: 'lg', align: 'center' }),
      text('吃飯、喝水、用藥、嘔吐——像聊天一樣打字就記好，回診時一鍵整理給醫生看。', { size: 'sm', color: C.inkSoft, wrap: true, margin: 'sm', align: 'center' }),
      {
        type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: '#FBF8F1',
        cornerRadius: '12px', borderColor: '#E9E0CE', borderWidth: '1px', paddingAll: '12px',
        contents: [text('記錯了能改、想刪能刪，資料都在不會不見，安心記就好。',
          { size: 'xs', color: C.inkSoft, wrap: true, align: 'center' })]
      },
      { type: 'box', layout: 'horizontal', margin: 'lg', contents: [menuCell('幫貓貓建檔', '3 個小問題・30 秒', '幫貓貓建檔', true)] },
      { type: 'box', layout: 'horizontal', margin: 'md', contents: [menuCell('先看看怎麼用', '安心上手小教學', '安心上手')] }
    ]
  };
  return bubble(`歡迎加入${BRAND.name}！點「幫貓貓建檔」開始`, { type: 'bubble', size: 'mega', header: header('歡迎回家'), body });
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

// 質感小卡格（選單卡共用）：淺米底、細邊框、主標＋一行小字
export function menuCell(label, sub, sendText, primary = false, uri = '') {
  return {
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: primary ? C.brand : '#FBF8F1', cornerRadius: '14px',
    borderColor: primary ? C.brandDark : '#E9E0CE', borderWidth: '1px',
    paddingTop: '14px', paddingBottom: '13px', paddingStart: '8px', paddingEnd: '8px',
    action: uri ? { type: 'uri', label, uri } : { type: 'message', label, text: sendText },
    contents: [
      text(label, { align: 'center', weight: 'bold', size: 'md', color: primary ? '#FFFFFF' : '#3F2B18' }),
      text(sub, { align: 'center', size: 'xxs', color: primary ? '#EFE3D2' : C.muted, margin: 'sm' })
    ]
  };
}

// 照著打打看：可直接點的範例指令（點一句就記一筆，教學於無形）
export function exampleCard() {
  const line = (cmd, desc) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'md',
    margin: 'md', paddingAll: '10px',
    backgroundColor: '#FBF8F1', cornerRadius: '12px',
    borderColor: '#E9E0CE', borderWidth: '1px',
    action: { type: 'message', label: cmd, text: cmd },
    contents: [
      {
        type: 'box', layout: 'vertical', flex: 0,
        backgroundColor: C.tint, cornerRadius: '8px',
        paddingAll: '7px', paddingStart: '12px', paddingEnd: '12px',
        contents: [text(cmd, { size: 'sm', weight: 'bold', color: C.brand })]
      },
      text(desc, { size: 'xs', color: C.muted, flex: 1, gravity: 'center', wrap: true }),
      text('›', { size: 'lg', color: '#D8CDBA', flex: 0, gravity: 'center' })
    ]
  });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('第一次記，照著點點看就懂了', { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      line('水 60', '記一筆喝水 60 ml'),
      line('罐頭 30', '記一筆罐頭 30 克'),
      line('藥 早 已吃', '記早上的藥已經餵了'),
      line('吐了', '記一次嘔吐'),
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      text('平常怎麼說就怎麼打，「喝了60」「吃了罐頭30」也看得懂',
        { size: 'xxs', color: C.muted, align: 'center', wrap: true, margin: 'lg' })
    ]
  };
  return bubble('照著打打看：水 60、罐頭 30、藥 早 已吃、吐了',
    { type: 'bubble', size: 'mega', header: header('照著打打看'), body });
}

export function menuFlex() {
  const row = (cells) => ({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(BRAND.tagline, { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      row([menuCell(BRAND.onboarding, '第一次使用看這裡', '安心上手')]),
      row([menuCell('照著打打看', '點一句就記', '範例'), menuCell('如何記餵藥', '藥的記法', '如何記餵藥')]),
      row([menuCell('今日照護確認', '看今天狀況', '今天'), menuCell('回診摘要', '近 7 天整理', '回診摘要')]),
      row([menuCell('開啟照護站', '月曆・血檢・設定', '照護站', true)])
    ]
  };
  return bubble('使用說明選單', { type: 'bubble', size: 'mega', header: header('想做什麼？'), body });
}

// ---------- 快速紀錄選單卡 ----------
export function recordMenuFlex() {
  const cell = menuCell;
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
  return bubble('快速紀錄選單', { type: 'bubble', size: 'mega', header: header('快速紀錄'), body });
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
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('長條＝總水分（ml）', { size: 'xs', color: C.muted, align: 'center' }),
      ...dayRows,
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      statCellRow([
        statCell('日均水分', fmt(avg((row) => row.totalWaterMl)), 'ml'),
        statCell('日均熱量', fmt(avg((row) => row.kcal)), 'kcal')
      ])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站看完整趨勢', text: '照護站' } }
    ]
  };
  return bubble(
    `近 7 天（${petName}）日均水分 ${fmt(avg((row) => row.totalWaterMl))} ml`,
    { type: 'bubble', size: 'mega', header: header(`近 7 天・${petName}`), body, footer }
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
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      ...items,
      { type: 'separator', margin: 'lg', color: '#F0EADF' },
      text('做了但忘了記的話，補記一下就好；有不放心的狀況請諮詢獸醫師。',
        { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'message', label: '看今天', text: '今天' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '照護站' } }
    ]
  };
  return bubble(
    `照護提醒（${pet.petName}）${lines.length} 項`,
    { type: 'bubble', size: 'mega', header: header(`照護提醒・${pet.petName}`), body, footer }
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
    { type: 'separator', margin: 'lg', color: '#F0EADF' },
    text('回診前可先看「回診摘要」，或到照護站的「回診」頁一鍵複製給醫生',
      { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
  );
  const body = { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG, contents };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'message', label: '回診摘要', text: '回診摘要' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '照護站' } }
    ]
  };
  return bubble(
    `回診提醒：明天 ${dateLabel}`,
    { type: 'bubble', size: 'mega', header: header(`回診提醒・${pet.petName}`), body, footer }
  );
}
