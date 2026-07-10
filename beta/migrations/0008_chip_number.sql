-- 貓咪晶片號碼
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0008_chip_number.sql
-- 回滾：欄位有預設值，程式退回上一版即可
ALTER TABLE pets ADD COLUMN chipNumber TEXT NOT NULL DEFAULT '';
