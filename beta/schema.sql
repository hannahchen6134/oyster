-- 貓貓照護管家 Beta — Cloudflare D1 資料庫結構
-- 依照執行企畫書第 7 節資料表規格建立。
-- eventDateTime 為事件實際發生時間（Asia/Taipei，格式 YYYY-MM-DD HH:MM），createdAt 為資料建立時間。
-- 刪除一律使用 isDeleted 軟刪除，不直接清除資料。

CREATE TABLE IF NOT EXISTS users (
  lineUserId TEXT PRIMARY KEY,
  displayName TEXT NOT NULL DEFAULT '',
  defaultPetId TEXT NOT NULL DEFAULT '',
  pendingAction TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pets (
  petId TEXT PRIMARY KEY,
  ownerLineUserId TEXT NOT NULL,
  petName TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '貓',
  birthday TEXT NOT NULL DEFAULT '',
  breed TEXT NOT NULL DEFAULT '',
  weightKg REAL NOT NULL DEFAULT 0,
  chipNumber TEXT NOT NULL DEFAULT '',
  conditionNote TEXT NOT NULL DEFAULT '',
  vaccineNote TEXT NOT NULL DEFAULT '',
  defaultVetId TEXT NOT NULL DEFAULT '',
  goalWaterMl REAL NOT NULL DEFAULT 0,
  goalKcal REAL NOT NULL DEFAULT 0,
  goalMedSlots TEXT NOT NULL DEFAULT '[]',
  reminderJson TEXT NOT NULL DEFAULT '{}',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pets_owner ON pets(ownerLineUserId, isDeleted);

CREATE TABLE IF NOT EXISTS food_items (
  foodId TEXT PRIMARY KEY,
  ownerLineUserId TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  productName TEXT NOT NULL DEFAULT '',
  displayName TEXT NOT NULL,
  foodType TEXT NOT NULL DEFAULT '乾糧',
  kcalPerGram REAL NOT NULL DEFAULT 0,
  waterRatio REAL NOT NULL DEFAULT 0,
  isPrescription INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foods_owner ON food_items(ownerLineUserId, isDeleted);

CREATE TABLE IF NOT EXISTS meds (
  medId TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  medName TEXT NOT NULL,
  doseAmount REAL NOT NULL DEFAULT 0,
  doseUnit TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT '',
  defaultTimes TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meds_pet ON meds(petId, isDeleted);

CREATE TABLE IF NOT EXISTS vets (
  vetId TEXT PRIMARY KEY,
  ownerLineUserId TEXT NOT NULL,
  hospitalName TEXT NOT NULL DEFAULT '',
  doctorName TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vets_owner ON vets(ownerLineUserId, isDeleted);

CREATE TABLE IF NOT EXISTS vet_visits (
  visitId TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  vetId TEXT NOT NULL DEFAULT '',
  visitDate TEXT NOT NULL DEFAULT '',
  visitTime TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  doctorInstruction TEXT NOT NULL DEFAULT '',
  nextVisitDate TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_pet ON vet_visits(petId, isDeleted);

CREATE TABLE IF NOT EXISTS logs (
  logId TEXT PRIMARY KEY,
  lineUserId TEXT NOT NULL,
  petId TEXT NOT NULL,
  eventDateTime TEXT NOT NULL,
  category TEXT NOT NULL,
  itemName TEXT NOT NULL DEFAULT '',
  foodType TEXT NOT NULL DEFAULT '',
  foodId TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  waterMl REAL NOT NULL DEFAULT 0,
  kcal REAL NOT NULL DEFAULT 0,
  medStatus TEXT NOT NULL DEFAULT '',
  medSlot TEXT NOT NULL DEFAULT '',
  doseText TEXT NOT NULL DEFAULT '',
  medForm TEXT NOT NULL DEFAULT '',
  beforeMeal TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sourceMessageId TEXT NOT NULL DEFAULT '',
  recordedBy TEXT NOT NULL DEFAULT '',
  caregiverName TEXT NOT NULL DEFAULT '',
  isBackfilled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT NOT NULL DEFAULT '',
  sourceTaskId TEXT NOT NULL DEFAULT '',
  -- P0-2 食物調整：保留「原本餵的量」與「剩下的量」（可為 NULL、向後相容）；amount 一律＝實際吃掉量（統計語意不變）
  servedAmount REAL,
  leftoverAmount REAL
);
CREATE INDEX IF NOT EXISTS idx_logs_pet_event ON logs(petId, eventDateTime, isDeleted);
CREATE INDEX IF NOT EXISTS idx_logs_message ON logs(sourceMessageId);
-- 一個任務最多一筆「有效」正式事件（只約束非空 sourceTaskId 且未軟刪；舊資料為空、不受影響）
-- 加上 isDeleted = 0：取消完成會把事件軟刪，之後重新完成才不會撞到舊事件的 sourceTaskId
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_sourcetask ON logs(sourceTaskId) WHERE sourceTaskId != '' AND isDeleted = 0;

CREATE TABLE IF NOT EXISTS daily_summary (
  petId TEXT NOT NULL,
  date TEXT NOT NULL,
  waterMl REAL NOT NULL DEFAULT 0,
  foodWaterMl REAL NOT NULL DEFAULT 0,
  totalWaterMl REAL NOT NULL DEFAULT 0,
  dryFoodG REAL NOT NULL DEFAULT 0,
  wetFoodG REAL NOT NULL DEFAULT 0,
  otherFoodG REAL NOT NULL DEFAULT 0,
  kcal REAL NOT NULL DEFAULT 0,
  medJson TEXT NOT NULL DEFAULT '[]',
  medTakenCount INTEGER NOT NULL DEFAULT 0,
  medIssueCount INTEGER NOT NULL DEFAULT 0,
  vomitCount INTEGER NOT NULL DEFAULT 0,
  stoolCount INTEGER NOT NULL DEFAULT 0,
  abnormalFlags TEXT NOT NULL DEFAULT '[]',
  entryCount INTEGER NOT NULL DEFAULT 0,
  -- P0-3：當日總熱量是否含「用類型預設估算」的食物筆（1＝含估算、0＝全精準）。
  -- 可為 NULL＝「未知」（部署前既有列、欄位剛加尚未 recompute）；讀取時由當天底層 logs 安全推導，不當成精準。
  kcalEstimated INTEGER,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (petId, date)
);

CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  rangeDays INTEGER NOT NULL DEFAULT 30,
  expiresAt TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'vet_viewer',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS care_members (
  memberId TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  ownerLineUserId TEXT NOT NULL,
  memberLineUserId TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  status TEXT NOT NULL DEFAULT 'invited',
  invitedAt TEXT NOT NULL DEFAULT '',
  acceptedAt TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_pet ON care_members(petId, status);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  lineUserId TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(lineUserId);
-- 血檢紀錄：一列一個項目值，同一天多列組成一份報告
-- 執行：npx wrangler d1 execute cat-care-beta --remote --file=./migrations/0005_labs.sql
CREATE TABLE IF NOT EXISTS labs (
  labId TEXT PRIMARY KEY,
  petId TEXT NOT NULL,
  testDate TEXT NOT NULL,
  itemName TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  refLow REAL NOT NULL DEFAULT 0,
  refHigh REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labs_pet_date ON labs(petId, testDate, isDeleted);
CREATE INDEX IF NOT EXISTS idx_labs_pet_item ON labs(petId, itemName, isDeleted);

-- 任務（還要做的事）；已發生的事存在 logs（事件）。完成任務→建一筆帶 sourceTaskId 的 logs 事件。
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

-- 文字輸入原始紀錄（獨立於正式 logs，不進任何摘要）：保存原文＋解析結果，供分析「大家實際打什麼、卡在哪」。
-- 寫入失敗不得影響照護紀錄（呼叫端 try/catch、先寫 logs 再記這裡）。
-- 資料生命週期：規劃保留 90 天，但自動清理尚未啟用；在排程完成前資料可能持續保存（部署前隱私缺口）。
CREATE TABLE IF NOT EXISTS text_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineUserId TEXT NOT NULL DEFAULT '',
  ownerLineUserId TEXT NOT NULL DEFAULT '',
  petId TEXT NOT NULL DEFAULT '',
  rawText TEXT NOT NULL DEFAULT '',
  parseStatus TEXT NOT NULL DEFAULT '',
  failReason TEXT NOT NULL DEFAULT '',
  sourceMessageId TEXT NOT NULL DEFAULT '',
  resolvedPetId TEXT NOT NULL DEFAULT '',
  linkedLogId TEXT NOT NULL DEFAULT '',
  parsedResult TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_text_inputs_user ON text_inputs(lineUserId, createdAt);
CREATE INDEX IF NOT EXISTS idx_text_inputs_created ON text_inputs(createdAt);
