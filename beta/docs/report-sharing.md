# 醫生／照護者報告、範本與 QR 分享

2026-09-07：從 main 95ce5b2 延續。僅修改 cat-care-beta。

## 使用流程

- 出報告 → 給醫生（7／14／30 天）或給照護者 → 選貓／新增貓。
- 照護者：貼上單隻貓的說明 → 整理說明 → 展開確認內容與補充 → 儲存或套用該貓的範本。
- 確認報告勾選後，可分享圖片、傳到 LINE，或產生 QR Code。
- QR 預設有效 7 天，另有 1／30 天；「已分享的報告」可重新查看 QR 或停用。
- QR 圖片可儲存、長按、傳到 LINE；圖片原有多頁及超過 LINE 上限的手動分享備案保留。
- 不提供客戶圖片上傳。報告介面與公開頁外圍至少 36px，按鈕採適中寬度。

## 儲存與權限

利用既有 app_kv，不修改 schema、不遷移既有照護紀錄：

- careTemplate:<owner>:<petId>：每貓一份已儲存範本。草稿仍使用 actor／petId／purpose 的 sessionStorage。
- reportShare:<opaque-token>：不可變的文字報告快照、owner、petId、用途、建立時間、到期時間及停用狀態。
- reportLimit:<scope>:<bucket>：原子 SQL 計數，AI 每主人每日 10 次，分享每日 30 次。
- 每小時 cron 清除到期快照與兩天前的計數；停用時立即抹除快照內容。

新增 API 都先走既有 Bearer session 身分驗證，再核對貓咪歸屬。主人才能管理範本、AI 與 QR 分享；共同照護者保留原有讀取及圖片功能。

POST /api/report-shares 必須有確認旗標、32–36 字元隨機 Idempotency-Key。依 owner 與該 key 產生 128-bit opaque token；唯一鍵及 INSERT ON CONFLICT DO NOTHING 確保平行重送不覆寫原快照。重試到期／停用 key 會被拒絕。

公開 GET /r/<token> 不要求登入，但僅回傳白名單文字快照。沒有主人後台、登入 token 或資料編輯入口。持有網址的人能看；不把它宣稱為身分驗證。無效／停用／過期／貓被刪除時一律 410。

HTML 全部跳脫，CSP 無 script、外部請求、iframe、表单；no-store、no-referrer、noindex。已下載或截圖的內容无法追回。POST/PUT 不提供訪客修改功能。

## AI

Wrangler [ai] 綁定 AI，使用 Cloudflare @cf/meta/llama-3.1-8b-instruct。
只傳主人當次按「整理說明」的文字，不傳家庭歷史紀錄或帳號權杖。介面明示文字交由 Cloudflare AI 處理。

AI 只回傳原句序號的分類，不產生照護文字。伺服器從原文重建五個欄位，未知／重複／遺漏序號改以關鍵字分類，保留每個原句及數字。15 秒逾時或 AI 失敗會走規則備案，介面不宣稱 AI 成功。不診斷、不推論劑量；仍須主人確認。

AI 使用帳號既有 Workers AI 配額，沒有變更 Cloudflare 訂閱方案；超額或 unavailable 時可直接編輯欄位。真實 API 已以虛構文字驗證 200 及正確分類。

## 相依套件與驗證

qrcode-generator 2.0.4 的 dist/qrcode.mjs 隨 public 自行供應，不傳報告 URL 給第三方 QR 網站。MIT 版權資訊保留於檔頭。jsqr 1.4.0 僅供測試解碼。

新增測試涵蓋：主人／共同照護者／陌生人／未登入、每貓範本、文字上限、公開頁 XSS／內部欄位過濾、用途分開、同 key 平行重送、過期／停用／刪貓、AI 無法新增或丟失原文、次數限制、QR 獨立解碼。

實際 Chromium 測試使用記憶體 SQLite 測試資料：整理 → 存範本 → 換貓 → 套用 → 圖片輸出 → QR → 公開頁 → 停用、醫生 QR、新增貓咪；320／390／430／1280 寬度不溢出。真人 LINE 發送及 iOS/Android 真機另需實機驗收，沒有主動向真人發送訊息。
