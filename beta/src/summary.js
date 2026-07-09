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
    meds: [],
    medTakenCount: 0,
    medIssueCount: 0,
    vomitCount: 0,
    stoolCount: 0,
    entryCount: 0,
    abnormalFlags: [],
    vomitNotes: [],
    stoolNotes: [],
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
        else if (log.foodType === '罐頭' || log.foodType === '濕食') summary.wetFoodG += grams;
        else summary.otherFoodG += grams;
        summary.foodWaterMl += toNumber(log.waterMl);
        summary.kcal += toNumber(log.kcal);
        break;
      }
      case 'med': {
        summary.meds.push({
          name: String(log.itemName || ''),
          slot: String(log.medSlot || ''),
          status: String(log.medStatus || ''),
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

  if (summary.vomitCount > 0) summary.abnormalFlags.push('vomit');
  if (summary.medIssueCount > 0) summary.abnormalFlags.push('medIssue');
  if (summary.moodNotes.length > 0) summary.abnormalFlags.push('mood');

  return summary;
}
