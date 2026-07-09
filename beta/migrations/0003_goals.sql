-- 每日照護目標：存在 pets 上（每隻貓咪一組）
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0003_goals.sql
ALTER TABLE pets ADD COLUMN goalWaterMl REAL NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN goalKcal REAL NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN goalMedSlots TEXT NOT NULL DEFAULT '[]';
