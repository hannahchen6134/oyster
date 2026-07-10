-- 多人共同照護預留欄位（migration 0006）
-- 備份：已於執行前 wrangler d1 export 全量備份
-- Rollback：新欄位皆有預設值、舊程式讀不到也不影響；還原＝重新部署上一版程式即可，
--          資料層另有 D1 Time Travel 可做時間點還原。
ALTER TABLE logs ADD COLUMN recordedBy TEXT NOT NULL DEFAULT '';
ALTER TABLE logs ADD COLUMN caregiverName TEXT NOT NULL DEFAULT '';
ALTER TABLE logs ADD COLUMN isBackfilled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logs ADD COLUMN source TEXT NOT NULL DEFAULT '';
