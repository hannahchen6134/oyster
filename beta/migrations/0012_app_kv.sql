-- 一般用途的鍵值表：目前用來快取 LINE 自動換發的存取權杖（含到期時間）
-- 讓 Worker 能自己續期權杖，永不因權杖過期而整個停止回覆。
CREATE TABLE IF NOT EXISTS app_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);
