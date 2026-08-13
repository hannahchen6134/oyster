// 貓貓照護管家 Beta — 每日總結計算（純函式，可單元測試）
//
// computeDailySummary(logs) 輸入某貓咪某一天的 logs（未刪除），輸出 daily_summary 欄位
// 與回覆文字需要的補充資訊（各類備註清單）。

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// 罐頭/濕食預設 80% 水分、20% 固形；各品項可在「設定 → 常吃的食物」調整水分比例。
// 熱量一律用登記的原始克數計算（不用固形量）。
export const DEFAULT_WET_WATER_RATIO = 0.8;

// ---------- 食物類型：單一真相來源 ----------
// 新增/調整食物類型「只改這一段」，摘要計算、估算、含水、UI 都從這裡衍生，
// 從結構上杜絕「加了新類型卻漏改某一處」的低級錯誤。（網站 index.html 另有平行常數，
// 由 test/parity.test.mjs 自動比對，兩邊不一致就測試變紅。）
export const FOOD_TYPES = ['乾糧', '罐頭', '主食罐', '副食罐', '濕糧', '濕食', '生食', '零食', '其他'];
// 「濕的」食物類型（要扣固形量、預設含水）；生食含水量高，也算補水來源
export const WET_FOOD_TYPES = ['罐頭', '主食罐', '副食罐', '濕食', '濕糧', '生食'];
export const isWetFoodType = (foodType) => WET_FOOD_TYPES.includes(foodType);

// 沒設精確公式時的「類型預設值」——用來估算，畫面一律標「估算」、並提醒可自訂精確值。
// 業界典型密度，也貼近使用者常見品項；使用者在「設定→常吃的食物」填了精確值就會蓋掉。
// 零食/其他刻意不給預設（各家差太多，硬給反而誤導）→ 請使用者自己填。
// 主食罐＝營養完整、肉多熱量高（約 1.0/g）；副食罐＝湯汁多、熱量低（約 0.4/g）；罐頭維持 0.9 不動。
export const TYPE_KCAL_DEFAULT = { '乾糧': 3.7, '罐頭': 0.9, '主食罐': 1.0, '副食罐': 0.4, '濕食': 1.0, '濕糧': 1.0, '生食': 1.5 };
export const TYPE_WATER_DEFAULT = { '乾糧': 0, '罐頭': 0.8, '主食罐': 0.78, '副食罐': 0.82, '濕食': 0.75, '濕糧': 0.75, '生食': 0.7 };
// 「可估算」的類型＝有預設熱量的類型（乾糧/罐頭/濕糧/濕食）
export const ESTIMABLE_FOOD_TYPES = Object.keys(TYPE_KCAL_DEFAULT);
export const isEstimableType = (foodType) => Number(TYPE_KCAL_DEFAULT[foodType]) > 0;

// P0-3：一筆食物 log 的熱量是不是「用類型預設估算」的？
//  - 有品牌自訂每克熱量（food.kcalPerGram>0 或 log.foodKcalPerGram>0）→ 精確，不算估算。
//  - 否則若類型有預設（乾糧/罐頭/主食罐…）→ 這筆熱量是估的。零食/其他沒預設 → 不算（本來就 0 或待補）。
// 不新增 kcalSource 欄位，一律由 foodId＋kcalPerGram 推導。
export function isKcalEstimated(log, food) {
  if (!(toNumber(log?.kcal) > 0)) return false;
  const brandKcal = Number(food?.kcalPerGram) > 0 || Number(log?.foodKcalPerGram) > 0;
  if (brandKcal) return false;
  return isEstimableType(log?.foodType);
}

// 一筆食物 log「熱量無法計算」＝有份量、卻既沒有品牌每克熱量、其類型也沒有安全預設（零食／其他）。
// 這種 log 底層 kcal 會是 0，但語意是「未知、尚未計入」，不能被當成真的 0 kcal——否則當日總熱量
// 會看起來像完整精準值。判斷來源：food log 存在 ＋ 無有效 kcalPerGram ＋ foodType 不在 TYPE_KCAL_DEFAULT。
export function isKcalUnknown(log, food) {
  if (log?.category !== 'food' || log?.isDeleted) return false;
  if (!(toNumber(log?.amount) > 0)) return false;
  const brandKcal = Number(food?.kcalPerGram) > 0 || Number(log?.foodKcalPerGram) > 0;
  if (brandKcal) return false; // 有品牌每克熱量 → 算得出來，不是未知
  return !isEstimableType(log?.foodType); // 類型有安全預設（乾糧/罐頭/主食罐…）→ 可估，不是未知
}

export function deriveFoodFields(grams, foodType, food) {
  const g = toNumber(grams);
  const hasRealKcal = Number(food?.kcalPerGram) > 0;
  const defKcal = TYPE_KCAL_DEFAULT[foodType] || 0;
  const kcalPerG = hasRealKcal ? Number(food.kcalPerGram) : defKcal;
  const isWet = isWetFoodType(foodType);
  const ratioRaw = Number(food?.waterRatio);
  const ratio = ratioRaw > 0 ? ratioRaw : (TYPE_WATER_DEFAULT[foodType] ?? (isWet ? DEFAULT_WET_WATER_RATIO : 0));
  return {
    kcal: round1(g * kcalPerG),
    waterMl: round1(g * ratio),
    // 估算＝這一筆的熱量是用類型預設算的（品項本身還沒設精確每克熱量）
    estimated: !hasRealKcal && defKcal > 0,
    estKcalPerG: !hasRealKcal ? defKcal : 0
  };
}

function timeOf(log) {
  return String(log.eventDateTime || '').slice(11, 16);
}

function noteWithTime(log) {
  const time = timeOf(log) || '未記時間';
  return log.note ? `${time} ${log.note}` : time;
}

export function computeDailySummary(logs) {
  const summary = {
    waterMl: 0,
    foodWaterMl: 0,
    totalWaterMl: 0,
    dryFoodG: 0,
    wetFoodG: 0,
    otherFoodG: 0,
    kcal: 0,
    kcalEstimated: false, // P0-3：當日總熱量是否含「用類型預設估算」的食物筆
    unknownKcalCount: 0,  // 當天有幾筆食物「熱量無法計算」（零食／其他無品牌熱量）→ 尚未計入總熱量
    kcalIncomplete: false, // 有未計入熱量的食物 → 總熱量「不完整」，不可呈現成完整精準值
    meds: [],
    medTakenCount: 0,
    medIssueCount: 0,
    vomitCount: 0,
    stoolCount: 0,
    urineCount: 0,
    supplementCount: 0,
    vaccineCount: 0,
    dewormCount: 0,
    entryCount: 0,
    abnormalFlags: [],
    vomitNotes: [],
    stoolNotes: [],
    urineNotes: [],
    supplementNotes: [],
    moodNotes: [],
    otherNotes: []
  };

  for (const log of logs || []) {
    if (log.isDeleted) continue;
    summary.entryCount += 1;

    switch (log.category) {
      case 'water': {
        summary.waterMl += toNumber(log.waterMl) || toNumber(log.amount);
        break;
      }
      case 'food': {
        const grams = toNumber(log.amount);
        if (log.foodType === '乾糧') summary.dryFoodG += grams;
        else if (isWetFoodType(log.foodType)) {
          // 罐頭/濕食/濕糧只計固形量（原始克數 − 水分）
          summary.wetFoodG += Math.max(0, grams - Math.min(toNumber(log.waterMl), grams));
        }
        else summary.otherFoodG += grams;
        summary.foodWaterMl += toNumber(log.waterMl);
        summary.kcal += toNumber(log.kcal);
        if (isKcalEstimated(log)) summary.kcalEstimated = true; // 這筆用類型預設估 → 當日標「含估算」
        if (isKcalUnknown(log)) summary.unknownKcalCount += 1; // 這筆熱量未知（零食/其他無熱量）→ 尚未計入
        break;
      }
      case 'med': {
        summary.meds.push({
          name: String(log.itemName || ''),
          slot: String(log.medSlot || ''),
          status: String(log.medStatus || ''),
          dose: String(log.doseText || ''),
          form: String(log.medForm || ''),
          beforeMeal: String(log.beforeMeal || ''),
          time: timeOf(log)
        });
        if (log.medStatus === '已吃') summary.medTakenCount += 1;
        else summary.medIssueCount += 1;
        break;
      }
      case 'vomit': {
        summary.vomitCount += 1;
        summary.vomitNotes.push(noteWithTime(log));
        break;
      }
      case 'stool': {
        summary.stoolCount += 1;
        summary.stoolNotes.push(noteWithTime(log));
        break;
      }
      case 'urine': {
        summary.urineCount += 1;
        summary.urineNotes.push(noteWithTime(log));
        break;
      }
      case 'supplement': {
        summary.supplementCount += 1;
        summary.supplementNotes.push(log.note ? `${log.itemName ? log.itemName + ' ' : ''}${log.note}` : (log.itemName || '有紀錄'));
        break;
      }
      case 'vaccine': {
        summary.vaccineCount += 1;
        break;
      }
      case 'deworm': {
        summary.dewormCount += 1;
        break;
      }
      case 'mood': {
        if (log.note) summary.moodNotes.push(noteWithTime(log));
        break;
      }
      default: {
        if (log.note) summary.otherNotes.push(noteWithTime(log));
      }
    }
  }

  summary.waterMl = round1(summary.waterMl);
  summary.foodWaterMl = round1(summary.foodWaterMl);
  summary.totalWaterMl = round1(summary.waterMl + summary.foodWaterMl);
  summary.dryFoodG = round1(summary.dryFoodG);
  summary.wetFoodG = round1(summary.wetFoodG);
  summary.otherFoodG = round1(summary.otherFoodG);
  summary.kcal = round1(summary.kcal);
  summary.kcalIncomplete = summary.unknownKcalCount > 0; // 有未知熱量食物 → 總熱量不完整

  if (summary.vomitCount > 0) summary.abnormalFlags.push('vomit');
  if (summary.medIssueCount > 0) summary.abnormalFlags.push('medIssue');
  if (summary.moodNotes.length > 0) summary.abnormalFlags.push('mood');
  // 照護處置也放進 flags（daily_summary 不用改表就能讓前端顯示膠囊）
  if (summary.vaccineCount > 0) summary.abnormalFlags.push('vaccine');
  if (summary.dewormCount > 0) summary.abnormalFlags.push('deworm');

  return summary;
}

function parseSlots(pet) {
  try {
    const s = JSON.parse(pet?.goalMedSlots || '[]');
    return Array.isArray(s) ? s.filter(Boolean).map(String) : [];
  } catch (error) {
    return [];
  }
}

const SLOT_WORD = { '早': '早上', '中': '中午', '晚': '晚上' };
function slotWord(s) { return SLOT_WORD[s] || String(s || ''); }
function num1(v) { const x = Number(v) || 0; return Number.isInteger(x) ? String(x) : x.toFixed(1); }

// 今日交班：整理成「今日總計＋還沒做＋今日狀況」（不逐筆列），供 LINE 交班卡與文字用。
export function buildHandoff(pet, logs = [], tasks = []) {
  const live = (logs || []).filter((l) => !l.isDeleted);
  const s = computeDailySummary(live);
  const totals = {
    waterMl: s.totalWaterMl,
    foodG: round1((Number(s.dryFoodG) || 0) + (Number(s.wetFoodG) || 0) + (Number(s.otherFoodG) || 0)),
    kcal: s.kcal,
    kcalEstimated: s.kcalEstimated,
    unknownKcalCount: s.unknownKcalCount,
    kcalIncomplete: s.kcalIncomplete
  };

  const slots = parseSlots(pet);
  const doneSlots = new Set(live.filter((l) => l.category === 'med' && l.medStatus === '已吃').map((l) => String(l.medSlot || '')).filter(Boolean));
  const medTotal = slots.length;
  const medDone = slots.filter((x) => doneSlots.has(x)).length;

  const pending = [];
  for (const x of slots) if (!doneSlots.has(x)) pending.push({ title: `${slotWord(x)}的藥` });
  for (const t of tasks || []) if (t.status === 'pending') pending.push({ title: t.title || '待辦', at: (t.scheduledAt && t.scheduledAt.length >= 16) ? t.scheduledAt.slice(11, 16) : '' });

  const status = [];
  for (const n of (s.vomitNotes || [])) status.push(`吐　${n}`);
  if (s.medIssueCount > 0) status.push(`有 ${s.medIssueCount} 筆用藥沒有正常完成`);
  for (const n of (s.moodNotes || [])) status.push(n);

  return { totals, medDone, medTotal, entryCount: s.entryCount, pending, status };
}

// 今日照護看板：把「待辦」「已完成」「異常」三塊，從 tasks ＋ logs ＋ pet(餵藥時段) 收斂出來。
// 純函式（方便測試），前端 /api/today 直接用。輸入的 tasks 由呼叫端決定範圍（通常＝當日）。
export function computeTodayBoard({ pet = {}, tasks = [], logs = [], date = '' } = {}) {
  const summary = computeDailySummary(logs);
  const liveLogs = (logs || []).filter((l) => !l.isDeleted);

  // 今天已「已吃」的餵藥時段（用來把待辦裡已完成的時段扣掉）
  const doneSlots = new Set(
    liveLogs.filter((l) => l.category === 'med' && l.medStatus === '已吃')
      .map((l) => String(l.medSlot || '')).filter(Boolean)
  );

  // 待辦：明確 pending 任務 ＋ 尚未完成的餵藥時段
  const pending = [];
  for (const t of tasks || []) {
    if (t.status === 'pending') {
      pending.push({ kind: 'task', taskId: t.taskId, taskType: t.taskType, title: t.title, scheduledAt: t.scheduledAt });
    }
  }
  for (const slot of parseSlots(pet)) {
    if (!doneSlots.has(slot)) pending.push({ kind: 'medSlot', medSlot: slot, title: `餵藥（${slot}）` });
  }

  // 已完成：完成的任務 ＋ 今天已吃的藥（含誰、幾點）
  const completed = [];
  for (const t of tasks || []) {
    if (t.status === 'completed') {
      completed.push({ kind: 'task', taskId: t.taskId, title: t.title, by: String(t.completedBy || ''), byName: '', at: String(t.completedAt || '').slice(11, 16) });
    }
  }
  for (const l of liveLogs) {
    // 排除「由任務完成而生」的藥事件（避免和上面的任務重複計）
    if (l.category === 'med' && l.medStatus === '已吃' && !l.sourceTaskId) {
      completed.push({ kind: 'med', medSlot: String(l.medSlot || ''), title: `餵藥（${String(l.medSlot || '')}）`, by: String(l.recordedBy || ''), byName: String(l.caregiverName || ''), at: timeOf(l) });
    }
  }

  // 異常：重用每日總結的旗標（不做醫療判斷，只呈現）
  const abnormal = [];
  if (summary.vomitCount > 0) abnormal.push({ type: 'vomit', count: summary.vomitCount, notes: summary.vomitNotes });
  if (summary.medIssueCount > 0) abnormal.push({ type: 'medIssue', count: summary.medIssueCount });
  if (summary.moodNotes.length > 0) abnormal.push({ type: 'mood', notes: summary.moodNotes });

  return { date, pending, completed, abnormal, summary };
}
