// LINE 回覆文字格式（貓貓照護管家 Beta）

function formatNumber(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatMedLine(meds) {
  if (!meds.length) return '用藥　尚無紀錄';
  const parts = meds.map((med) => {
    const label = [med.slot, med.name].filter(Boolean).join(' ');
    return `${label ? `${label} ` : ''}${med.status}`;
  });
  return `用藥　${parts.join('、')}`;
}

export function summaryBlock(summary) {
  const lines = [];
  lines.push(`水分　${formatNumber(summary.totalWaterMl)} ml（喝水 ${formatNumber(summary.waterMl)}＋食物 ${formatNumber(summary.foodWaterMl)}）`);

  const totalFood = (Number(summary.dryFoodG) || 0) + (Number(summary.wetFoodG) || 0) + (Number(summary.otherFoodG) || 0);
  const foodParts = [`乾 ${formatNumber(summary.dryFoodG)}`, `濕/罐 ${formatNumber(summary.wetFoodG)}`];
  if (Number(summary.otherFoodG) > 0) foodParts.push(`其他 ${formatNumber(summary.otherFoodG)}`);
  lines.push(`食物　${formatNumber(totalFood)} g（${foodParts.join('／')}）`);
  lines.push(`熱量　${formatNumber(summary.kcal)} kcal`);
  lines.push(formatMedLine(summary.meds || []));

  const gutParts = [];
  if (summary.vomitCount > 0) gutParts.push(`嘔吐 ${summary.vomitCount} 次`);
  if (summary.stoolCount > 0) gutParts.push(`便便 ${summary.stoolCount} 次`);
  if (gutParts.length) lines.push(gutParts.join('・'));

  if (summary.vomitNotes?.length) lines.push(`　嘔吐：${summary.vomitNotes.join('；')}`);
  if (summary.stoolNotes?.length) lines.push(`　便便：${summary.stoolNotes.join('；')}`);
  if (summary.moodNotes?.length) lines.push(`　精神：${summary.moodNotes.join('；')}`);

  return lines.join('\n');
}

export function recordReply(description, petName, summary, hints = []) {
  const lines = [`✅ 已記錄（${petName}）`, description, '', '── 今日累積 ──', summaryBlock(summary)];
  for (const hint of hints) {
    if (hint) lines.push('', `※ ${hint}`);
  }
  return lines.join('\n');
}

export function todayReply(petName, date, summary) {
  if (!summary.entryCount) {
    return `📅 ${date}（${petName}）\n今天還沒有任何紀錄。\n輸入「水 20」或「乾糧 品牌 4g」開始記錄。`;
  }
  return `📅 ${date}（${petName}）共 ${summary.entryCount} 筆\n${summaryBlock(summary)}`;
}

export function weekReply(petName, rows) {
  const lines = [`📈 近 7 天（${petName}）`];
  for (const row of rows) {
    const shortDate = row.date.slice(5).replace('-', '/');
    if (!row.entryCount) {
      lines.push(`${shortDate}　—`);
      continue;
    }
    const parts = [`水 ${formatNumber(row.totalWaterMl)}`, `熱量 ${formatNumber(row.kcal)}`, `藥 ${row.medTakenCount}`];
    if (row.vomitCount > 0) parts.push(`吐 ${row.vomitCount}`);
    if (row.medIssueCount > 0) parts.push(`藥異常 ${row.medIssueCount}`);
    lines.push(`${shortDate}　${parts.join('｜')}`);
  }
  lines.push('', '※ 詳細內容輸入「網站」開啟照護站。');
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
  lines.push(`有紀錄 ${recorded.length} 天／無紀錄 ${noRecordDays} 天`);
  if (recorded.length) {
    lines.push(`平均水分 ${formatNumber(avg((row) => row.totalWaterMl))} ml／日`);
    lines.push(`平均熱量 ${formatNumber(avg((row) => row.kcal))} kcal／日`);
  }
  if (vomitDays.length) lines.push(`嘔吐日：${vomitDays.join('、')} 號`);
  if (medIssueDays.length) lines.push(`用藥異常日：${medIssueDays.join('、')} 號`);
  if (!vomitDays.length && !medIssueDays.length) lines.push('本月沒有嘔吐或用藥異常。');
  lines.push('', '※ 月曆圖表請輸入「網站」開啟照護站。');
  return lines.join('\n');
}

export function visitReply(petName, visits, vetsById) {
  if (!visits.length) {
    return `${petName} 目前沒有排定的回診。\n可在照護站「設定 → 回診資料」新增，或輸入「網站」開啟。`;
  }
  const lines = [`🏥 回診資訊（${petName}）`];
  for (const visit of visits) {
    const vet = vetsById[visit.vetId];
    const where = vet ? [vet.hospitalName, vet.doctorName].filter(Boolean).join('・') : '';
    const time = visit.visitTime ? ` ${visit.visitTime}` : '';
    if (visit.nextVisitDate) lines.push(`下次回診：${visit.nextVisitDate}${time}${where ? `（${where}）` : ''}`);
    else if (visit.visitDate) lines.push(`看診日：${visit.visitDate}${time}${where ? `（${where}）` : ''}`);
    if (visit.reason) lines.push(`　原因：${visit.reason}`);
    if (visit.doctorInstruction) lines.push(`　醫囑：${visit.doctorInstruction}`);
  }
  lines.push('', '※ 回診前輸入「近7天」可先看摘要，完整報告請開照護站。');
  return lines.join('\n');
}

export function websiteReply(url) {
  return [
    '🔗 你的照護站登入連結：',
    url,
    '',
    '只要持續使用就會自動延長效期，超過 30 天沒開啟才會過期（過期再輸入一次「網站」即可）。',
    '打開後可查看月曆、修改紀錄、設定貓咪／食物／藥物／回診資料。',
    '請不要把這個連結傳給別人，拿到連結的人就能看到貓咪的資料。'
  ].join('\n');
}

export function helpText() {
  return [
    '📖 貓貓照護管家 使用說明',
    '',
    '【快速記錄】',
    '水 20　→ 喝水 20 ml',
    '乾糧 希爾斯 4g　→ 乾糧 4 克',
    '罐頭 皇家 30g　→ 罐頭 30 克',
    '藥 已吃／藥 早 已吃／藥 晚 漏餵',
    '吐 白色泡沫　→ 嘔吐紀錄',
    '便 成形偏軟　→ 便便紀錄',
    '精神 活動力差　→ 精神紀錄',
    '備註 今天有梳毛',
    '',
    '【補登】',
    '昨天 21:30 水 20　→ 記到昨天 21:30',
    '',
    '【查詢】',
    '今天／近7天／月曆／回診',
    '',
    '【其他】',
    '網站　→ 取得照護站登入連結',
    '新增貓咪 蚵仔　→ 建立貓咪',
    '（多隻貓咪時，訊息開頭加貓咪名即可指定，例如「蚵仔 水 20」）',
    '',
    '※ 本服務僅協助記錄與整理，不提供醫療診斷，貓咪健康問題請諮詢獸醫師。'
  ].join('\n');
}

export function welcomeText() {
  return [
    '歡迎使用貓貓照護管家 Beta 🐾',
    '',
    '先輸入「新增貓咪 名字」建立貓咪檔案，',
    '之後就能用「水 20」「乾糧 品牌 4g」「藥 已吃」快速記錄，',
    '輸入「今天」看今日總結，輸入「網站」開啟照護站。',
    '',
    '完整指令請輸入「說明」。'
  ].join('\n');
}

export function unknownReply() {
  return '看不懂這則訊息。\n輸入「說明」可以看所有指令，例如：水 20、乾糧 希爾斯 4g、藥 已吃、今天。';
}

export function invalidReply(reason, category) {
  if (reason === 'missing_amount' && category === 'water') return '請加上數量，例如「水 20」（單位 ml）。';
  if (reason === 'missing_amount' && category === 'food') return '請加上克數，例如「乾糧 希爾斯 4g」或「罐頭 皇家 30g」。';
  if (reason === 'missing_note') return '請在備註後面加上內容，例如「備註 今天有梳毛」。';
  return unknownReply();
}
