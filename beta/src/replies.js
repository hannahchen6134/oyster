import { BRAND, displayMedStatus, displayMedSlot } from './brand.js';
// LINE 回覆文字格式（喵喵照護安心管家）
// 排版原則：每行盡量不超過 12 個全形字，大字體手機也不折行；
// 日期用「7月10日」格式，避免被 LINE 自動轉成日期連結。

function formatNumber(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

// YYYY-MM-DD → 7月10日
export function shortDate(date) {
  const value = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

export function summaryBlock(summary) {
  const lines = [];
  lines.push(`水分 ${formatNumber(summary.totalWaterMl)} ml`);

  const totalFood = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  lines.push(`食物 ${formatNumber(totalFood)} g`);
  lines.push(`熱量 ${formatNumber(summary.kcal)} kcal`);

  const meds = summary.meds || [];
  if (!meds.length) {
    lines.push('💊 藥　尚無紀錄');
  } else {
    for (const med of meds) {
      const label = [med.slot, med.name].filter(Boolean).join(' ');
      const mark = med.status === '已吃' ? '✓' : `⚠ ${displayMedStatus(med.status)}`;
      lines.push(`💊 ${label ? `${label} ` : ''}${mark}`);
    }
  }

  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount}`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount}`);
  if (gutParts.length) lines.push(`🩺 ${gutParts.join('・')}`);

  const careParts = [];
  if (summary.vaccineCount > 0) careParts.push('疫苗');
  if (summary.dewormCount > 0) careParts.push('除蟲');
  if (careParts.length) lines.push(`💉 ${careParts.join('・')}`);

  if (summary.vomitNotes?.length) lines.push(`嘔吐：${summary.vomitNotes.join('；')}`);
  if (summary.stoolNotes?.length) lines.push(`便便：${summary.stoolNotes.join('；')}`);
  if (summary.moodNotes?.length) lines.push(`精神：${summary.moodNotes.join('；')}`);

  return lines.join('\n');
}

// 單筆記錄的輕量回覆：一行確認＋最相關的當日累積（不再每筆都跳大卡）
// 完整狀態改由「今日記錄」卡呈現，避免聊天室被洗版。
export function lightRecordReply(description, category, summary, isToday = true) {
  const day = isToday ? '今日' : '當日';
  const lines = [`✓ 已記　${description}`];
  if (category === 'water') {
    lines.push(`${day}水分 ${formatNumber(summary.totalWaterMl)} ml`);
  } else if (category === 'food') {
    lines.push(`${day}熱量 ${formatNumber(summary.kcal)} kcal・水分 ${formatNumber(summary.totalWaterMl)} ml`);
  }
  // 藥／嘔吐／便便等：只確認，不附累積（想看整體點「今日記錄」）
  return lines.join('\n');
}

// ---------- 每日目標 ----------

function parseGoalSlots(pet) {
  try {
    const slots = JSON.parse(pet?.goalMedSlots || '[]');
    return Array.isArray(slots) ? slots.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

const ENCOURAGE_PROGRESS = [
  '感謝有你細心紀錄，守護貓貓健康'
];

const ENCOURAGE_DONE = [
  '感謝有你細心紀錄，守護貓貓健康'
];

function pickLine(pool, seed, name) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return pool[hash % pool.length].replace('{name}', name);
}

// 有設定目標才出現：列出還差多少，最後給一句鼓勵
export function goalSection(pet, summary, date) {
  if (!pet) return '';
  const goalWater = Number(pet.goalWaterMl) || 0;
  const goalKcal = Number(pet.goalKcal) || 0;
  const slots = parseGoalSlots(pet);
  if (!goalWater && !goalKcal && !slots.length) return '';

  const gaps = [];
  if (goalWater > 0) {
    const remain = Math.round((goalWater - (Number(summary.totalWaterMl) || 0)) * 10) / 10;
    if (remain > 0) gaps.push(`水分還差 ${formatNumber(remain)} ml`);
  }
  if (goalKcal > 0) {
    const remain = Math.round((goalKcal - (Number(summary.kcal) || 0)) * 10) / 10;
    if (remain > 0) gaps.push(`熱量還差 ${formatNumber(remain)} kcal`);
  }
  const doneSlots = new Set(
    (summary.meds || []).filter((med) => med.status === '已吃').map((med) => med.slot).filter(Boolean)
  );
  const missingSlots = slots.filter((slot) => !doneSlots.has(slot));
  if (missingSlots.length) gaps.push(`${missingSlots.map(displayMedSlot).join('、')}的藥還沒餵`);

  const lines = ['── 今日目標 ──'];
  if (gaps.length) {
    lines.push(...gaps);
    lines.push('', pickLine(ENCOURAGE_PROGRESS, `${date}${pet.petName}`, pet.petName));
  } else {
    lines.push(pickLine(ENCOURAGE_DONE, `${date}${pet.petName}`, pet.petName));
  }
  return lines.join('\n');
}

export function recordReply(description, pet, summary, hints = [], date = '') {
  const petName = pet?.petName || '貓貓';
  const lines = [`✅ 已記錄（${petName}）`, description, '', '── 今日累積 ──', summaryBlock(summary)];
  const goals = goalSection(pet, summary, date);
  if (goals) lines.push('', goals);
  for (const hint of hints) {
    if (hint) lines.push('', `※ ${hint}`);
  }
  return lines.join('\n');
}

export function todayReply(pet, date, summary) {
  const petName = pet?.petName || '貓貓';
  if (!summary.entryCount) {
    return `${shortDate(date)}（${petName}）\n今天還沒有任何紀錄。\n輸入「水 20」開始記錄。`;
  }
  const lines = [`${shortDate(date)}（${petName}）${summary.entryCount} 筆`, summaryBlock(summary)];
  const goals = goalSection(pet, summary, date);
  if (goals) lines.push('', goals);
  return lines.join('\n');
}

export function weekReply(petName, rows) {
  const lines = [`近 7 天（${petName}）`];
  for (const row of rows) {
    const day = `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`;
    if (!row.entryCount) {
      lines.push(`${day} —`);
      continue;
    }
    const parts = [`水${formatNumber(row.totalWaterMl)}`, `熱${formatNumber(row.kcal)}`, `藥${row.medTakenCount}`];
    if (row.vomitCount > 0) parts.push(`吐${row.vomitCount}`);
    if (row.medIssueCount > 0) parts.push(`藥留意${row.medIssueCount}`);
    lines.push(`${day} ${parts.join('・')}`);
  }
  lines.push('', '※ 詳細請開照護站（輸入「網站」）');
  return lines.join('\n');
}

export function monthReply(petName, monthLabel, rows) {
  const recorded = rows.filter((row) => row.entryCount > 0);
  const vomitDays = rows.filter((row) => row.vomitCount > 0).map((row) => row.date.slice(8));
  const medIssueDays = rows.filter((row) => row.medIssueCount > 0).map((row) => row.date.slice(8));
  const noRecordDays = rows.length - recorded.length;

  const avg = (selector) => {
    if (!recorded.length) return 0;
    return recorded.reduce((total, row) => total + (Number(selector(row)) || 0), 0) / recorded.length;
  };

  const lines = [`️ ${monthLabel}（${petName}）`];
  lines.push(`有紀錄 ${recorded.length} 天`);
  if (noRecordDays > 0) lines.push(`無紀錄 ${noRecordDays} 天`);
  if (recorded.length) {
    lines.push(`日均水分 ${formatNumber(avg((row) => row.totalWaterMl))} ml`);
    lines.push(`日均熱量 ${formatNumber(avg((row) => row.kcal))} kcal`);
  }
  if (vomitDays.length) lines.push(`嘔吐日：${vomitDays.map(Number).join('、')} 號`);
  if (medIssueDays.length) lines.push(`用藥留意日：${medIssueDays.map(Number).join('、')} 號`);
  if (!vomitDays.length && !medIssueDays.length) lines.push('這個月的紀錄都很平穩');
  lines.push('', '※ 月曆圖請開照護站');
  return lines.join('\n');
}

export function visitReply(petName, visits, vetsById) {
  if (!visits.length) {
    return `${petName} 沒有排定的回診。\n可在照護站「設定 → 回診資料」新增。`;
  }
  const lines = [`🏥 回診資訊（${petName}）`];
  for (const visit of visits) {
    const vet = vetsById[visit.vetId];
    const where = vet ? [vet.hospitalName, vet.doctorName].filter(Boolean).join('・') : '';
    const time = visit.visitTime ? ` ${visit.visitTime}` : '';
    if (visit.nextVisitDate) lines.push(`下次 ${shortDate(visit.nextVisitDate)}${time}`);
    else if (visit.visitDate) lines.push(`看診 ${shortDate(visit.visitDate)}${time}`);
    if (where) lines.push(`　${where}`);
    if (visit.reason) lines.push(`　原因：${visit.reason}`);
    if (visit.doctorInstruction) lines.push(`　醫囑：${visit.doctorInstruction}`);
  }
  return lines.join('\n');
}

export function websiteReply(url) {
  return [
    '你的專屬照護站連結：',
    url,
    '',
    '這是你的專屬連結，',
    '請不要轉傳給不相關的人。',
    '',
    '若連結過期，輸入「照護站」',
    '就能取得新連結，',
    '既有資料不會消失。'
  ].join('\n');
}

export function helpText() {
  return [
    '使用說明',
    BRAND.tagline,
    '',
    '【記錄】直接打字',
    '水 20',
    '乾糧 4g',
    '罐頭 品名 30g',
    '藥 早 已吃',
    '吐 白色泡沫',
    '便 成形偏軟',
    '精神 活動力差',
    '備註 今天有梳毛',
    '',
    '藥的狀態有四種：',
    '已吃、未餵、吐掉、拒吃',
    '',
    '【補登】加日期時間',
    '昨天 21:30 水 20',
    '',
    '【記錯了？】',
    '改 54（改上一筆數量）',
    '剩 20（沒吃完扣掉）',
    '刪除（刪掉上一筆）',
    '',
    '【查詢】',
    '今天・近7天・月曆・回診',
    '',
    '【網站】',
    '輸入「網站」取得登入連結',
    '',
    '【多貓】開頭加名字',
    '蚵仔 水 20',
    '新貓咪：新增貓咪 蚵仔',
    '',
    '※ 僅協助記錄整理，健康問題請諮詢獸醫師'
  ].join('\n');
}

export function welcomeText() {
  return [
    `歡迎加入${BRAND.name}`,
    BRAND.tagline,
    '',
    '每天忙碌又放不下貓貓？',
    '交給我陪你一起記。',
    '記錯能改、想刪能刪，',
    '資料都在，安心記就好。',
    '',
    '第一步：輸入',
    '新增貓咪 蚵仔',
    '（把「蚵仔」換成你家貓的名字）',
    '',
    '之後像聊天一樣記：',
    '水 20',
    '罐頭 30',
    '藥 早 已吃',
    '',
    '輸入「今天」看今日記錄，',
    '「照護站」開網站，',
    '「安心上手」看小教學。',
    '',
    '小提醒：這是照護紀錄輔助工具，',
    '不提供醫療診斷；數字請自行核對，',
    '有狀況請諮詢獸醫師。',
    '',
    '紀錄正常不代表貓咪完全健康，',
    '會吃會喝也可能生病，請定期回診。'
  ].join('\n');
}

export function unknownReply() {
  return [
    '看不懂這則訊息 🙏',
    '記錄範例：',
    '水 20',
    '乾糧 4g',
    '藥 早 已吃',
    '輸入「說明」看完整指令'
  ].join('\n');
}

export function invalidReply(reason, category) {
  if (reason === 'missing_amount' && category === 'water') return '請加上數量（ml），例如：\n水 20';
  if (reason === 'missing_amount' && category === 'food') return '請加上克數，例如：\n乾糧 4g\n罐頭 品名 30g';
  if (reason === 'missing_note') return '備註後面要加內容，例如：\n備註 今天有梳毛';
  return unknownReply();
}

// ---------- 教學（說明選單卡的子頁） ----------

export function recordTutorial() {
  return [
    '📝 完整記法（照著打就會記）',
    '',
    '── 喝水 ──',
    '水 60',
    '',
    '── 吃飯（可帶品牌）──',
    '乾糧 4',
    '罐頭 30',
    '罐頭 皇家 30 ← 帶品牌',
    '乾糧 希爾斯 20',
    '罐頭另外加水：罐頭 30 加水 10',
    '',
    '── 用藥 ──',
    '藥 早 已吃',
    '藥 心臟藥 晚 已吃',
    '狀態：已吃／未餵／吐掉／拒吃',
    '',
    '── 其他 ──',
    '吐 白色泡沫',
    '大便 成形偏軟',
    '尿尿',
    '營養補充 益生菌',
    '精神 活動力差',
    '備註 今天有梳毛',
    '',
    '── 一次記多筆 ──',
    '水20 乾糧4 藥早已吃',
    '',
    '── 補登・指定時間 ──',
    '昨天 21:30 水 20',
    '14:30 水 20',
    '',
    '── 多隻貓 ──',
    '打貓咪名字 → 之後都記給牠',
    '例：蚵仔',
    '只記一筆給別隻：冠關 水 20',
    '',
    '── 記錯了 ──',
    '改 54 ＝改上一筆數量',
    '剩 20 ＝沒吃完扣掉',
    '刪除 ＝刪掉上一筆',
    '',
    '💡 先到照護站「設定 → 常吃的食物」',
    '建好品牌與熱量公式，之後打品牌',
    '就會自動算熱量與水分。'
  ].join('\n');
}

export function medTutorial() {
  return [
    '💊 如何記餵藥',
    '',
    '藥 已吃',
    '藥 早 已吃',
    '藥 心臟藥 晚 已吃',
    '',
    '「早／中午／晚」＝餵藥時段，',
    '有分早晚藥時寫上，才知道哪餐餵了。',
    '',
    '狀態有四種：',
    '已吃、未餵、吐掉、拒吃',
    '',
    '有設「每日目標」的話，',
    '要寫時段才算完成，',
    '例如：藥 早 已吃',
    '',
    '未餵也可以記下來，',
    '月曆會幫你標記 ⚠'
  ].join('\n');
}


// ---------- 喵爸媽安心上手 ----------

export function onboardingText() {
  return [
    `${BRAND.onboarding}`,
    '',
    '第一次使用，可以先從',
    '一筆簡單紀錄開始。',
    '',
    '1. 建立貓貓資料',
    '　新增貓咪 蚵仔',
    '2. 記一筆看看',
    '　水 20 或 罐頭 30g',
    '3. 輸入「今天」',
    '　看今日記錄',
    '4. 輸入「給醫生看」',
    '　整理給醫生看',
    '',
    '記錯了能改、想刪能刪，',
    '資料都在不會不見，',
    '安心記就好。',
    '',
    '想看完整記法，',
    '輸入「怎麼記」。'
  ].join('\n');
}

// 快速紀錄選單按下後的小提示
export function recordPrompt(kind) {
  const prompts = {
    food: '記吃飯，直接輸入：\n罐頭 30g\n乾糧 4g',
    water: '記喝水，直接輸入：\n水 20',
    med: '記用藥，直接輸入：\n藥 早 已吃\n狀態：已吃、未餵、吐掉、拒吃',
    vomit: '記嘔吐，直接輸入：\n吐 白色泡沫',
    stool: '記排便，直接輸入：\n便 成形\n或：軟便',
    mood: '記精神，直接輸入：\n精神 活動力好',
    note: '記備註，直接輸入：\n備註 今天有梳毛'
  };
  return prompts[kind] || '直接打字就能記錄，例如：水 20';
}

export function backfillGuide() {
  return [
    '補登很簡單，',
    '在指令前面加時間：',
    '',
    '昨天 21:30 水 20',
    '前天 乾糧 4g',
    '',
    '要修改已記的紀錄，',
    '可輸入：',
    '改 54（改上一筆數量）',
    '剩 20（沒吃完扣掉）',
    '刪除（刪上一筆）',
    '或開照護站直接編輯。'
  ].join('\n');
}
