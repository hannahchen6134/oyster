# LINE 紀錄速度：第一批調整（2026-09-07）

這一批縮短紀錄者等待確認卡的流程，同時保留本次內容、今日累積、目標、百分比與進度條。另補上「還差多少／已達目標」。沒有更換 parser、重寫每日加總、新增 schema 或 migration。

## 回覆順序

驗簽 → 既有 schema 檢查與事件去重 → 使用者／共照權限／貓咪 → parser → 寫入 logs → 沿用 recomputeDay 重算當日總計 → Flex → LINE reply（既有 push 備援）。

- loading 與處理並行，最多等待 700ms；準備回覆時取消尚未完成的 loading。即使權杖讀取很慢，也不會在回覆後才啟動新的 loading request。已經抵達 LINE 的請求不能保證從遠端撤回。
- 同一個事件共用一次權杖取得結果，避免 loading 與 reply 重複查詢／換發。
- 個人選單維護、record analytics、共照者傳給爸媽的通知，延後到主流程回覆嘗試完成後。每位記錄者在同一事件只維護一次選單。
- 後續工作由原有 webhook `ctx.waitUntil()` 鏈管理；通知依然有 Flex → 文字備援。後續工作失敗不會把已儲存紀錄再次回覆成失敗。
- 保留同批 webhook 事件的原有順序；尚未加入持久化 queue。背景工作受 Workers 生命週期限制，不能把 waitUntil 視為保證送達的佇列。[Cloudflare 文件](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

## 已確認的工作量差異

條件：既有單貓帳號、schema 已初始化、權杖可用、個人選單與登入 session 仍有效，輸入「喝水20ml」。計數為 SQL statements，不是 rows_read，也不是 HTTP 封包數。

| 回覆前工作 | 調整前 | 調整後 |
| --- | ---: | ---: |
| SELECT | 8 | 6 |
| INSERT／UPSERT | 4 | 3 |
| SQL 合計 | 12 | 9 |

兩個選單／session 查詢與一次 analytics 寫入不再阻塞回覆；同一事件原本重複做的選單檢查也被合併。schema 初始化、權杖換發、session 更新、新使用者、多貓待選、食物反查與多筆訊息都可能增加工作量，不能一律宣稱只有 9 次。

加總仍為讀取該貓該日 logs → JavaScript 計算 → 寫入 daily_summary。沒有把舊的 cache 當成最新結果，也沒有拿掉確認卡來換速度。

## 計時記錄

`src/line-event.js` 為每一事件建立獨立 scope，包住 D1 prepare/bind/first/all/run/raw/batch。紀錄只含分類、數量、耗時、狀態、機房，以及不可反推使用者的隨機 trace；不記錄訊息原文、SQL 參數、貓名、LINE user ID、reply token 或存取權杖。既有業務資料留存方式不變。

- `line_record_timing`：主流程結束、執行延後工作之前輸出。
- `line_record_background`：後續工作完成後輸出，同 trace 的累積快照。**不要把兩份 query 數或耗時再加總。**
- `line_background_failed`：只列工作類別 menu／analytics／notify；不含會員資料。

| 欄位 | 意義 |
| --- | --- |
| `server_ms` | Worker 收到 webhook 到第一次準備送出 reply／對記錄者 push 的時間，包含驗簽、權杖等待與同批事件排隊 |
| `line_accepted_ms` | 收到 webhook 到 LINE API 首次成功接受回覆；null 表示未成功接受，**不是手機畫面出現時間** |
| `marks` | event_start、schema_done、user_resolved、owner_resolved、pets_loaded、parser_done、insert_done、summary_done、flex_done、before_line、line_accepted、handler_done、all_done；依路徑可能缺少，重複步驟保留最後時間 |
| `spans` | schema、摘要對話狀態查詢、daily_summary，以及 after:menu／analytics／notify 的累計時間 |
| `queries` | before_reply／after_reply × SQL 動作／允許的資料表名稱：count、ms、errors 與可取得的 D1 metadata |
| `line` | loading／reply／notify 各次呼叫耗時與 HTTP 狀態；status null 可為取消或網路失敗 |
| `colo` / `db_region` | 可取得時記錄 Worker / D1 服務地區 |

`queries.ms` 是等待 D1 的時間，不是 CPU time。`sql_ms` 是 D1 metadata 可提供的 SQL 時間；`first()` 不帶 metadata、某些執行環境也不提供 timings，所以零值不能解讀為實際不耗時。`rows_written` 可能包含索引更新，不等於新增的照護紀錄數。[D1 回傳格式](https://developers.cloudflare.com/d1/worker-api/return-object/)

## 如何判斷是否達標

1. 在 Beta 正常使用中收集匿名 timing，先分開單筆水、食物、藥物、體重、多筆、共照及首次初始化。不要為測速把假紀錄寫進真實帳號。
2. 成功紀錄樣本使用 `type=line_record_timing`、`records > 0`、`status=handled`、`line_accepted_ms != null`。待確認與失敗另外列出比例，不能混進「成功完成」分位數，也不能隱藏失敗。
3. 各類列出樣本數、觀察期間、best、P50、P90、P95、max。建議至少 100 筆再看整體 P95；小樣本需標明不穩定，不補造缺少的分位數。
4. 暫定目標：server P50 < 500ms、P95 < 1.5s；手機從按送出到完整確認卡出現，多數 < 3 秒。後者需要手機錄影或實際操作量測，不能以 webhook HTTP 200 或 LINE API 200 代替。
5. 若 D1 等待占比仍高，再考慮重用已知查詢結果與日期範圍查詢；若是 LINE API／網路慢，先依 timing 判斷。這次沒有直接改資料庫地區、Workers 方案或加快取。

## 驗證與限制

- 新增 9 項回歸測試：查詢數、完整進度、慢 loading／權杖、慢共照通知、選單失敗、通知備援、多筆、事件去重、歸屬與無效簽章。
- 完整測試 621 項通過；本機 workerd + Miniflare 的獨立 D1 驗證單筆寫入、總計 20ml、還差 180ml、analytics 與重送只回一次。LINE 出站全由測試替身攔截，沒有發送真實訊息。這些是功能證據，不能當線上延遲統計。
- 既有首次 isolate 的 schema 檢查仍存在，僅移至 webhook 驗簽後；重複欄位 ALTER 會被原有程式忽略，故初始化的 query errors 不一定是紀錄失敗。
- **另案待修：**原有 recomputeDay 的「讀取 → 計算 → upsert」在多人同時寫入時可能由較早快照覆寫較新 daily_summary。稽核已重現，這一批沒有新增或改變加總演算法，也沒有宣稱解決競態。後續一致性修正要涵蓋新增、修改、刪除、補登、改日期、共照同時操作，不能只靠延遲或記憶體鎖。
