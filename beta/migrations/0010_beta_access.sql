-- 封閉測試門檻：betaAccess=1 才能使用；預設 0（需邀請碼解鎖）
-- 現有已建過貓咪的使用者一律保留存取權，不受影響
ALTER TABLE users ADD COLUMN betaAccess INTEGER NOT NULL DEFAULT 0;
UPDATE users SET betaAccess = 1
  WHERE lineUserId = 'U05e0238b5cbfb44723e00513bcc2a781'
     OR lineUserId IN (SELECT DISTINCT ownerLineUserId FROM pets WHERE isDeleted = 0);
