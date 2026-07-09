-- 已部署的 D1 資料庫升級：vet_visits 加上看診時間欄位
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0002_visit_time.sql
ALTER TABLE vet_visits ADD COLUMN visitTime TEXT NOT NULL DEFAULT '';
