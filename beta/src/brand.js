// 品牌常數：全站名稱與文案的唯一來源，不要在其他檔案寫死
export const BRAND = {
  // 前台名稱收斂為「喵喵管家」（原全名「喵喵照護安心管家」逐步簡化）
  name: '喵喵管家',
  // 完整資料管理入口的前台顯示名（原「照護站」）。註：LINE 指令關鍵詞仍相容「照護站」，見 parser.js。
  site: '管家後台',
  tagline: '讓每一次紀錄，都是對貓貓的守護。',
  onboarding: '喵爸媽安心上手',
  beta: '喵喵管家目前為 Beta 測試版，主要用途是協助飼主紀錄日常照護資料，方便回顧、交接與回診時參考。本工具不提供醫療診斷、治療建議或緊急判斷。如貓咪出現明顯不適，請直接聯繫獸醫。',
  dataNote: '你的照護資料只用於本服務的紀錄與摘要功能。請勿將專屬管家後台連結轉傳給不相關的人。'
};

// 資料值 → 顯示文字：資料層保留「漏餵」，所有輸出改為不責備的中性說法（未餵）
export function displayMedStatus(status) {
  return status === '漏餵' ? '未餵' : String(status || '');
}

// 藥物時段：資料層保留「早／晚」，顯示成完整口語（早上／晚上），中午不變
export function displayMedSlot(slot) {
  if (slot === '早') return '早上';
  if (slot === '晚') return '晚上';
  return String(slot || '');
}
