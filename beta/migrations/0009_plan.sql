-- 付費方案：plan（free/plus）、planExpiresAt（試用/訂閱到期，空=永久）
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0009_plan.sql
-- 回滾：欄位有預設值，程式退回上一版即可
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN planExpiresAt TEXT NOT NULL DEFAULT '';
