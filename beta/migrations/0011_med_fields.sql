-- 用藥紀錄升級：每筆用藥可記劑量、藥物形式、飯前/飯後（皆選填，加欄位安全）
ALTER TABLE logs ADD COLUMN doseText TEXT NOT NULL DEFAULT '';
ALTER TABLE logs ADD COLUMN medForm TEXT NOT NULL DEFAULT '';
ALTER TABLE logs ADD COLUMN beforeMeal TEXT NOT NULL DEFAULT '';
