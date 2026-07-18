-- 每日總結/提醒的發送時間（每位飼主自訂，整點；預設晚上 9 點）
ALTER TABLE users ADD COLUMN reminderHour INTEGER NOT NULL DEFAULT 21;
