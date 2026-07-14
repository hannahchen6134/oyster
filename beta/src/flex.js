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

// 一則訊息記多筆時的合併確認卡：條列這次記了哪幾筆 ＋ 當天累積
export function multiRecordFlex(pet, lines, summary, date) {
  const foodG = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag(`一次記了 ${lines.length} 筆`, CATEGORY_STYLE.note)] },
      ...lines.map((line) => text(`· ${line}`, { size: 'md', weight: 'bold', color: C.ink, wrap: true, margin: 'sm' })),
      { type: 'separator', margin: 'lg', color: '#F0EADF' },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml'),
        statCell('食物', fmt(foodG), 'g'),
        statCell('熱量', fmt(summary.kcal), 'kcal')
      ]),
      ...goalContents(pet, summary, date)
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站', text: '照護站' } }
    ]
  };
  return bubble(`已記錄 ${lines.length} 筆`, { type: 'bubble', size: 'mega', header: header(`已記錄・${pet?.petName || '貓貓'}`), body, footer });
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
  if (hint) contents.push({
    type: 'box', layout: 'vertical', margin: 'lg',
    backgroundColor: C.tint, cornerRadius: '10px', paddingAll: '10px', paddingStart: '13px', paddingEnd: '13px',
    contents: [text(hint, { size: 'xs', color: C.brand, align: 'center', wrap: true })]
  });
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
export function menuCell(label, sub, sendText, primary = false, uri = '', postback = '') {
  const action = postback
    ? { type: 'postback', label, data: postback, displayText: sendText || label }
    : uri ? { type: 'uri', label, uri } : { type: 'message', label, text: sendText };
  return {
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: primary ? C.brand : '#FBF8F1', cornerRadius: '14px',
    borderColor: primary ? C.brandDark : '#E9E0CE', borderWidth: '1px',
    paddingTop: '14px', paddingBottom: '13px', paddingStart: '8px', paddingEnd: '8px',
    action,
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
      text('直接打字最快，照著點點看就懂了', { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      line('水 60', '記一筆喝水 60 ml'),
      line('罐頭 皇家 30', '食物＋品牌＋幾克'),
      line('藥 早 已吃', '記早上的藥已經餵了'),
      line('水20 乾糧4 藥早已吃', '一句話一次記三筆'),
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      text('品牌、換貓、加水、補登… 打「如何記錄」看完整記法',
        { size: 'xxs', color: C.brand, align: 'center', wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'secondary', color: C.brand,
        action: { type: 'message', label: '完整記法', text: '如何記錄' } },
      { type: 'button', height: 'sm', style: 'secondary', color: C.brand,
        action: { type: 'message', label: '改用按鈕', text: '按鈕記錄' } }
    ]
  };
  return bubble('照著打打看：水 60、罐頭 30、藥 早 已吃、水20 乾糧4 藥早已吃',
    { type: 'bubble', size: 'mega', header: header('怎麼記？打字最快'), body, footer });
}

// ---------- 完整記法教學卡（固定小字、短句不換行） ----------
// 純文字訊息會跟著手機系統字級放大而在半句處斷行（例：「冠關 水↵20」）；
// 改用 Flex 卡把字級鎖小、每句都短到不會折行，指令左、說明右，乾淨好讀。
export function recordTutorialFlex() {
  const rows = [];
  const sec = (title) => {
    rows.push({ type: 'separator', margin: 'xl', color: '#F0EADF' });
    rows.push(text(title, { size: 'xs', weight: 'bold', color: C.olive, margin: 'md' }));
  };
  // 指令左（暖墨、粗、不換行）＋ 說明右（沙灰、極小、不換行）
  const cmd = (command, gloss = '') => {
    const line = { type: 'box', layout: 'baseline', margin: 'sm', contents: [
      text(command, { size: 'sm', weight: 'bold', color: C.ink, flex: 0 })
    ] };
    if (gloss) line.contents.push(text(gloss, { size: 'xxs', color: C.muted, flex: 1, align: 'end', gravity: 'bottom' }));
    rows.push(line);
  };

  rows.push(text('照著打就會記，數字是幾克或幾 ml', { size: 'xs', color: C.muted, wrap: true }));

  sec('喝水');
  cmd('水 60');

  sec('吃飯（可帶品牌）');
  cmd('乾糧 4');
  cmd('罐頭 30');
  cmd('罐頭 皇家 30', '帶品牌');
  cmd('乾糧 希爾斯 20', '帶品牌');
  cmd('罐頭 30 加水 10', '另外加水');

  sec('用藥');
  cmd('藥 早 已吃');
  cmd('藥 心臟藥 晚 已吃', '指定藥名');
  cmd('已吃／未餵／吐掉／拒吃');

  sec('症狀・精神');
  cmd('吐 白色泡沫');
  cmd('大便 偏軟');
  cmd('尿尿');
  cmd('營養補充 益生菌');
  cmd('精神 活動力差');
  cmd('備註 今天梳毛');

  sec('一次記多筆');
  cmd('水20 乾糧4 藥早已吃', '一句記三筆');

  sec('補登・指定時間');
  cmd('昨天 21:30 水 20');
  cmd('14:30 水 20');

  sec('多隻貓');
  cmd('蚵仔', '打名字＝之後都記牠');
  cmd('冠關 水 20', '只記一筆給別隻');

  sec('記錯了');
  cmd('改 54', '改上一筆數量');
  cmd('剩 20', '沒吃完扣掉');
  cmd('刪除', '刪掉上一筆');

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: rows
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '14px', paddingStart: '20px', paddingEnd: '20px', backgroundColor: FOOTER_COLOR,
    contents: [
      text('先到照護站設好「常吃的食物」，之後打品牌就會自動算熱量與水分。',
        { size: 'xxs', color: C.brand, wrap: true })
    ]
  };
  return bubble('完整記法：水 60、罐頭 皇家 30、藥 早 已吃、水20 乾糧4 藥早已吃、昨天 21:30 水 20',
    { type: 'bubble', size: 'mega', header: header('完整記法・照著打就會'), body, footer });
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
export function recordMenuFlex(introText = '想記哪一種？點一下就開始', headerTitle = '快速紀錄') {
  const cell = menuCell;
  const row = (cells) => ({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(introText, { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      row([cell('吃飯', '罐頭・乾糧・零食', '記吃飯'), cell('喝水', '今天喝了多少', '記喝水')]),
      row([cell('用藥', '已吃・未餵', '記用藥'), cell('營養補充', '益生菌・化毛膏', '記營養補充')]),
      row([cell('大便', '次數與形狀', '記大便'), cell('尿尿', '量與顏色', '記尿尿')]),
      row([cell('嘔吐', '顏色與內容', '記嘔吐'), cell('精神', '活動力如何', '記精神')]),
      row([cell('其他備註', '想補充的小事', '記備註')]),
      { type: 'separator', margin: 'xl', color: '#F0EADF' },
      text('熟了就直接打字更快：水 60・罐頭 30・藥 早 已吃', { size: 'xxs', color: C.brand, align: 'center', wrap: true, margin: 'lg' }),
      text('補登昨天：昨天 21:30 水 20', { size: 'xxs', color: C.muted, align: 'center', margin: 'sm' })
    ]
  };
  return bubble(headerTitle, { type: 'bubble', size: 'mega', header: header(headerTitle), body });
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

// ---------- 月曆卡（純聊天泡泡，不需開網站；點日期看那天細節） ----------
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function monthShift(month, delta) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 空白格（月初補位）
function calBlankCell() {
  return { type: 'box', layout: 'vertical', flex: 1, height: '46px', contents: [{ type: 'filler' }] };
}

// 狀態圓點：置中的小圓（咖啡＝有紀錄，seal＝需留意，null＝留白對齊）；放大方便長輩辨識
function calDot(color) {
  const dot = { type: 'box', layout: 'vertical', width: '8px', height: '8px', cornerRadius: '999px', backgroundColor: color, contents: [{ type: 'filler' }] };
  return {
    type: 'box', layout: 'horizontal', height: '9px', margin: 'sm',
    contents: color ? [{ type: 'filler' }, dot, { type: 'filler' }] : [{ type: 'filler' }]
  };
}

function calDayCell(month, day, row, { isToday, isFuture }) {
  const recorded = row && Number(row.entryCount) > 0;
  let flags = [];
  try { flags = JSON.parse(row?.abnormalFlags || '[]'); } catch (error) { flags = []; }
  const warn = Boolean(row) && (Number(row.vomitCount) > 0 || Number(row.medIssueCount) > 0 || (Array.isArray(flags) && flags.length > 0));
  const dotColor = warn ? C.seal : recorded ? C.brand : null;
  const numColor = isFuture ? '#D2C6B2' : isToday ? C.brand : recorded ? C.ink : C.muted;
  const cell = {
    type: 'box', layout: 'vertical', flex: 1, height: '60px',
    cornerRadius: '10px', paddingTop: '9px', paddingBottom: '6px',
    backgroundColor: isToday ? '#F1E7D6' : recorded ? '#FBF8F1' : undefined,
    borderColor: isToday ? C.brand : undefined,
    borderWidth: isToday ? '2px' : undefined,
    contents: [
      text(String(day), { size: 'lg', weight: isToday ? 'bold' : 'regular', color: numColor, align: 'center' }),
      calDot(dotColor)
    ]
  };
  if (recorded && !isFuture) {
    const dateStr = `${month}-${String(day).padStart(2, '0')}`;
    cell.action = { type: 'postback', data: `action=calDay&date=${dateStr}`, displayText: `看 ${Number(month.slice(5, 7))}/${day}` };
  }
  return cell;
}

// rows：該月 1 號到 lastDate 的 daily_summary（由 getRecentSummaries 補零）
// calendarUrl：帶登入 token 的網站月曆連結（有帶才顯示「看完整月曆」按鈕）
export function monthFlex(petName, month, rows, today, calendarUrl = '') {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstWeekday = (new Date(year, mon - 1, 1).getDay() + 6) % 7; // 週一為 0
  const byDay = new Map();
  for (const row of rows) byDay.set(Number(row.date.slice(8, 10)), row);

  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(calBlankCell());
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    cells.push(calDayCell(month, d, byDay.get(d), { isToday: dateStr === today, isFuture: dateStr > today }));
  }
  while (cells.length % 7 !== 0) cells.push(calBlankCell());

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push({ type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'sm', contents: cells.slice(i, i + 7) });
  }

  const recorded = rows.filter((row) => Number(row.entryCount) > 0);
  const avgWater = recorded.length
    ? recorded.reduce((total, row) => total + (Number(row.totalWaterMl) || 0), 0) / recorded.length
    : 0;

  const weekHeader = {
    type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'md',
    contents: WEEKDAYS.map((w) => text(w, { size: 'sm', color: C.inkSoft, align: 'center', flex: 1 }))
  };
  const legend = {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'lg',
    contents: [
      text('● 有紀錄', { size: 'xs', color: C.brand, align: 'center', flex: 1 }),
      text('● 需留意', { size: 'xs', color: C.seal, align: 'center', flex: 1 }),
      text('點日期看細節', { size: 'xs', color: C.muted, align: 'center', flex: 1 })
    ]
  };

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: BODY_BG,
    contents: [weekHeader, ...weeks, { type: 'separator', margin: 'lg', color: '#F0EADF' }, legend]
  };

  const thisMonth = today.slice(0, 7);
  const prevMonth = monthShift(month, -1);
  const nextMonth = monthShift(month, 1);
  const navButtons = [{
    type: 'button', height: 'sm', style: 'link', color: C.brand,
    action: { type: 'postback', label: '‹ 上個月', data: `action=calMonth&month=${prevMonth}`, displayText: `${Number(prevMonth.slice(5, 7))} 月月曆` }
  }];
  if (nextMonth <= thisMonth) {
    navButtons.push({
      type: 'button', height: 'sm', style: 'link', color: C.brand,
      action: { type: 'postback', label: '下個月 ›', data: `action=calMonth&month=${nextMonth}`, displayText: `${Number(nextMonth.slice(5, 7))} 月月曆` }
    });
  }
  const footerRows = [{ type: 'box', layout: 'horizontal', contents: navButtons }];
  if (calendarUrl) {
    footerRows.push({
      type: 'button', height: 'sm', style: 'primary', color: C.brand,
      action: { type: 'uri', label: '看完整月曆（去照護站）', uri: calendarUrl }
    });
  }
  const footer = { type: 'box', layout: 'vertical', paddingAll: '8px', spacing: 'sm', backgroundColor: FOOTER_COLOR, contents: footerRows };

  const summaryLine = recorded.length ? `有紀錄 ${recorded.length} 天・日均水分 ${fmt(avgWater)} ml` : '這個月還沒有紀錄';
  return bubble(
    `${year} 年 ${mon} 月（${petName}）${summaryLine}`,
    { type: 'bubble', size: 'mega', header: header(`${year} 年 ${mon} 月・${petName}`), body, footer }
  );
}

// ---------- 紀錄回顧清單（最近幾筆，依日期分段，可直接改數字或刪除） ----------
// items：[{ logId, dateLabel, time, title, sub, editable }]（由呼叫端整理好）
export function recentFlex(petName, items) {
  const contents = [
    text('主資訊在上、細節在下；點「改」修正數字、「刪」移除整筆', { size: 'xxs', color: C.muted, wrap: true, align: 'center' })
  ];

  let lastDate = null;
  items.forEach((item) => {
    if (item.dateLabel !== lastDate) {
      contents.push(text(item.dateLabel, { size: 'sm', weight: 'bold', color: C.brand, margin: lastDate ? 'xl' : 'lg' }));
      contents.push({ type: 'separator', margin: 'sm', color: '#F0EADF' });
      lastDate = item.dateLabel;
    }

    const actions = [];
    if (item.editable) {
      actions.push({
        type: 'button', height: 'sm', style: 'link', color: C.brand, gravity: 'center',
        action: { type: 'postback', label: '改', data: `action=editAmount&logId=${item.logId}`, displayText: `改「${item.title}」` }
      });
    }
    actions.push({
      type: 'button', height: 'sm', style: 'link', color: C.muted, gravity: 'center',
      action: { type: 'postback', label: '刪', data: `action=delLog&logId=${item.logId}`, displayText: `刪除「${item.title}」` }
    });

    contents.push({
      type: 'box', layout: 'horizontal', margin: 'lg', spacing: 'sm',
      contents: [
        text(item.time, { size: 'xs', color: C.muted, flex: 0, gravity: 'top' }),
        {
          type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
          contents: [
            text(item.title, { size: 'md', weight: 'bold', color: C.ink, wrap: true }),
            ...(item.sub ? [text(item.sub, { size: 'xs', color: C.muted, wrap: true })] : [])
          ]
        },
        { type: 'box', layout: 'horizontal', flex: 0, spacing: 'xs', contents: actions }
      ]
    });
  });

  const body = { type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, contents };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'sm', backgroundColor: FOOTER_COLOR,
    contents: [
      text('重要數字請核對後再參考', { size: 'xxs', color: C.muted, align: 'center' }),
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟照護站看全部', text: '照護站' } }
    ]
  };
  return bubble(
    `最近紀錄（${petName}）${items.length} 筆`,
    { type: 'bubble', size: 'mega', header: header(`最近紀錄・${petName}`), body, footer }
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
