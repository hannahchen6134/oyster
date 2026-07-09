-- 照護提醒開關（每隻貓咪一組 JSON：{"med":true,"water":true,"appetite":true,"stool":true}）
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0004_reminders.sql
ALTER TABLE pets ADD COLUMN reminderJson TEXT NOT NULL DEFAULT '{}';
