-- 任務／事件分離：新增 tasks 表，logs 加 sourceTaskId 連回原任務。
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0014_tasks.sql
--
-- 任務（還要做的事）與事件（已發生的事，存在 logs）分開。
-- 完成任務時：把 task 標 completed，並建立一筆帶 sourceTaskId 的 logs 事件（原子交易）。
-- 唯一索引（僅對非空 sourceTaskId）保證「一個任務最多一筆正式事件」，擋掉連點/重送/併發重複。

CREATE TABLE IF NOT EXISTS tasks (
  taskId TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  taskType TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  scheduledAt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  createdBy TEXT NOT NULL DEFAULT '',
  completedAt TEXT NOT NULL DEFAULT '',
  completedBy TEXT NOT NULL DEFAULT '',
  skippedAt TEXT NOT NULL DEFAULT '',
  repeatRule TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_pet ON tasks(petId, status, scheduledAt);

ALTER TABLE logs ADD COLUMN sourceTaskId TEXT NOT NULL DEFAULT '';
-- 未軟刪的事件才計入唯一性，取消完成（軟刪事件）後才能重新完成
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_sourcetask ON logs(sourceTaskId) WHERE sourceTaskId != '' AND isDeleted = 0;
