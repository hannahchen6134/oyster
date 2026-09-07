// LINE Flex Message 卡片（喵喵照護安心管家）
// 視覺沿用照護站：暖棕 #734921、紙白、朱紅只做警示。
// 每張卡都附 altText（通知列預覽）與文字備援由呼叫端處理。

import { goalSection, recordPrompt } from './replies.js';
import { BRAND, displayMedStatus } from './brand.js';
import { isWetFoodType, isEstimableType } from './summary.js';
import { formatWeightKg } from './util.js';

export function reportChoiceFlex(doctorUrl, careUrl) {
  return { type: 'flex', altText: '這次要給誰？給醫生看／給照護者', contents: {
    type: 'bubble', body: { type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'lg', backgroundColor: '#FFFDF8', contents: [
      { type: 'text', text: '這次要給誰？', weight: 'bold', size: 'xl', color: '#5A3617', wrap: true },
      ...[[ '🏥 給醫生看', '整理近期狀況、異常、用藥與重要變化', doctorUrl ], [ '🐾 給照護者', '家人、朋友或貓保姆照顧時使用', careUrl ]].map(([label, description, uri]) => ({
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#734921', action: { type: 'uri', label, uri } },
          { type: 'text', text: description, size: 'sm', color: '#5C4A38', wrap: true }
        ]
      }))
    ] }
  } };
}

// 卡身：暖米白（和照護站網站同一個紙面世界，不用冷白）；標題：暖棕漸層
const BODY_BG = '#FFFDF8';
const HEADER_BG = { type: 'linearGradient', angle: '135deg', startColor: '#8A5A2C', endColor: '#6A4119' };
const FOOTER_COLOR = '#FAF6EE';
const SEPARATOR = '#EDE4D6'; // 和網站 --line 同色

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
  water: { label: '喝水', bg: '#E5F2EC', fg: '#2B7A66' },
  dry: { label: '乾糧', bg: '#F4EBD4', fg: '#886722' },
  wet: { label: '罐頭/濕食', bg: '#EBF1DD', fg: '#5C7031' },
  med: { label: '藥物', bg: C.tint, fg: C.brand },
  vomit: { label: '嘔吐', bg: C.sealTint, fg: C.seal },
  stool: { label: '便便', bg: C.soft, fg: C.inkSoft },
  mood: { label: '精神', bg: C.soft, fg: C.inkSoft },
  weight: { label: '體重', bg: C.oliveTint, fg: C.olive },
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
    paddingAll: '15px', paddingStart: '20px', paddingEnd: '20px',
    contents: [
      text(title, { color: '#FFFFFF', weight: 'bold', size: 'sm', flex: 1 })
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

// 迷你數據卡：一排 2–3 格；accent＝類別色（數字上色＋頂端色條），讓三格一眼分得出來
function statCell(label, value, unit, accent) {
  const contents = [
    text(label, { size: 'xxs', color: C.muted, align: 'center' }),
    text(value, { size: 'lg', weight: 'bold', color: accent || '#3F2B18', align: 'center', margin: 'xs' }),
    text(unit, { size: 'xxs', color: C.muted, align: 'center' })
  ];
  if (accent) {
    contents.unshift({ type: 'box', layout: 'vertical', height: '3px', width: '22px', backgroundColor: accent, cornerRadius: '999px', contents: [{ type: 'filler' }] });
  }
  return {
    type: 'box', layout: 'vertical', flex: 1, alignItems: 'center',
    backgroundColor: '#FFFFFF', cornerRadius: '12px',
    borderColor: '#EBE3D4', borderWidth: '1px',
    paddingTop: '9px', paddingBottom: '10px', paddingStart: '4px', paddingEnd: '4px', spacing: 'xs',
    contents
  };
}
// 類別色（水＝藍綠、食物＝琥珀、熱量＝棕），與網站一致
// 與照護站網站同一套色票：水＝湖水綠、食物＝麥色、熱量＝藕紫
const STAT_ACCENT = { water: '#2B7A66', food: '#886722', kcal: '#5A4A84' };
// P0-3：熱量含「類型預設估算」時，單位標「粗估」（誠實呈現、不假裝精確；設定品項每克熱量後就變精確）
// 熱量單位標註：不完整（有食物熱量未計入）優先於粗估——避免把不完整的總熱量呈現成完整精準值。
const kcalUnit = (estimated, incomplete) => (incomplete ? 'kcal・部分未計' : (estimated ? 'kcal・粗估' : 'kcal'));
// 熱量統計格的顯示值：完全沒算到熱量（只有未知食物）→ 不顯示「0」，改「未設定」；
// 有算到一部分但仍不完整 → 顯示「150+」表示尚有未計入。
const kcalStatValue = (kcal, incomplete) => {
  if (incomplete && !(Number(kcal) > 0)) return '未設定';
  return `${fmt(kcal)}${incomplete && Number(kcal) > 0 ? '+' : ''}`;
};

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

// 目標區（有設定才出現）：進度條 + 藥時段 +（可選）鼓勵語
function goalContents(pet, summary, date, showEncourage = true) {
  const goalWater = Number(pet?.goalWaterMl) || 0;
  const goalKcal = Number(pet?.goalKcal) || 0;
  const slots = parseGoalSlots(pet);
  if (!goalWater && !goalKcal && !slots.length) return [];

  const contents = [
    { type: 'separator', margin: 'lg', color: SEPARATOR },
    text('今日目標', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' })
  ];
  if (goalWater > 0) contents.push(progressBar(`水分 ${fmt(summary.totalWaterMl)} / ${fmt(goalWater)} ml`, summary.totalWaterMl, goalWater));
  if (goalKcal > 0) contents.push(progressBar(`熱量 ${fmt(summary.kcal)} / ${fmt(goalKcal)} kcal${summary.kcalIncomplete ? '（尚有未計熱量）' : (summary.kcalEstimated ? '（粗估）' : '')}`, summary.kcal, goalKcal));
  if (slots.length) {
    const doneSlots = new Set((summary.meds || []).filter((m) => m.status === '已吃').map((m) => m.slot));
    const parts = slots.map((slot) => `${slot} ${doneSlots.has(slot) ? '✓' : '未記'}`).join('　');
    contents.push(statRow('藥', parts));
  }
  // 鼓勵語只在今日卡出現，記錄卡不重複（showEncourage=false）
  if (showEncourage) {
    const section = goalSection(pet, summary, date);
    const lastLine = section.split('\n').filter(Boolean).pop() || '';
    if (lastLine && !lastLine.startsWith('──')) {
      contents.push(text(lastLine, { size: 'xs', color: C.inkSoft, wrap: true, margin: 'md' }));
    }
  }
  return contents;
}

function bubble(altText, contents) {
  return { type: 'flex', altText: altText.slice(0, 390), contents };
}

// 自繪動作鈕：用 box＋置中 text 而非 style:primary 的 button——文字顏色與置中完全可控，
// 避免某些 LINE 版本對 primary 鈕自動上色時把含「空格＋數字」的 label（如「改成 4.28kg」）
// 渲染成看不見。box 的 action 帶 postback（label 非空、供無障礙/displayText），可見字來自內層 text。
function solidActionBtn(label, data, { bg = C.brand, fg = '#FFFFFF' } = {}) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '8px',
    paddingTop: '11px', paddingBottom: '11px', paddingStart: '12px', paddingEnd: '12px',
    action: { type: 'postback', label: String(label || ' '), data, displayText: String(label || ' ') },
    contents: [text(label, { color: fg, weight: 'bold', size: 'md', align: 'center', wrap: false })]
  };
}
function outlineActionBtn(label, data, { fg = C.inkSoft, border = '#D9CBB6' } = {}) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', cornerRadius: '8px',
    borderColor: border, borderWidth: '1px',
    paddingTop: '11px', paddingBottom: '11px', paddingStart: '12px', paddingEnd: '12px',
    action: { type: 'postback', label: String(label || ' '), data, displayText: String(label || ' ') },
    contents: [text(label, { color: fg, weight: 'bold', size: 'md', align: 'center', wrap: false })]
  };
}

// ---------- 記錄確認卡 ----------
export function recordFlex({ pet, categoryKey, mainText, subText, summary, date, logId, hints = [], title = '', tip = '', siteUrl = '', warnNoKcal = false, foodType = '', estimated = false, estKcalPerG = 0, addedWaterMl = 0, undoData = '', undoCount = 1 }) {
  const style = CATEGORY_STYLE[categoryKey] || CATEGORY_STYLE.note;
  // 零食/其他這種「沒辦法估」的類型：不假裝估算，也不用紅色錯誤——溫和請使用者填一次（包裝上有）
  const warnBox = warnNoKcal ? [{
    type: 'box', layout: 'vertical', backgroundColor: C.tint, cornerRadius: '10px',
    paddingAll: '12px', margin: 'md', spacing: 'xs',
    contents: [
      text('熱量未設定（零食沒有系統粗估值）', { size: 'sm', weight: 'bold', color: C.brand, wrap: true }),
      text('零食每家熱量差很多，不亂估、也不計入總熱量。這筆先記份量了；到管家後台補品牌與實際熱量，之後就會自動算。', { size: 'xxs', color: C.inkSoft, wrap: true })
    ]
  }] : [];
  // 熱量用「類型預設」估算時：溫和標示（不是錯，是待補），並提醒可設定精確值
  const estBox = estimated ? [{
    type: 'box', layout: 'vertical', backgroundColor: C.tint, cornerRadius: '10px',
    paddingAll: '12px', margin: 'md', spacing: 'xs',
    contents: [
      text(`≈ 目前用系統粗估值（${foodType || '食物'}每克約 ${estKcalPerG} kcal）`, { size: 'sm', weight: 'bold', color: C.brand, wrap: true }),
      text('想記品牌、讓熱量更準？到管家後台設定「常吃食物」，設定後，之後的紀錄會自動套用。', { size: 'xxs', color: C.inkSoft, wrap: true })
    ]
  }] : [];
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      // 食物（乾糧/罐頭）品名已含類型，不再重複顯示類型膠囊；其他類別（喝水/藥…）保留
      ...(['dry', 'wet'].includes(categoryKey) ? [] : [{ type: 'box', layout: 'horizontal', contents: [tag(style.label, style)] }]),
      text(mainText, { size: 'xl', weight: 'bold', color: C.ink, margin: ['dry', 'wet'].includes(categoryKey) ? 'none' : 'md', wrap: true }),
      // 另外加的水＝和食物同層級的攝取量，用粗體＋水色獨立一行，方便一眼確認有算進今日水分
      ...(addedWaterMl > 0 ? [text(`＋ 另外加水 ${addedWaterMl} ml`, { size: 'lg', weight: 'bold', color: STAT_ACCENT.water, margin: 'sm', wrap: true })] : []),
      ...(subText ? [text(subText, { size: 'xs', color: C.muted, wrap: true, margin: 'sm' })] : []),
      ...warnBox,
      ...estBox,
      { type: 'separator', margin: 'lg', color: SEPARATOR },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml', STAT_ACCENT.water),
        statCell('食物', fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0)), 'g', STAT_ACCENT.food),
        statCell('熱量', kcalStatValue(summary.kcal, summary.kcalIncomplete), kcalUnit(summary.kcalEstimated, summary.kcalIncomplete), STAT_ACCENT.kcal)
      ]),
      ...(summary.kcalIncomplete ? [text(`※ 有 ${summary.unknownKcalCount} 筆食物尚未設定熱量，未計入總熱量`, { size: 'xxs', color: C.muted, wrap: true, margin: 'sm' })] : []),
      ...goalContents(pet, summary, date, false),
      ...hints.filter(Boolean).map((hint) =>
        text(`※ ${hint.replace(/\n/g, '')}`, { size: 'xs', color: C.muted, wrap: true, margin: 'md' })),
      ...(tip ? [text(tip, { size: 'xxs', color: C.muted, wrap: true, margin: 'lg' })] : [])
    ]
  };
  // 記錯了不用背指令：水/食可「改數量」，人人都會的「刪除」；下面一顆開站
  const editable = ['water', 'dry', 'wet'].includes(categoryKey);
  // 刪除鈕文案依「這次 smid 的正式紀錄筆數」：1 筆＝刪除這筆、2 筆以上＝刪除這次 N 筆。
  // （資料已正式寫入，對使用者是「刪除」不是「撤銷」。）底層行為不變：都走 undoOp，用 undoData 刪同次整批。
  const multiUndo = Number(undoCount) >= 2;
  const undoLabel = multiUndo ? `🗑 刪除這次 ${undoCount} 筆` : '🗑 刪除這筆';
  const undoDisplay = multiUndo ? `刪除這次 ${undoCount} 筆` : '刪除這筆';
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      // 每顆各佔整排（不再與「改數量」共用半寬），避免 LINE Flex 把中文按鈕文字截斷成「撤銷這次…」
      ...(editable ? [{ type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '✏️ 改數量', data: `action=editAmount&logId=${logId}`, displayText: '改數量' } }] : []),
      // 有 undoData（這次操作建立的全部 log，含連動加水）→ 撤同次整批；否則沿用單筆「刪除這筆」
      (undoData
        ? { type: 'button', height: 'sm', style: 'link', color: C.brand,
            action: { type: 'postback', label: undoLabel, data: `action=undoOp&${undoData}`, displayText: undoDisplay } }
        : { type: 'button', height: 'sm', style: 'link', color: C.brand,
            action: { type: 'postback', label: '🗑 刪除這筆', data: `action=delAsk&logId=${logId}`, displayText: '刪除這筆' } }),
      // 零食/其他沒辦法估 → 「填這個的熱量」擺成主要按鈕（品牌色，非紅色警示）
      ...(warnNoKcal ? [{ type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '填這個的熱量', text: `設定${foodType || '零食'}` } }] : []),
      // 估算時：給「設定精確熱量」入口（品牌色，非警示）
      ...(estimated && !warnNoKcal ? [{ type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '設定精確熱量', text: `設定${foodType || '罐頭'}` } }] : []),
      { type: 'button', height: 'sm', style: (warnNoKcal || estimated) ? 'link' : 'primary', color: C.brand,
        // 直接開網站（已烤入登入連結）；沒有 siteUrl 時退回舊的訊息觸發
        action: siteUrl
          ? { type: 'uri', label: '開啟管家後台', uri: siteUrl }
          : { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  const headerTitle = title || `已記錄・${pet?.petName || '貓貓'}`;
  return bubble(`${title ? '已更新' : '已記錄'} ${mainText}`, { type: 'bubble', size: 'mega', header: header(headerTitle), body, footer });
}

// 輕卡：例行的吃喝藥用這張——一行主內容＋一行今日累積＋小小的改/刪，不洗版
export function recordFlexCompact({ pet, categoryKey, mainText, subText, summary, logId }) {
  const style = CATEGORY_STYLE[categoryKey] || CATEGORY_STYLE.note;
  const foodG = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: BODY_BG, spacing: 'sm',
    contents: [
      { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
        tag(style.label, style),
        text(mainText, { size: 'md', weight: 'bold', color: C.ink, wrap: true, flex: 1 })
      ] },
      ...(subText ? [text(subText, { size: 'xxs', color: C.muted, wrap: true })] : []),
      text(`今日　水 ${fmt(summary.totalWaterMl)} ml・食 ${fmt(foodG)} g・熱 ${fmt(summary.kcal)} kcal${summary.kcalIncomplete ? '（尚有未計熱量）' : (summary.kcalEstimated ? '（粗估）' : '')}`,
        { size: 'xxs', color: C.inkSoft, wrap: true, margin: 'sm' })
    ]
  };
  const editable = ['water', 'dry', 'wet'].includes(categoryKey);
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '6px', paddingStart: '10px', paddingEnd: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      ...(editable ? [{ type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '✏️ 改數量', data: `action=editAmount&logId=${logId}`, displayText: '改數量' } }] : []),
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '🗑 刪除這筆', data: `action=delAsk&logId=${logId}`, displayText: '刪除這筆' } }
    ]
  };
  return bubble(`已記錄 ${mainText}`, { type: 'bubble', size: 'kilo', body, footer });
}

// ②③ 打了品名卻對不到已建立的品項時：不默默記 0 熱量，先回這張卡讓使用者選正確品項（熱量才算得到）。
// guessId＝模糊比對猜到最接近的品項 foodId，排最前面並標「最接近」。
// 純類型／口語別名輸入時的例句（下次只打這個就不用再選）：乾糧→乾乾、主食罐→主食…
const FOODTYPE_ALIAS_EG = { '乾糧': '乾乾', '主食罐': '主食', '副食罐': '副食', '罐頭': '罐罐', '零食': '零食' };

export function foodDisambigFlex({ pet, foodType, typedName, grams, addedWaterMl = 0, smid = '', pid = '', options = [], guessId = '', bareType = false }) {
  const styleKey = foodType === '乾糧' ? 'dry' : isWetFoodType(foodType) ? 'wet' : 'note';
  const style = CATEGORY_STYLE[styleKey] || CATEGORY_STYLE.note;
  const g = Number(grams) || 0;
  const aw = Number(addedWaterMl) || 0;                       // 額外加水（ml）：選品牌後仍要完整保留
  // 帶過加水量、原訊息 id 與 pending id（pid＝多筆待確認時綁定「這一筆」，避免取消/確認動到別筆）
  const carry = `&aw=${aw}&smid=${encodeURIComponent(String(smid || ''))}${pid ? `&pid=${encodeURIComponent(String(pid))}` : ''}`;
  const sorted = [...options].sort((a, b) => (b.foodId === guessId ? 1 : 0) - (a.foodId === guessId ? 1 : 0));
  const pickButtons = sorted.slice(0, 6).map((food) => {
    const isGuess = food.foodId === guessId;
    return {
      type: 'button', height: 'sm', style: isGuess ? 'primary' : 'secondary', color: isGuess ? C.brand : undefined,
      action: {
        type: 'postback',
        label: `${isGuess ? '🐱 ' : ''}${String(food.displayName)}`.slice(0, 20),
        data: `action=recFoodG&foodId=${food.foodId}&g=${g}${carry}`,
        displayText: `${food.displayName} ${g}g`
      }
    };
  });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('請確認這次吃的是哪一款', style)] },
      text(`「${typedName}」找不到已建立的品項`, { size: 'lg', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      text(`選一下這次吃的是哪款${foodType}，我才能把 ${g}g 換算成熱量。`, { size: 'sm', color: C.inkSoft, wrap: true, margin: 'sm' }),
      ...(guessId ? [text('最接近你常用的品項：', { size: 'xs', color: C.brand, weight: 'bold', wrap: true, margin: 'lg' })] : [])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: FOOTER_COLOR,
    contents: [
      ...pickButtons,
      { type: 'separator', margin: 'md', color: SEPARATOR },
      // 新增這個品項（走既有「設定<類型>」訊息流程）
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'message', label: `＋ 新增「${typedName}」`.slice(0, 20), text: `設定${foodType}` } },
      // 先記份量：熱量先用「類型平均」估算（誠實標示，不假裝不計算）；下方一行柔性說明，長輩也看得懂
      { type: 'button', height: 'sm', style: 'link', color: C.inkSoft,
        action: { type: 'postback', label: `先記${foodType} ${g}g（熱量先估算）`.slice(0, 20), data: `action=recFoodRaw&t=${encodeURIComponent(foodType)}&g=${g}&name=${encodeURIComponent(typedName)}${carry}`, displayText: `先記${foodType} ${g}g（熱量先估算）` } },
      text(`先依${foodType}平均熱量估算，之後設定正確品項，可再補上較精確的熱量。`, { size: 'xxs', color: C.muted, wrap: true, margin: 'none' }),
      // 只輸入類型／口語別名（沒指定品牌）＋這個類型沒設預設食物時：溫和說明「設預設下次免選」＋「粗估值」＋照護站入口。
      // 明確品牌輸入、已有預設、或打了品名對不到的情境都不顯示（bareType=false）。不強迫設定：上面「先記」隨時能直接完成。
      ...(bareType ? [
        { type: 'separator', margin: 'md', color: SEPARATOR },
        text(`常吃固定同一款？到管家後台設成「預設食物」，下次只打「${(FOODTYPE_ALIAS_EG[foodType] || foodType)}${Number(grams) || 0}」就不用再選。`, { size: 'xxs', color: C.brand, wrap: true, margin: 'none' }),
        text(isEstimableType(foodType)
          ? '若這款尚未設定實際熱量，會先用系統粗估值（已設定的品項就用實際熱量）；想讓品牌與熱量更準，可到管家後台補設定，沒設定也能先記。'
          : '若這款尚未設定實際熱量，零食會標示「未計入」（已設定的就用實際熱量）；想更準可到管家後台補品牌與實際熱量，沒設定也能先記。',
          { size: 'xxs', color: C.muted, wrap: true, margin: 'none' }),
        { type: 'button', height: 'sm', style: 'link', color: C.brand,
          action: { type: 'message', label: '到管家後台設定品牌／熱量', text: '照護站' } }
      ] : []),
      { type: 'separator', margin: 'md', color: SEPARATOR },
      { type: 'button', height: 'sm', style: 'link', color: C.muted,
        action: { type: 'postback', label: '取消', data: `action=foodCancel&smid=${encodeURIComponent(String(smid || ''))}${pid ? `&pid=${encodeURIComponent(String(pid))}` : ''}`, displayText: '取消' } }
    ]
  };
  return bubble(`「${typedName}」是哪一個${foodType}？`, { type: 'bubble', size: 'mega', header: header(`確認品項・${pet?.petName || '貓貓'}`), body, footer });
}

// 一則訊息記多筆時的合併確認卡：條列這次記了哪幾筆 ＋ 當天累積
export function multiRecordFlex(pet, lines, summary, date, siteUrl = '', undoData = '') {
  const foodG = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag(`一次記了 ${lines.length} 筆`, CATEGORY_STYLE.note)] },
      ...lines.map((line) => text(`· ${line}`, { size: 'md', weight: 'bold', color: C.ink, wrap: true, margin: 'sm' })),
      { type: 'separator', margin: 'lg', color: SEPARATOR },
      text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml', STAT_ACCENT.water),
        statCell('食物', fmt(foodG), 'g', STAT_ACCENT.food),
        statCell('熱量', kcalStatValue(summary.kcal, summary.kcalIncomplete), kcalUnit(summary.kcalEstimated, summary.kcalIncomplete), STAT_ACCENT.kcal)
      ]),
      ...goalContents(pet, summary, date)
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      // 一次記多筆＝必為 2 筆以上，統一「刪除這次 N 筆」：一次刪除這張卡建立的全部 log（含連動加水）
      ...(undoData ? [{ type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: `🗑 刪除這次 ${lines.length} 筆`, data: `action=undoOp&${undoData}`, displayText: `刪除這次 ${lines.length} 筆` } }] : []),
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: siteUrl
          ? { type: 'uri', label: '開啟管家後台', uri: siteUrl }
          : { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(`已記錄 ${lines.length} 筆`, { type: 'bubble', size: 'mega', header: header(`已記錄・${pet?.petName || '貓貓'}`), body, footer });
}

// 刪除二段式確認卡：用 Flex 氣泡內建按鈕（永遠可見、進對話流），取代原本浮動易漏看的 quick reply。
// 兩顆都是 postback：確認鈕綁原本的 undo token（smid 或 內嵌 ids），取消鈕只回覆、不動任何紀錄。
// count＝這次要處理的正式紀錄筆數：1 筆＝「刪除這筆」、2 筆以上＝「刪除這次 N 筆」。（資料已寫入，一律用「刪除」措辭。）
export function undoConfirmFlex({ pet, lines = [], undoKey = '', count = 1 }) {
  const multi = Number(count) >= 2;
  const title = multi ? `確定要刪除這次 ${count} 筆紀錄嗎？` : '確定要刪除這筆紀錄嗎？';
  const confirmLabel = '確認刪除';
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('要確認一下', CATEGORY_STYLE.vomit)] },
      text(title, { size: 'lg', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      ...lines.map((line) => text(`· ${line}`, { size: 'sm', color: C.inkSoft, wrap: true, margin: 'sm' }))
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: FOOTER_COLOR,
    contents: [
      // 危險動作＝朱紅實心，明確可點；確認鈕綁 undoKey（原 smid／ids），不要求使用者打字
      { type: 'button', height: 'sm', style: 'primary', color: C.seal,
        action: { type: 'postback', label: confirmLabel, data: `action=undoDo&${undoKey}`, displayText: confirmLabel } },
      { type: 'button', height: 'sm', style: 'link', color: C.muted,
        action: { type: 'postback', label: '取消', data: 'action=undoCancel', displayText: '取消' } }
    ]
  };
  return bubble(title, { type: 'bubble', size: 'mega', header: header(`刪除確認・${pet?.petName || '貓貓'}`), body, footer });
}

// ---------- 體重：修改確認卡 ----------
// 明確修改語意（改／改成／修正…）＝allowAddNew:false → 只給「改成 Xkg／取消」，不給「記為今天的新體重」，
// 避免同一天因修錯字多記一筆。只有語意模糊、且最近一筆非今天時（allowAddNew:true）才提供三選一。
// keys 帶 logId／old／amt／smid，讓確認鈕的行為冪等（重複點不會改兩次或多記一筆）。
export function weightModifyConfirmFlex({ pet, amount, latest, keys, allowAddNew = false }) {
  const petName = pet?.petName || '貓貓';
  const latestDate = String(latest?.eventDateTime || '').slice(0, 10).replace(/-/g, '/');
  const latestKg = formatWeightKg(latest?.amount);
  // 明確修改：標題直接寫「改成」；模糊二選一：問「要怎麼處理」
  const title = allowAddNew ? `要怎麼處理${petName}的 ${formatWeightKg(amount)} 公斤？` : `把${petName}最近一次體重改成 ${formatWeightKg(amount)} kg？`;
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('要確認一下', CATEGORY_STYLE.weight)] },
      text(title, { size: 'lg', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      { type: 'box', layout: 'vertical', backgroundColor: C.tint, cornerRadius: '10px', paddingAll: '12px', margin: 'md', spacing: 'xs',
        contents: [
          text('最近一次體重', { size: 'xs', color: C.muted }),
          text(`${latestDate}　${latestKg} kg`, { size: 'md', weight: 'bold', color: C.ink })
        ] }
    ]
  };
  const modLabel = `改成 ${formatWeightKg(amount)}kg`;
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: FOOTER_COLOR,
    contents: [
      // 主鈕（自繪 box，保證「改成 4.28kg」置中白字清楚可見）
      solidActionBtn(modLabel, `action=wMod&${keys}`),
      // 只有模糊語意（且最近一筆非今天）才給「記為今天的新體重」；明確「改」不顯示，杜絕同日重複
      ...(allowAddNew ? [outlineActionBtn('記為今天的新體重', `action=wAdd&${keys}`, { fg: C.brand })] : []),
      // 取消（自繪 box，深色文字足夠對比，不再過淡）
      outlineActionBtn('取消', 'action=wCancel')
    ]
  };
  return bubble(`${title}最近一次 ${latestKg}kg`, { type: 'bubble', size: 'mega', header: header(`體重修改・${petName}`), body, footer });
}

// ---------- 體重：沒有既有紀錄可改時 ----------
export function weightNoRecordFlex({ pet, amount, keys }) {
  const petName = pet?.petName || '貓貓';
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('體重', CATEGORY_STYLE.weight)] },
      text(`${petName}還沒有可以修改的體重紀錄`, { size: 'lg', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      text(`要把 ${formatWeightKg(amount)}kg 記為今天的新體重嗎？`, { size: 'sm', color: C.inkSoft, margin: 'sm', wrap: true })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: FOOTER_COLOR,
    contents: [
      solidActionBtn('記為今天體重', `action=wAdd&${keys}`),
      outlineActionBtn('取消', 'action=wCancel')
    ]
  };
  return bubble(`${petName}還沒有體重紀錄，要把 ${formatWeightKg(amount)}kg 記為今天的嗎？`, { type: 'bubble', size: 'mega', header: header(`體重・${petName}`), body, footer });
}

// ---------- 體重：新增成功卡（改重量／刪除這筆／開啟照護站）----------
export function weightAddedFlex({ pet, amount, logId, summary, date, siteUrl = '' }) {
  const petName = pet?.petName || '貓貓';
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('體重', CATEGORY_STYLE.weight)] },
      text(`體重 ${formatWeightKg(amount)} kg`, { size: 'xl', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      ...(summary ? [
        { type: 'separator', margin: 'lg', color: SEPARATOR },
        text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
        statCellRow([
          statCell('水分', fmt(summary.totalWaterMl), 'ml', STAT_ACCENT.water),
          statCell('食物', fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0)), 'g', STAT_ACCENT.food),
          statCell('熱量', kcalStatValue(summary.kcal, summary.kcalIncomplete), kcalUnit(summary.kcalEstimated, summary.kcalIncomplete), STAT_ACCENT.kcal)
        ])
      ] : [])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '✏️ 改重量', data: `action=wEditAsk&logId=${logId}`, displayText: '改重量' } },
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '🗑 刪除這筆', data: `action=delAsk&logId=${logId}`, displayText: '刪除這筆' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: siteUrl ? { type: 'uri', label: '開啟管家後台', uri: siteUrl } : { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(`已記錄・${petName} 體重 ${formatWeightKg(amount)} kg`, { type: 'bubble', size: 'mega', header: header(`已記錄・${petName}`), body, footer });
}

// ---------- 體重：修改成功卡（再修改／開啟照護站）----------
export function weightModifiedFlex({ pet, oldKg, newKg, recordDate, logId, siteUrl = '' }) {
  const petName = pet?.petName || '貓貓';
  const dateLabel = String(recordDate || '').slice(0, 10).replace(/-/g, '/');
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      { type: 'box', layout: 'horizontal', contents: [tag('已修改', CATEGORY_STYLE.weight)] },
      text(`已修改${petName}最近一次體重`, { size: 'md', weight: 'bold', color: C.ink, margin: 'md', wrap: true }),
      text(`${formatWeightKg(oldKg)} kg → ${formatWeightKg(newKg)} kg`, { size: 'xl', weight: 'bold', color: C.olive, margin: 'sm', wrap: true }),
      text(`紀錄日期：${dateLabel}`, { size: 'xs', color: C.muted, margin: 'sm' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'postback', label: '✏️ 再修改', data: `action=wEditAsk&logId=${logId}`, displayText: '再修改' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: siteUrl ? { type: 'uri', label: '開啟管家後台', uri: siteUrl } : { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(`已修改${petName}最近一次體重 ${formatWeightKg(oldKg)}→${formatWeightKg(newKg)} kg`, { type: 'bubble', size: 'mega', header: header(`體重已修改・${petName}`), body, footer });
}

// ---------- 今日總結卡 ----------
export function todayFlex({ pet, date, summary, dateLabel, siteUrl = '' }) {
  const meds = summary.meds || [];
  const medValue = meds.length
    ? meds.map((m) => `${[m.slot, m.name].filter(Boolean).join(' ')} ${m.status === '已吃' ? '✓' : `⚠${displayMedStatus(m.status)}`}`).join('、')
    : '尚無紀錄';
  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount}`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount}`);
  const careParts = [];
  if (summary.vaccineCount > 0) careParts.push('疫苗');
  if (summary.dewormCount > 0) careParts.push('除蟲');

  const totalFood = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(`共 ${summary.entryCount} 筆紀錄`, { size: 'xs', color: C.muted, align: 'center' }),
      statCellRow([
        statCell('水分', fmt(summary.totalWaterMl), 'ml', STAT_ACCENT.water),
        statCell('食物', fmt(totalFood), 'g', STAT_ACCENT.food),
        statCell('熱量', kcalStatValue(summary.kcal, summary.kcalIncomplete), kcalUnit(summary.kcalEstimated, summary.kcalIncomplete), STAT_ACCENT.kcal)
      ]),
      // 藥：有設定早/晚時段的貓，交給下方「今日目標」顯示（早/晚 ✓）＝不重複；
      // 沒設時段的貓才在這裡用膠囊列顯示，避免完全看不到用藥狀況
      ...(parseGoalSlots(pet).length ? [] : [statRow('💊 藥', medValue)]),
      ...(gutParts.length ? [statRow('🩺 腸胃', gutParts.join('・'))] : []),
      ...(careParts.length ? [statRow('💉 處置', careParts.join('・'))] : []),
      ...goalContents(pet, summary, date)
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: siteUrl
          ? { type: 'uri', label: '開啟管家後台', uri: siteUrl }
          : { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(
    `${dateLabel}（${pet?.petName}）水分 ${fmt(summary.totalWaterMl)} ml・熱量 ${fmt(summary.kcal)} kcal${summary.kcalIncomplete ? '（尚有未計熱量）' : (summary.kcalEstimated ? '（粗估）' : '')}`,
    { type: 'bubble', size: 'mega', header: header(`${dateLabel}・${pet?.petName || '貓貓'}`), body, footer }
  );
}

// ---------- 今日交班卡（可長按轉傳給照護夥伴）----------
export function handoffFlex(pet, dateLabel, data) {
  const petName = pet?.petName || '貓貓';
  const label = (t, first = false) => text(t, { size: 'sm', weight: 'bold', color: C.brand, margin: first ? 'none' : 'lg' });
  const pendRow = (p) => ({
    type: 'box', layout: 'baseline', margin: 'sm', contents: [
      text(p.title, { size: 'sm', color: C.ink, flex: 5, wrap: true }),
      text(p.at || '', { size: 'xs', color: C.muted, flex: 2, align: 'end' })
    ]
  });
  const statLine = (t) => text(`・${t}`, { size: 'sm', color: C.inkSoft, margin: 'sm', wrap: true });

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(`${dateLabel}　共 ${data.entryCount} 筆`, { size: 'xs', color: C.muted }),
      { type: 'separator', margin: 'md', color: SEPARATOR },
      label('今日總計', true),
      statCellRow([
        statCell('水分', fmt(data.totals.waterMl), 'ml', STAT_ACCENT.water),
        statCell('食物', fmt(data.totals.foodG), 'g', STAT_ACCENT.food),
        statCell('熱量', kcalStatValue(data.totals.kcal, data.totals.kcalIncomplete), kcalUnit(data.totals.kcalEstimated, data.totals.kcalIncomplete), STAT_ACCENT.kcal)
      ]),
      ...(data.medTotal ? [statRow('用藥', `${data.medDone}/${data.medTotal} 已完成`)] : []),
      { type: 'separator', margin: 'lg', color: SEPARATOR },
      label('還沒做'),
      ...(data.pending.length ? data.pending.map(pendRow) : [text('今天都完成了', { size: 'sm', color: C.muted, margin: 'sm' })]),
      { type: 'separator', margin: 'lg', color: SEPARATOR },
      label('今日狀況'),
      ...(data.status.length ? data.status.map(statLine) : [text('今天一切平穩', { size: 'sm', color: C.muted, margin: 'sm' })])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '12px', paddingStart: '20px', paddingEnd: '20px', backgroundColor: FOOTER_COLOR, spacing: 'sm',
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'postback', label: '傳給照護夥伴', data: 'action=handoffShare', displayText: '傳今日交班給夥伴' } },
      text('夥伴也可在自己的 LINE 打「交班」查看', { size: 'xxs', color: C.muted, align: 'center', wrap: true })
    ]
  };
  return bubble(
    `今日交班（${petName}）${dateLabel}`,
    { type: 'bubble', size: 'mega', header: header(`今日交班・${petName}`), body, footer }
  );
}

// ---------- 網站連結卡 ----------
export function websiteFlex(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('點下方按鈕直接登入', { size: 'md', weight: 'bold', color: '#3F2B18', align: 'center' }),
      text('月曆・給醫生看・血檢趨勢\n每一筆紀錄都能修改補登', { size: 'xs', color: C.muted, wrap: true, align: 'center', margin: 'md' }),
      { type: 'separator', margin: 'xl', color: SEPARATOR },
      text('連結會隨使用自動延長效期；就算過期，輸入「管家後台」拿新連結，資料都不會消失。請勿轉傳給別人。', { size: 'xxs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟管家後台', uri: url } }
    ]
  };
  return bubble('管家後台登入連結', { type: 'bubble', size: 'mega', header: header('管家後台'), body, footer });
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

// 喵爸媽安心上手：Step 1/2/3 彩色步驟卡（咖啡三色系；點範例帶進輸入框，自己改好再送）
export function onboardingCarousel(petName = '') {
  const T = {
    s1: { grad: { type: 'linearGradient', angle: '135deg', startColor: '#8A5A2C', endColor: '#6A4119' }, body: '#FBF7F0', chipBg: '#F3E7D6', chipFg: '#7A4E20', border: '#E9DAC4' },
    s2: { grad: { type: 'linearGradient', angle: '135deg', startColor: '#C0863E', endColor: '#9A6526' }, body: '#FDF9F2', chipBg: '#F6EAD7', chipFg: '#8A5E1E', border: '#EAD9BE' },
    s3: { grad: { type: 'linearGradient', angle: '135deg', startColor: '#5A3A22', endColor: '#3A2416' }, body: '#FBF7F2', chipBg: '#EDE3D6', chipFg: '#5A3617', border: '#E4D6C6' }
  };
  const stepHead = (grad, num, title, sub) => ({
    type: 'box', layout: 'horizontal', background: grad, paddingAll: '16px', paddingStart: '18px', spacing: 'md', alignItems: 'center',
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, width: '40px', height: '40px', backgroundColor: '#FFFFFF', cornerRadius: '999px', justifyContent: 'center',
        contents: [text(num, { size: 'xl', weight: 'bold', color: '#3A2416', align: 'center' })] },
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        text(`Step ${num}`, { size: 'xxs', color: '#FFFFFFB0', weight: 'bold' }),
        text(title, { size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true }),
        text(sub, { size: 'xxs', color: '#FFFFFFCC', margin: 'xs', wrap: true })
      ] }
    ]
  });
  const line = (t, cmd, desc) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'md', margin: 'md', paddingAll: '10px',
    backgroundColor: '#FFFFFF', cornerRadius: '12px', borderColor: t.border, borderWidth: '1px',
    action: { type: 'postback', label: cmd.slice(0, 20), data: 'action=fill', inputOption: 'openKeyboard', fillInText: cmd },
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, backgroundColor: t.chipBg, cornerRadius: '8px', paddingAll: '7px', paddingStart: '12px', paddingEnd: '12px',
        contents: [text(cmd, { size: 'sm', weight: 'bold', color: t.chipFg, wrap: false })] },
      text(desc, { size: 'xs', color: C.muted, flex: 1, gravity: 'center', wrap: true }),
      text('›', { size: 'lg', color: '#D8CDBA', flex: 0, gravity: 'center' })
    ]
  });
  const hintBox = (t, s) => ({
    type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: t.chipBg, cornerRadius: '10px', paddingAll: '11px',
    contents: [text(s, { size: 'xxs', color: t.chipFg, wrap: true, align: 'center' })]
  });
  const t1 = T.s1;
  const b1 = {
    type: 'bubble', size: 'mega', header: stepHead(t1.grad, '1', '先告訴我你的貓', '建立貓咪資料'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t1.body, contents: [
      text('點下面這句，把名字改成你家貓貓再送出', { size: 'xxs', color: C.muted, wrap: true }),
      line(t1, `新增貓咪 ${petName || '蚵仔'}`, '換成你家貓的名字'),
      hintBox(t1, '之後你記的每一筆，都會自動記到牠身上')
    ] }
  };
  const t2 = T.s2;
  const b2 = {
    type: 'bubble', size: 'mega', header: stepHead(t2.grad, '2', '記第一筆', '挑一個你最近做的'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t2.body, contents: [
      text('不用學格式，照平常說就好。點一句會帶進輸入框，改好再送出', { size: 'xxs', color: C.muted, wrap: true }),
      line(t2, '乾乾5', '吃飯（不用寫「克」）'),
      line(t2, '喝水30', '喝水'),
      line(t2, '嘔吐 白沫', '狀況＋描述'),
      hintBox(t2, '送出後會跳一張卡，顯示今天累計多少\n熱量沒設公式會先「估算」（標 ≈），到管家後台設定每克熱量就變精確')
    ] }
  };
  const t3 = T.s3;
  const b3 = {
    type: 'bubble', size: 'mega', header: stepHead(t3.grad, '3', '看狀況・給醫生', '平常追蹤、回診帶走'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t3.body, contents: [
      text('這兩句最常用，點了帶進輸入框送出即可', { size: 'xxs', color: C.muted, wrap: true }),
      line(t3, '今天', '看今天喝水／熱量／用藥／腸胃'),
      line(t3, '給醫生看', '整理近況給醫生看'),
      hintBox(t3, '記錯了打「改 30」或「刪除」・找家人一起顧打「邀請」')
    ] }
  };
  return bubble(
    '喵爸媽安心上手：① 新增貓咪 ② 記第一筆（乾乾5／喝水30／嘔吐 白沫）③ 打「今天」看狀況、「給醫生看」給醫生',
    { type: 'carousel', contents: [b1, b2, b3] }
  );
}

// ---------- 已刪除：安心卡＋照護站按鈕 ----------
// 刪除前的二次確認卡（避免手機誤觸一鍵刪資料）
// 共同照護邀請碼卡：一鍵複製（LINE 剪貼簿按鈕；舊版 LINE 不支援時仍可長按上一則訊息複製）
export function careInviteFlex(code, membersCount = 0) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('共同照護邀請碼', { size: 'xs', color: C.muted }),
      text(code, { size: 'xxl', weight: 'bold', color: C.brandDark, margin: 'sm', align: 'center' }),
      text(`7 天內有效，可給多人${membersCount ? `・目前一起照護 ${membersCount} 人` : ''}`,
        { size: 'xxs', color: C.muted, margin: 'md', wrap: true, align: 'center' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'clipboard', label: '📋 複製邀請碼', clipboardText: code } }
    ]
  };
  return bubble(`共同照護邀請碼：${code}`, { type: 'bubble', size: 'kilo', body, footer });
}

// 共同照護·即時通知卡：幫手記了一筆，飼主看到就能當場刪錯或開站修改
export function careNotifyFlex(who, petName, desc, logId, siteUrl, summary = null) {
  // 共同照護者記一筆 → 飼主即時收到，並看到「今日累積」一起加總（和記錄卡同一套三格數據）
  const totals = summary ? [
    { type: 'separator', margin: 'lg', color: SEPARATOR },
    text('今日累積', { size: 'xs', color: C.muted, margin: 'lg', weight: 'bold' }),
    statCellRow([
      statCell('水分', fmt(summary.totalWaterMl), 'ml', STAT_ACCENT.water),
      statCell('食物', fmt((Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0)), 'g', STAT_ACCENT.food),
      statCell('熱量', kcalStatValue(summary.kcal, summary.kcalIncomplete), kcalUnit(summary.kcalEstimated, summary.kcalIncomplete), STAT_ACCENT.kcal)
    ])
  ] : [];
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(`📝 ${who} 記錄了 ${petName}`, { size: 'xs', color: C.muted }),
      text(desc, { size: 'md', weight: 'bold', color: C.ink, wrap: true, margin: 'md' }),
      ...totals,
      text('記錯了嗎？可以直接刪除，或開管家後台調整', { size: 'xxs', color: C.muted, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'secondary',
        action: { type: 'postback', label: '🗑 刪除這筆', data: `action=delAsk&logId=${logId}`, displayText: '刪除這筆' } },
      ...(siteUrl ? [{ type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開管家後台修改', uri: siteUrl } }] : [])
    ]
  };
  return bubble(`📝 ${who} 記錄了 ${petName}：${desc}`, { type: 'bubble', size: 'kilo', body, footer });
}

export function confirmDeleteFlex(logId, desc) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('確定要刪除這筆嗎？', { size: 'md', weight: 'bold', color: C.ink }),
      ...(desc ? [text(desc, { size: 'sm', color: C.inkSoft, wrap: true, margin: 'md' })] : []),
      text('刪除後就找不回來了', { size: 'xs', color: C.muted, margin: 'md' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'secondary',
        action: { type: 'postback', label: '保留', data: 'action=cancelDel', displayText: '保留這筆' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.seal,
        action: { type: 'postback', label: '確定刪除', data: `action=delLog&logId=${logId}`, displayText: '確定刪除' } }
    ]
  };
  return bubble('確定要刪除這筆嗎？', { type: 'bubble', body, footer });
}

export function deletedCard(url) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text('已刪除剛剛的資料囉', { size: 'md', weight: 'bold', color: '#3F2B18', align: 'center' }),
      text('若要刪除或調整其他紀錄，\n可以開啟管家後台處理', { size: 'xs', color: C.muted, wrap: true, align: 'center', margin: 'md' })
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', style: 'primary', color: C.brand,
        action: { type: 'uri', label: '開啟管家後台', uri: url } }
    ]
  };
  return bubble('已刪除剛剛的資料', { type: 'bubble', size: 'mega', header: header('已刪除'), body, footer });
}

// ---------- 吃過的食物：LINE 時間軸（逐筆＋每筆「修改」）＋修改選單＋改品牌選單 ----------
// 每筆只放一顆輕量「修改」（§2/§15），點進去才展開選單；使用者看不到 logId／foodId（§11）。
const EAT_TL_MAX = 8;
function tlEditBtn(logId) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', cornerRadius: '8px',
    borderColor: '#D9CBB6', borderWidth: '1px', justifyContent: 'center',
    paddingTop: '6px', paddingBottom: '6px', paddingStart: '14px', paddingEnd: '14px',
    action: { type: 'postback', label: '修改', data: `action=foodEdit&logId=${logId}`, displayText: '修改' },
    contents: [text('修改', { color: C.brand, weight: 'bold', size: 'sm', align: 'center' })]
  };
}
export function foodTimelineFlex({ rows, petName = '', label = '食物', range = '最近 30 天', siteUrl = '' }) {
  const shown = rows.slice(0, EAT_TL_MAX);
  const items = [];
  shown.forEach((r, i) => {
    if (i > 0) items.push({ type: 'separator', color: SEPARATOR });
    const at = String(r.at || '');
    const md = at.length >= 10 ? `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))}` : at.slice(0, 10);
    const hm = at.slice(11, 16);
    const amt = `${Math.round(Number(r.amount) || 0)}g`;
    const servedNote = Number(r.servedAmount) > 0
      ? `（原 ${Math.round(Number(r.servedAmount))}g・剩 ${Math.round(Number(r.leftoverAmount) || 0)}g）` : '';
    items.push({
      type: 'box', layout: 'horizontal', spacing: 'md', paddingTop: '10px', paddingBottom: '10px',
      contents: [
        { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
          text(`${md}${hm ? ' ' + hm : ''}`, { size: 'xxs', color: C.muted }),
          text(`${r.name}　${amt}`, { size: 'sm', color: C.ink, weight: 'bold', wrap: true }),
          ...(servedNote ? [text(`實吃 ${amt}${servedNote}`, { size: 'xxs', color: C.muted, wrap: true })] : [])
        ] },
        { type: 'box', layout: 'vertical', flex: 0, justifyContent: 'center', contents: [tlEditBtn(r.logId)] }
      ]
    });
  });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, spacing: 'none',
    contents: [
      text(`${petName ? petName + ' ' : ''}${range}的${label}紀錄`, { size: 'sm', weight: 'bold', color: C.ink }),
      text('點任一筆的「修改」可改份量、品牌或刪除', { size: 'xxs', color: C.muted, margin: 'sm', wrap: true }),
      { type: 'box', layout: 'vertical', margin: 'md', spacing: 'none', contents: items },
      ...(rows.length > EAT_TL_MAX ? [text(`⋯還有 ${rows.length - EAT_TL_MAX} 筆，完整看管家後台`, { size: 'xxs', color: C.muted, margin: 'md', wrap: true })] : [])
    ]
  };
  const footer = siteUrl ? {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [{ type: 'button', height: 'sm', style: 'secondary', action: { type: 'uri', label: '在管家後台看完整時間軸', uri: siteUrl } }]
  } : undefined;
  return bubble(`${petName ? petName + ' ' : ''}${range}的${label}紀錄`, { type: 'bubble', size: 'mega', header: header('吃過的食物'), body, ...(footer ? { footer } : {}) });
}

// 修改選單（§11：只放「你要改什麼」，不露 DB 欄位）。改份量／刪除沿用既有 postback；改品牌為新流程。
export function foodEditMenuFlex({ logId, name, whenLabel, eatenText, siteUrl = '' }) {
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, spacing: 'xs',
    contents: [
      text('要修改什麼？', { size: 'md', weight: 'bold', color: C.ink }),
      { type: 'box', layout: 'vertical', backgroundColor: C.tint, cornerRadius: '10px', paddingAll: '12px', margin: 'md', spacing: 'xs',
        contents: [
          text(name, { size: 'sm', weight: 'bold', color: C.brand, wrap: true }),
          text(`${whenLabel}　${eatenText}`, { size: 'xs', color: C.inkSoft, wrap: true })
        ] },
      { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: [
        solidActionBtn('改份量', `action=editAmount&logId=${logId}`),
        outlineActionBtn('改品牌／品項', `action=foodBrandAsk&logId=${logId}`, { fg: C.brand, border: '#D9CBB6' }),
        outlineActionBtn('刪除這筆', `action=delAsk&logId=${logId}`, { fg: C.seal, border: '#E3B9AE' })
      ] }
    ]
  };
  const footer = siteUrl ? {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [{ type: 'button', height: 'sm', style: 'secondary', action: { type: 'uri', label: '到管家後台編輯更多', uri: siteUrl } }]
  } : undefined;
  return bubble('要修改這筆的什麼？', { type: 'bubble', header: header('修改紀錄'), body, ...(footer ? { footer } : {}) });
}

// 改品牌／品項：只列目前家庭「同 foodType」的既有品項（active），不建立新品項（§6）。
export function foodBrandPickFlex({ logId, foodType, currentName, foods, siteUrl = '' }) {
  const options = foods.slice(0, 6).map((f) => outlineActionBtn(
    String(f.displayName).slice(0, 30),
    `action=foodBrandSet&logId=${logId}&foodId=${encodeURIComponent(f.foodId)}`,
    { fg: C.brand, border: '#D9CBB6' }
  ));
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, spacing: 'xs',
    contents: [
      text('要改成哪一款？', { size: 'md', weight: 'bold', color: C.ink }),
      text(`目前：${currentName}（${foodType}）`, { size: 'xs', color: C.muted, margin: 'sm', wrap: true }),
      ...(options.length
        ? [{ type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: options }]
        : [text(`還沒有建立${foodType}的品項。到管家後台新增後就能選。`, { size: 'sm', color: C.inkSoft, margin: 'lg', wrap: true })])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR, spacing: 'sm',
    contents: [
      ...(siteUrl ? [{ type: 'button', height: 'sm', style: 'secondary', action: { type: 'uri', label: '到管家後台新增食物', uri: siteUrl } }] : []),
      { type: 'button', height: 'sm', style: 'secondary', action: { type: 'postback', label: '取消', data: `action=foodEdit&logId=${logId}`, displayText: '取消' } }
    ]
  };
  return bubble('要改成哪一款？', { type: 'bubble', header: header('改品牌／品項'), body, footer });
}

// ---------- 「想看哪種紀錄？」回顧入口卡（模糊回顧詞觸發；手機單手可點）----------
// 每顆都是 message action：點一下＝幫使用者打出既有查詢句，沿用現有 parser／handler（不必記語法）。
export function reviewMenuFlex(siteUrl = '') {
  const btn = (label, msg) => ({ type: 'button', height: 'sm', style: 'secondary', action: { type: 'message', label, text: msg } });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: BODY_BG, spacing: 'sm',
    contents: [
      text('想看哪種紀錄？', { size: 'md', weight: 'bold', color: C.ink }),
      text('點一下就好，不用打整句', { size: 'xxs', color: C.muted, margin: 'xs' }),
      { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: [
        btn('🍚 吃過的食物', '最近吃什麼'),
        btn('💧 喝水', '今天'),
        btn('💊 用藥', '今天'),
        btn('🐾 狀況', '今天')
      ] }
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [siteUrl
      ? { type: 'button', height: 'sm', style: 'primary', color: C.brand, action: { type: 'uri', label: '查看完整照護紀錄', uri: siteUrl } }
      : { type: 'button', height: 'sm', style: 'primary', color: C.brand, action: { type: 'message', label: '查看完整照護紀錄', text: '管家後台' } }]
  };
  return bubble('想看哪種紀錄？', { type: 'bubble', header: header('想看哪種紀錄？'), body, footer });
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
      text('不用先設定，照平常說話就能記', { size: 'md', weight: 'bold', color: '#3F2B18', wrap: true, align: 'center' }),
      text('像聊天一樣打一句，我就幫你記好；\n回診時再一鍵整理給醫生看。', { size: 'sm', color: C.inkSoft, wrap: true, margin: 'md', align: 'center' }),
      // 先讓人看到「原來這麼簡單」——三個一看就懂的例子（吃飯／喝水／狀況）
      { type: 'box', layout: 'vertical', backgroundColor: C.tint, cornerRadius: '10px', paddingAll: '12px', margin: 'lg', spacing: 'xs',
        contents: [
          text('之後想記，直接打：', { size: 'xs', color: C.muted, wrap: true }),
          text('乾乾5　·　喝水30　·　嘔吐 白沫', { size: 'sm', weight: 'bold', color: C.brand, wrap: true })
        ] },
      // 唯一要先做的一步＝告訴我貓咪名字（不是「3 個小問題」）
      { type: 'box', layout: 'horizontal', margin: 'lg', contents: [menuCell('幫貓貓取名開始', '打個名字就能用了', '幫貓貓建檔', true)] },
      { type: 'box', layout: 'horizontal', margin: 'md', contents: [menuCell('先看看怎麼用', '更多可以怎麼說', '安心上手')] }
    ]
  };
  return bubble(`歡迎加入${BRAND.name}！先幫貓貓取個名字就能開始記`, { type: 'bubble', size: 'mega', header: header('歡迎加入'), body });
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
      text('不用學格式，照平常說就好；點一句就記給你看', { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      line('主食3', '吃飯（不用寫「克」）'),
      line('喝水30', '記喝水 30 ml'),
      line('嘔吐 白沫', '記狀況＋描述'),
      line('最近吃什麼', '回頭查吃過什麼'),
      { type: 'separator', margin: 'xl', color: SEPARATOR },
      text('沒吃完可打「乾乾減5」「罐罐剩10」；更多說法打「完整記法」',
        { size: 'xxs', color: C.brand, align: 'center', wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '完整記法', text: '完整記法' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '改用按鈕', text: '按鈕記錄' } }
    ]
  };
  return bubble('怎麼記：主食3、喝水30、嘔吐 白沫、最近吃什麼',
    { type: 'bubble', size: 'mega', header: header('怎麼記？照平常說就好'), body, footer });
}

// ---------- 完整記法教學卡（固定小字、短句不換行） ----------
// 純文字訊息會跟著手機系統字級放大而在半句處斷行（例：「冠關 水↵20」）；
// 改用 Flex 卡把字級鎖小、每句都短到不會折行，指令左、說明右，乾淨好讀。
export function recordTutorialFlex() {
  const rows = [];
  const sec = (title) => {
    rows.push({ type: 'separator', margin: 'xl', color: SEPARATOR });
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

  rows.push(text('不用學格式，照平常說就好；「克」可省略、空格有沒有都行', { size: 'xs', color: C.muted, wrap: true }));

  sec('吃飯（直接說）');
  cmd('主食3');
  cmd('副食5');
  cmd('乾乾10');
  cmd('罐罐20');
  cmd('零食3');
  cmd('希爾斯10', '有建品牌就直接打名字');
  cmd('罐頭 30 加水 10', '另外加水');

  sec('沒吃完・要修正');
  cmd('乾乾減5');
  cmd('罐罐剩10');
  cmd('主食改成20', '改最近一筆');

  sec('喝水');
  cmd('喝水30');

  sec('用藥');
  cmd('藥 早 已吃');
  cmd('藥 心臟藥 晚 已吃', '指定藥名');
  cmd('已吃／未餵／吐掉／拒吃');

  sec('症狀・精神');
  cmd('嘔吐 白沫');
  cmd('大便 偏軟');
  cmd('尿尿');
  cmd('益生菌');
  cmd('精神 活動力差');
  cmd('備註 今天梳毛');

  sec('回頭查');
  cmd('紀錄', '想不起說法就打這個');
  cmd('今天吃多少');
  cmd('最近吃什麼');
  cmd('最近乾糧');
  cmd('之前吃過哪些罐頭');

  sec('家裡自己的說法');
  cmd('肉5', '先讓管家記住肉＝罐頭');
  rows.push(text('第一次打沒設定過的叫法（例如「肉」），管家會先問你那是什麼；記住後下次直接用。也可到管家後台「家裡習慣的叫法」設定。', { size: 'xxs', color: C.muted, wrap: true, margin: 'sm' }));

  sec('補登・指定時間');
  cmd('昨天 21:30 喝水30');
  cmd('14:30 喝水30');

  sec('多隻貓');
  cmd('蚵仔', '打名字＝之後都記牠');
  cmd('冠關 喝水30', '只記一筆給別隻');

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: rows
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '14px', paddingStart: '20px', paddingEnd: '20px', backgroundColor: FOOTER_COLOR,
    contents: [
      text('想更準？到管家後台存「常吃食物」、設「預設食物」，之後只打「乾乾3」「主食5」就自動套用。沒設定也可以先記；沒有品牌實際熱量時，系統會先用粗估值並標示。',
        { size: 'xxs', color: C.brand, wrap: true })
    ]
  };
  return bubble('完整記法：主食3、乾乾10、乾乾減5、罐罐剩10、最近吃什麼、之前吃過哪些罐頭',
    { type: 'bubble', size: 'mega', header: header('完整記法・照平常說就好'), body, footer });
}

// 如何記錄：左右滑動的分類卡，三類用不同色系明確區隔（常用／進階記法／進階功能）
export function quickRecordCarousel(opts = {}) {
  // 三種色系主題：綠（常用）→ 琥珀（進階記法）→ 深棕（進階功能）
  const THEME = {
    common: { grad: { type: 'linearGradient', angle: '135deg', startColor: '#8A5A2C', endColor: '#6A4119' }, pillBg: '#F3E7D6', pillFg: '#7A4E20', body: '#FBF7F0', chipBg: '#F3E7D6', chipFg: '#7A4E20', border: '#E9DAC4' },
    skill:  { grad: { type: 'linearGradient', angle: '135deg', startColor: '#C0863E', endColor: '#9A6526' }, pillBg: '#F7EAD6', pillFg: '#8A5E1E', body: '#FDF9F2', chipBg: '#F6EAD7', chipFg: '#8A5E1E', border: '#EAD9BE' },
    feature:{ grad: { type: 'linearGradient', angle: '135deg', startColor: '#5A3A22', endColor: '#3A2416' }, pillBg: '#EDE3D6', pillFg: '#5A3617', body: '#FBF7F2', chipBg: '#EDE3D6', chipFg: '#5A3617', border: '#E4D6C6' }
  };
  // 大色塊分類標頭：左邊序號圓、右邊分類名＋副標
  const catHeader = (grad, num, title, sub) => ({
    type: 'box', layout: 'horizontal', background: grad, paddingAll: '16px', paddingStart: '18px', spacing: 'md', alignItems: 'center',
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, width: '34px', height: '34px', backgroundColor: '#FFFFFF', cornerRadius: '999px', justifyContent: 'center',
        contents: [text(num, { size: 'lg', weight: 'bold', color: '#3A2416', align: 'center' })] },
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        text(title, { size: 'lg', weight: 'bold', color: '#FFFFFF' }),
        text(sub, { size: 'xxs', color: '#FFFFFFCC', margin: 'xs', wrap: true })
      ] }
    ]
  });
  // 範例列：點了把字「帶進輸入框」讓使用者改好再送（fillInText），不會直接記錄假資料
  const line = (t, cmd, desc, fillText) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'md', margin: 'md', paddingAll: '10px',
    backgroundColor: '#FFFFFF', cornerRadius: '12px', borderColor: t.border, borderWidth: '1px',
    action: { type: 'postback', label: cmd.slice(0, 20), data: 'action=fill', inputOption: 'openKeyboard', fillInText: fillText || cmd },
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, backgroundColor: t.chipBg, cornerRadius: '8px',
        paddingAll: '7px', paddingStart: '12px', paddingEnd: '12px',
        contents: [text(cmd, { size: 'sm', weight: 'bold', color: t.chipFg, wrap: false })] },
      text(desc, { size: 'xs', color: C.muted, flex: 1, gravity: 'center', wrap: true }),
      text('›', { size: 'lg', color: '#D8CDBA', flex: 0, gravity: 'center' })
    ]
  });

  const t1 = THEME.common;
  const bubble1 = {
    type: 'bubble', size: 'mega', header: catHeader(t1.grad, '1', '常用', '每天這樣打就好'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t1.body, contents: [
      text('不用學格式，照平常說就好。點一句會帶進輸入框，改好再送出', { size: 'xxs', color: C.muted, wrap: true }),
      line(t1, '主食3', '吃飯（不用寫「克」）'),
      line(t1, '乾乾10', '吃乾糧'),
      line(t1, '喝水30', '喝水'),
      line(t1, '嘔吐 白沫', '狀況＋描述'),
      line(t1, '乾乾減5', '沒吃完／要修正'),
      line(t1, '最近吃什麼', '回頭查'),
      text('症狀多寫幾個字，會自動整理進回顧的「給醫生的注意事項」', { size: 'xxs', color: C.muted, wrap: true, margin: 'md' })
    ] }
  };
  const t2 = THEME.skill;
  const bubble2 = {
    type: 'bubble', size: 'mega', header: catHeader(t2.grad, '2', '進階記法', '品牌・加水・補登・換貓'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t2.body, contents: [
      text('需要時再用，記得更完整', { size: 'xxs', color: C.muted, wrap: true }),
      line(t2, '希爾斯10', '有建品牌就直接打名字'),
      line(t2, '罐罐剩10', '沒吃完剩多少'),
      line(t2, '昨天 21:30 喝水30', '補登・指定時間'),
      line(t2, opts.petName || '貓貓名字', '換一隻貓記（打名字）', opts.petName || ''),
      text('常吃固定一款？到管家後台設成「預設食物」，之後只打「乾乾3」就自動套用；沒設定也能先記，沒有品牌實際熱量時系統會標示粗估。', { size: 'xxs', color: C.muted, wrap: true, margin: 'md' })
    ] },
    footer: { type: 'box', layout: 'horizontal', paddingAll: '10px', backgroundColor: FOOTER_COLOR, contents: [
      { type: 'button', height: 'sm', style: 'primary', color: t2.grad.endColor,
        action: { type: 'message', label: '完整記法', text: '完整記法' } }
    ] }
  };
  const t3 = THEME.feature;
  const featBtn = (label, sendText) => ({
    type: 'button', height: 'sm', style: 'primary', color: t3.grad.endColor, margin: 'md',
    action: { type: 'message', label: label.slice(0, 20), text: sendText }
  });
  const bubble3 = {
    type: 'bubble', size: 'mega', header: catHeader(t3.grad, '3', '進階功能', '管家後台・多人照護'),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: t3.body, contents: [
      text('開網站看整理、找人一起照護', { size: 'xxs', color: C.muted, wrap: true }),
      // 有 LIFF 連結就直接開（免登入、少跳一則回覆）；沒有才退回文字指令
      opts.siteUrl
        ? { type: 'button', height: 'sm', style: 'primary', color: t3.grad.endColor, margin: 'md',
            action: { type: 'uri', label: '🐾 開啟管家後台（免登入）', uri: opts.siteUrl } }
        : featBtn('🐾 開啟管家後台', '照護站'),
      featBtn('🤝 邀請一起照護（多人）', '邀請'),
      featBtn('💻 用電腦登入', '電腦登入')
    ] }
  };
  return bubble('怎麼記：① 直接說（主食3・喝水30・嘔吐 白沫・最近吃什麼）② 進階（品牌・剩多少・補登・換貓）③ 管家後台・多人照護',
    { type: 'carousel', contents: [bubble1, bubble2, bubble3] });
}

export function menuFlex() {
  const row = (cells) => ({ type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md', contents: cells });
  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      text(BRAND.tagline, { size: 'xs', color: C.muted, align: 'center', wrap: true }),
      row([menuCell(BRAND.onboarding, '第一次使用看這裡', '安心上手')]),
      row([menuCell('怎麼記？看範例', '點一句就記', '怎麼記'), menuCell('如何記餵藥', '藥的記法', '如何記餵藥')]),
      row([menuCell('今日記錄', '今天記了什麼', '今天'), menuCell('給醫生看', '近 7 天整理', '給醫生看')]),
      row([menuCell('開啟管家後台', '回診・血檢・設定', '照護站', true)])
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
      { type: 'separator', margin: 'xl', color: SEPARATOR },
      text('熟了就直接打字更快：主食3・喝水30・嘔吐 白沫', { size: 'xxs', color: C.brand, align: 'center', wrap: true, margin: 'lg' }),
      text('補登昨天：昨天 21:30 喝水30', { size: 'xxs', color: C.muted, align: 'center', margin: 'sm' })
    ]
  };
  return bubble(headerTitle, { type: 'bubble', size: 'mega', header: header(headerTitle), body });
}

// ---------- 近 7 天迷你圖卡（長條＝水分） ----------
export function weekFlex(petName, rows, trendUrl = '') {
  // 兩條長條並列（每日）：水分＋熱量。用溫和大地色（柔沙綠／暖陶土），與暖棕品牌一致、親切不冰冷。
  // 各自對自己 7 天內的高峰做比例，讓「哪天多／哪天少」一眼可讀（不是把兩種單位混在同一軸）。
  const cWater = '#7C9070'; // 柔沙綠（大地色・水分）
  const cKcal = '#C08E5E';  // 暖陶土（大地色・熱量）
  const maxWater = Math.max(1, ...rows.map((row) => Number(row.totalWaterMl) || 0));
  const maxKcal = Math.max(1, ...rows.map((row) => Number(row.kcal) || 0));
  const recorded = rows.filter((row) => row.entryCount > 0);
  const avg = (selector) => (recorded.length
    ? recorded.reduce((total, row) => total + (Number(selector(row)) || 0), 0) / recorded.length
    : 0);

  // 單一長條（軌道＋填色），pct=0 時留空軌道
  const bar = (pct, color) => ({
    type: 'box', layout: 'vertical', backgroundColor: '#EFEBE0', cornerRadius: '3px', height: '7px',
    contents: pct > 0
      ? [{ type: 'box', layout: 'vertical', backgroundColor: color, cornerRadius: '3px', height: '7px', width: `${pct}%`, contents: [{ type: 'filler' }] }]
      : [{ type: 'filler' }]
  });

  const dayRows = rows.map((row) => {
    const day = `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`;
    const warn = row.vomitCount > 0 || row.medIssueCount > 0;
    const has = row.entryCount > 0;
    const water = Number(row.totalWaterMl) || 0;
    const kcal = Number(row.kcal) || 0;
    const pw = has ? Math.max(3, Math.round((water / maxWater) * 100)) : 0;
    const pk = has ? Math.max(3, Math.round((kcal / maxKcal) * 100)) : 0;
    return {
      type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
      contents: [
        text(`${day}${warn ? ' ⚠' : ''}`, { size: 'xxs', color: warn ? C.seal : C.muted, flex: 3, gravity: 'center' }),
        { type: 'box', layout: 'vertical', flex: 8, spacing: 'xs', contents: [bar(pw, cWater), bar(pk, cKcal)] },
        { type: 'box', layout: 'vertical', flex: 5, contents: [
          text(has ? fmt(water) : '—', { size: 'xxs', color: cWater, align: 'end', gravity: 'center' }),
          text(has ? fmt(kcal) : '—', { size: 'xxs', color: cKcal, align: 'end', gravity: 'center' })
        ] }
      ]
    };
  });

  // 圖例：色塊＋名稱（水分／熱量），置中
  const legendDot = (color) => ({ type: 'box', layout: 'vertical', width: '11px', height: '11px', cornerRadius: '2px', backgroundColor: color, contents: [{ type: 'filler' }] });
  const legend = {
    type: 'box', layout: 'horizontal', spacing: 'sm', justifyContent: 'center', alignItems: 'center',
    contents: [
      legendDot(cWater), text('水分 ml', { size: 'xxs', color: C.muted, flex: 0, gravity: 'center' }),
      { ...legendDot(cKcal), margin: 'md' }, text('熱量 kcal', { size: 'xxs', color: C.muted, flex: 0, gravity: 'center' })
    ]
  };

  const body = {
    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG,
    contents: [
      legend,
      ...dayRows,
      { type: 'separator', margin: 'xl', color: SEPARATOR },
      statCellRow([
        statCell('日均水分', fmt(avg((row) => row.totalWaterMl)), 'ml', cWater),
        statCell('日均熱量', `${fmt(avg((row) => row.kcal))}${rows.some((r) => r.kcalIncomplete) ? '+' : ''}`, kcalUnit(rows.some((r) => r.kcalEstimated), rows.some((r) => r.kcalIncomplete)), cKcal)
      ])
    ]
  };
  const footer = {
    type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      // 有 trend 連結就一鍵直接開後台「體重・水分・熱量折線圖」那頁；沒有才退回文字指令
      trendUrl
        ? { type: 'button', height: 'sm', style: 'primary', color: C.brand,
            action: { type: 'uri', label: '看體重・水分・熱量折線圖', uri: trendUrl } }
        : { type: 'button', height: 'sm', style: 'primary', color: C.brand,
            action: { type: 'message', label: '開啟管家後台看完整趨勢', text: '照護站' } }
    ]
  };
  return bubble(
    `近 7 天（${petName}）日均水分 ${fmt(avg((row) => row.totalWaterMl))} ml、日均熱量 ${fmt(avg((row) => row.kcal))} kcal`,
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
    contents: [weekHeader, ...weeks, { type: 'separator', margin: 'lg', color: SEPARATOR }, legend]
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
      action: { type: 'uri', label: '看完整月曆（去管家後台）', uri: calendarUrl }
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
      contents.push({ type: 'separator', margin: 'sm', color: SEPARATOR });
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
        action: { type: 'message', label: '開啟管家後台看全部', text: '照護站' } }
    ]
  };
  return bubble(
    `最近紀錄（${petName}）${items.length} 筆`,
    { type: 'bubble', size: 'mega', header: header(`最近紀錄・${petName}`), body, footer }
  );
}

// ---------- 照護提醒卡 ----------
export function reminderFlex(pet, lines, title) {
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
      { type: 'separator', margin: 'lg', color: SEPARATOR },
      text('如果忘了記可以補記；有不放心的狀況請諮詢獸醫師。',
        { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
    ]
  };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'message', label: '看今日記錄', text: '看今日記錄' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(
    title || `照護提醒（${pet.petName}）${lines.length} 項`,
    { type: 'bubble', size: 'mega', header: header(title || `照護提醒・${pet.petName}`), body, footer }
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
    { type: 'separator', margin: 'lg', color: SEPARATOR },
    text('回診前可先看「給醫生看」，或到管家後台的「回診」頁一鍵複製給醫生',
      { size: 'xs', color: C.muted, wrap: true, margin: 'lg' })
  );
  const body = { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: BODY_BG, contents };
  const footer = {
    type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', backgroundColor: FOOTER_COLOR,
    contents: [
      { type: 'button', height: 'sm', style: 'link', color: C.brand,
        action: { type: 'message', label: '給醫生看', text: '給醫生看' } },
      { type: 'button', height: 'sm', style: 'primary', color: C.brand,
        action: { type: 'message', label: '開啟管家後台', text: '照護站' } }
    ]
  };
  return bubble(
    `回診提醒：明天 ${dateLabel}`,
    { type: 'bubble', size: 'mega', header: header(`回診提醒・${pet.petName}`), body, footer }
  );
}
