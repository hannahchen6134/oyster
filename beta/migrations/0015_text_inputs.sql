-- 文字輸入原始紀錄（第一階段：貓名解析＋raw input 安全修補）
-- 獨立於正式 logs，不進每日摘要／回診摘要。寫入失敗不得影響照護紀錄。
-- 資料生命週期：規劃保留 90 天，但自動清理尚未啟用；在排程完成前資料可能持續保存（部署前隱私缺口）。
-- 目前僅有 purgeOldTextInputs / 手動 DELETE 可清；不得對外描述為「已保留 90 天」。
--
-- ⚠️ 尚未套用到遠端 D1。之後授權時執行：
--   CLOUDFLARE_API_TOKEN=<token> npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0015_text_inputs.sql
-- （執行前程式的 logTextInput 也會以 CREATE TABLE IF NOT EXISTS 自動建表；此檔為正式紀錄與可重現用。）

CREATE TABLE IF NOT EXISTS text_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineUserId TEXT NOT NULL DEFAULT '',
  ownerLineUserId TEXT NOT NULL DEFAULT '',
  petId TEXT NOT NULL DEFAULT '',
  rawText TEXT NOT NULL DEFAULT '',
  parseStatus TEXT NOT NULL DEFAULT '',
  failReason TEXT NOT NULL DEFAULT '',
  sourceMessageId TEXT NOT NULL DEFAULT '',
  resolvedPetId TEXT NOT NULL DEFAULT '',
  linkedLogId TEXT NOT NULL DEFAULT '',
  parsedResult TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_text_inputs_user ON text_inputs(lineUserId, createdAt);
CREATE INDEX IF NOT EXISTS idx_text_inputs_created ON text_inputs(createdAt);
