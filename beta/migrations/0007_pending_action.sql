-- 引導流程等待狀態（例如等使用者輸入體重數字）
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0007_pending_action.sql
-- 回滾：欄位有預設值，程式退回上一版即可，不需 DROP
ALTER TABLE users ADD COLUMN pendingAction TEXT NOT NULL DEFAULT '';
