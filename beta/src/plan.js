// 付費方案：free / plus。planExpiresAt 為空＝永久；有值＝到期時間（ISO）。
// 試用給 7 天 plus，到期自動失效（每次判斷都看時間，不需背景清理）。

export const ADMIN_LINE_IDS = ['U05e0238b5cbfb44723e00513bcc2a781']; // Hannah：永久 plus

export const TRIAL_DAYS = 7;

// Beta 期間全站免費：設 true 時所有人都當 plus（正式收費時改 false）
export const BETA_ALL_FREE = true;

export function isPlus(user) {
  if (BETA_ALL_FREE) return true;
  if (!user) return false;
  if (ADMIN_LINE_IDS.includes(user.lineUserId)) return true;
  if (user.plan !== 'plus') return false;
  if (!user.planExpiresAt) return true; // 永久 plus
  return new Date(user.planExpiresAt).getTime() > Date.now();
}

// 目前有效的方案狀態（給前端/回覆用）
export function planStatus(user) {
  const admin = user && ADMIN_LINE_IDS.includes(user.lineUserId);
  const plus = isPlus(user);
  let expiresAt = '';
  let trialActive = false;
  if (!admin && !BETA_ALL_FREE && user?.plan === 'plus' && user.planExpiresAt) {
    expiresAt = user.planExpiresAt;
    trialActive = new Date(user.planExpiresAt).getTime() > Date.now();
  }
  return { plus, admin: Boolean(admin), betaFree: BETA_ALL_FREE, expiresAt, trialActive };
}

// 封閉測試門檻：betaAccess=1 或管理員才可使用；其餘需邀請碼解鎖
export function isBetaAllowed(user) {
  if (!user) return false;
  if (ADMIN_LINE_IDS.includes(user.lineUserId)) return true;
  return Number(user.betaAccess) === 1;
}

export function normalizeCode(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

export function gateText() {
  return [
    '感謝你對喵喵照護安心管家的興趣 🐱',
    '',
    '目前是封閉測試中，需要邀請碼才能開始使用。',
    '',
    '🤝 朋友邀你「一起照護貓咪」？',
    '直接輸入對方給你的 6 碼邀請碼，馬上就能加入、一起記錄。',
    '',
    '🔑 想自己開始使用？',
    '向已在使用的朋友索取邀請碼，輸入即可解鎖。'
  ].join('\n');
}

export function trialExpiryFromNow(days = TRIAL_DAYS) {
  return new Date(Date.now() + days * 86400000).toISOString();
}
