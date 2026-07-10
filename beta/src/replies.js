// LINE 回覆文字格式（貓貓照護管家 Beta）
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
    lines.push('藥 尚無紀錄');
  } else {
    for (const med of meds) {
      const label = [med.slot, med.name].filter(Boolean).join(' ');
      lines.push(`藥 ${label ? `${label} ` : ''}${med.status}`);
    }
  }

  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount}`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount}`);
  if (gutParts.length) lines.push(gutParts.join('・'));

  if (summary.vomitNotes?.length) lines.push(`嘔吐：${summary.vomitNotes.join('；')}`);
  if (summary.stoolNotes?.length) lines.push(`便便：${summary.stoolNotes.join('；')}`);
  if (summary.moodNotes?.length) lines.push(`精神：${summary.moodNotes.join('；')}`);

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
  '慢慢來，今天還有時間，{name}有你照顧很安心 🐾',
  '記下來就不會漏，你做得很好',
  '一步一步來，{name}的健康有你把關',
  '別擔心，照這個節奏就對了 🐾'
];

const ENCOURAGE_DONE = [
  '今日目標全部達成！{name}有你真幸福 🐾',
  '太棒了，今天的照顧滿分！',
  '全部完成～給自己一個讚，也給{name}一個摸摸 🐾',
  '目標達成！安心睡個好覺吧 🐾'
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
  if (missingSlots.length) gaps.push(`${missingSlots.join('、')}的藥還沒餵`);

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
    return `📅 ${shortDate(date)}（${petName}）\n今天還沒有任何紀錄。\n輸入「水 20」開始記錄。`;
  }
  const lines = [`📅 ${shortDate(date)}（${petName}）${summary.entryCount} 筆`, summaryBlock(summary)];
  const goals = goalSection(pet, summary, date);
  if (goals) lines.push('', goals);
  return lines.join('\n');
}

export function weekReply(petName, rows) {
  const lines = [`📈 近 7 天（${petName}）`];
  for (const row of rows) {
    const day = `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`;
    if (!row.entryCount) {
      lines.push(`${day} —`);
      continue;
    }
    const parts = [`水${formatNumber(row.totalWaterMl)}`, `熱${formatNumber(row.kcal)}`, `藥${row.medTakenCount}`];
    if (row.vomitCount > 0) parts.push(`吐${row.vomitCount}`);
    if (row.medIssueCount > 0) parts.push(`藥⚠${row.medIssueCount}`);
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

  const lines = [`🗓️ ${monthLabel}（${petName}）`];
  lines.push(`有紀錄 ${recorded.length} 天`);
  if (noRecordDays > 0) lines.push(`無紀錄 ${noRecordDays} 天`);
  if (recorded.length) {
    lines.push(`日均水分 ${formatNumber(avg((row) => row.totalWaterMl))} ml`);
    lines.push(`日均熱量 ${formatNumber(avg((row) => row.kcal))} kcal`);
  }
  if (vomitDays.length) lines.push(`嘔吐日：${vomitDays.map(Number).join('、')} 號`);
  if (medIssueDays.length) lines.push(`藥異常日：${medIssueDays.map(Number).join('、')} 號`);
  if (!vomitDays.length && !medIssueDays.length) lines.push('沒有嘔吐或用藥異常');
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
    '🔗 照護站登入連結：',
    url,
    '',
    '有使用就會自動延長效期，',
    '超過 30 天沒開才會過期，',
    '過期再輸入「網站」即可。',
    '',
    '連結請勿轉傳給別人。'
  ].join('\n');
}

export function helpText() {
  return [
    '📖 使用說明',
    '',
    '【記錄】直接打字',
    '水 20',
    '乾糧 希爾斯 4g',
    '罐頭 皇家 30g',
    '藥 早 已吃',
    '吐 白色泡沫',
    '便 成形偏軟',
    '精神 活動力差',
    '備註 今天有梳毛',
    '',
    '藥的狀態有四種：',
    '已吃、漏餵、吐掉、拒吃',
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
    '歡迎使用貓貓照護管家 🐾',
    '',
    '第一步：',
    '新增貓咪 名字',
    '',
    '之後這樣記錄：',
    '水 20',
    '乾糧 品牌 4g',
    '藥 早 已吃',
    '',
    '輸入「今天」看總結，',
    '「網站」開照護站，',
    '「說明」看完整指令。'
  ].join('\n');
}

export function unknownReply() {
  return [
    '看不懂這則訊息 🙏',
    '記錄範例：',
    '水 20',
    '乾糧 希爾斯 4g',
    '藥 早 已吃',
    '輸入「說明」看完整指令'
  ].join('\n');
}

export function invalidReply(reason, category) {
  if (reason === 'missing_amount' && category === 'water') return '請加上數量（ml），例如：\n水 20';
  if (reason === 'missing_amount' && category === 'food') return '請加上克數，例如：\n乾糧 希爾斯 4g\n罐頭 皇家 30g';
  if (reason === 'missing_note') return '備註後面要加內容，例如：\n備註 今天有梳毛';
  return unknownReply();
}

// ---------- 教學（說明選單卡的子頁） ----------

export function recordTutorial() {
  return [
    '📝 如何記錄',
    '',
    '直接打字就會記：',
    '水 20',
    '乾糧 希爾斯 4g',
    '罐頭 皇家 30g',
    '吐 白色泡沫',
    '便 成形偏軟',
    '精神 活動力差',
    '備註 今天有梳毛',
    '',
    '補記昨天的：',
    '昨天 21:30 水 20',
    '',
    '記錯了？',
    '改 54 ＝改上一筆數量',
    '剩 20 ＝沒吃完扣掉',
    '刪除 ＝刪掉上一筆',
    '',
    '小訣竅：到照護站',
    '「設定 → 食物」建公式，',
    '之後會自動算熱量水分。'
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
    '狀態有四種：',
    '已吃、漏餵、吐掉、拒吃',
    '',
    '有設「每日目標」的話，',
    '要寫時段才算完成，',
    '例如：藥 早 已吃',
    '',
    '漏餵也記下來，',
    '月曆會幫你標記 ⚠'
  ].join('\n');
}
