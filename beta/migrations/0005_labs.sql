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
