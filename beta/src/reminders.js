// 照護提醒（純函式，可單元測試）
// 每晚由 Cron Trigger 檢查當天狀況，有需要才推播。
// 規則全部可由飼主在照護站「設定 → 提醒」開關。

export function parseReminderSettings(pet) {
  try {
    const settings = JSON.parse(pet?.reminderJson || '{}');
    return settings && typeof settings === 'object' ? settings : {};
  } catch (error) {
    return {};
  }
}

export function hasAnyReminder(pet) {
  const s = parseReminderSettings(pet);
  return Boolean(s.med || s.water || s.appetite || s.stool);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// rows：近 8 天（含今天）的 daily_summary，由舊到新、缺日補零；最後一筆是今天
export function buildReminderLines(pet, rows) {
  const settings = parseReminderSettings(pet);
  const lines = [];
  if (!rows.length) return lines;

  const today = rows[rows.length - 1];
  const prev = rows.slice(0, -1);
  const recorded = prev.filter((row) => row.entryCount > 0);

  // 今天完全沒記錄：只提醒補記（平常有記錄習慣的人才提醒）
  if (today.entryCount === 0) {
    if (recorded.length >= 4) lines.push('今天還沒有任何紀錄，睡前補記一下哦');
    return lines;
  }

  if (settings.med) {
    let goalSlots = [];
    try { goalSlots = JSON.parse(pet?.goalMedSlots || '[]'); } catch (error) { /* ignore */ }
    if (Array.isArray(goalSlots) && goalSlots.length) {
      let meds = [];
      try { meds = JSON.parse(today.medJson || '[]'); } catch (error) { /* ignore */ }
      const doneSlots = new Set(meds.filter((med) => med.status === '已吃').map((med) => med.slot));
      const missing = goalSlots.filter((slot) => !doneSlots.has(slot));
      if (missing.length) lines.push(`${missing.join('、')}的藥還沒記錄`);
    } else {
      // 沒設目標時：平常有餵藥習慣（近 7 天有 4 天以上）但今天沒有任何用藥紀錄
      const medDays = recorded.filter((row) => row.medTakenCount > 0 || row.medIssueCount > 0).length;
      if (medDays >= 4 && today.medTakenCount === 0 && today.medIssueCount === 0) {
        lines.push('今天還沒有用藥紀錄');
      }
    }
  }

  if (settings.water && recorded.length >= 3) {
    const avgWater = average(recorded.map((row) => Number(row.totalWaterMl) || 0));
    const todayWater = Number(today.totalWaterMl) || 0;
    if (avgWater > 0 && todayWater < avgWater * 0.6) {
      lines.push(`水分只有 ${Math.round(todayWater)} ml\n　（平常約 ${Math.round(avgWater)} ml）`);
    }
  }

  if (settings.appetite && recorded.length >= 3) {
    const avgKcal = average(recorded.map((row) => Number(row.kcal) || 0));
    const todayKcal = Number(today.kcal) || 0;
    if (avgKcal > 0 && todayKcal < avgKcal * 0.6) {
      lines.push(`熱量只有 ${Math.round(todayKcal)} kcal\n　（平常約 ${Math.round(avgKcal)} kcal）`);
    }
  }

  if (settings.stool) {
    const yesterday = prev[prev.length - 1];
    if (yesterday && yesterday.entryCount > 0 && today.stoolCount === 0 && yesterday.stoolCount === 0) {
      lines.push('連續 2 天沒有便便紀錄');
    }
  }

  return lines;
}

export function reminderMessage(pet, lines) {
  return [
    `🔔 照護提醒（${pet.petName}）`,
    ...lines.map((line) => `・${line}`),
    '',
    '做了但忘了記的話，',
    '補記一下就好；',
    '真的有異常請諮詢獸醫師。'
  ].join('\n');
}
