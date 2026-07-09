# 毛孩照護管家 Beta

用 LINE 快速記，照護站完整看與修改，回診時不再靠印象。

這是「蚵仔照護站」的產品化 Beta 版，依照執行企畫書 Phase 0–7 開發，
與正式版**完全分離**（repo 內 `server.js`、`cloudflare-worker/` 等正式版檔案未做任何修改）。

## 架構

```
LINE 官方帳號（Beta 專用 channel）
        │ webhook
        ▼
Cloudflare Worker（beta/src）──── D1 資料庫（SQLite）
        │
        ▼
照護站網站（beta/public，同一個 Worker 直接服務）
```

- **不再使用 Google Sheet / Apps Script**：D1 是真正的多使用者資料庫，沒有冷啟動，
  所以 LINE 一律用免費的 reply 回覆，不需要正式版的「早回 ack + push」補丁，也不會消耗 push 訊息額度。
- **登入方式**：在 LINE 輸入「網站」，機器人回覆專屬登入連結（30 天有效），點開即登入，免註冊。
- 全部在 Cloudflare 免費額度內（Workers 每天 10 萬次請求、D1 5GB）。

## 部署步驟（第一次）

### 1. 建立 Beta 官方 LINE

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立新 Provider（或用現有的）
2. 建立 **Messaging API** channel，名稱例如「毛孩照護管家 Beta」（不要用蚵仔正式版的 channel！）
3. 記下 **Channel secret**（Basic settings 分頁）
4. 到 Messaging API 分頁發行 **Channel access token**
5. 關閉「自動回應訊息」、關閉「加入好友的歡迎訊息」（LINE Official Account Manager → 回應設定）

### 2. 部署 Worker 與資料庫

```bash
cd beta
npm install
npx wrangler login                 # 登入你的 Cloudflare 帳號

# 建立 D1 資料庫，把回傳的 database_id 貼進 wrangler.toml
npx wrangler d1 create pet-care-beta

# 建立資料表
npm run db:init

# 設定 LINE 金鑰（貼上第 1 步拿到的值）
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET

# 部署
npm run deploy
```

部署完成會顯示網址，例如 `https://pet-care-beta.你的帳號.workers.dev`。

### 3. 串接 webhook

回到 LINE Developers → Messaging API 分頁：

- **Webhook URL** 填 `https://pet-care-beta.你的帳號.workers.dev/webhook`
- 打開 **Use webhook**
- 按 **Verify** 應顯示 Success

### 4. 開始使用

1. 用 QR code 加 Beta 官方帳號好友
2. 輸入 `新增毛孩 蚵仔`
3. 輸入 `水 20` → 應回覆這筆紀錄＋今日累積
4. 輸入 `網站` → 點連結開啟照護站，到「設定 → 食物」建立食物公式（kcal/g、水分比例）
5. 之後輸入 `乾糧 希爾斯 4g` 就會自動計算熱量與水分

## LINE 指令表

| 類型 | 指令範例 | 說明 |
| --- | --- | --- |
| 喝水 | `水 20` | 單位 ml，`水20` 也可以 |
| 食物 | `乾糧 希爾斯 4g`、`罐頭 皇家 30g`、`濕食 20`、`零食 5` | 有設定食物公式會自動算熱量/水分 |
| 藥物 | `藥 已吃`、`藥 早 已吃`、`藥 心臟藥 晚 漏餵` | 狀態：已吃/漏餵/吐掉/拒吃 |
| 嘔吐 | `吐 白色泡沫` | |
| 便便 | `便 成形偏軟`、`軟便` | |
| 精神 | `精神 活動力差` | |
| 備註 | `備註 今天有梳毛` | |
| 補登 | `昨天 21:30 水 20`、`前天 乾糧 4g` | 事件時間記在指定時間 |
| 查詢 | `今天`、`近7天`、`月曆`、`回診` | |
| 網站 | `網站` | 取得照護站登入連結（30 天有效） |
| 毛孩 | `新增毛孩 蚵仔`、`蚵仔 水 20` | 多隻毛孩時訊息開頭加名字指定 |
| 說明 | `說明` | 指令教學 |

## 照護站功能

- **今日明細**：總結卡（總水分＝喝水＋食物水、食物、熱量、用藥/異常）、給醫生的一句話、
  當日時間軸，每筆可**編輯**（含日期時間，跨日會自動重算兩天）與**刪除**（軟刪除），可新增/補登
- **月曆**：每日顯示水分、熱量、用藥（⚠️ 表示漏餵/吐掉/拒吃）、🤮💩、🏥 回診日；點日期進當日明細
- **近30天**：每日總結表格，異常日整列淡紅標示
- **設定**：毛孩、食物公式、藥物、醫院醫生、回診資料，全部可新增/修改/刪除

## 開發

```bash
cd beta
npm test          # parser 與 summary 純函式單元測試（30 項）
npm run dev       # wrangler dev 本機開發
```

## 資料表

依企畫書第 7 節：`users`、`pets`、`food_items`、`meds`、`vets`、`vet_visits`、`logs`、
`daily_summary`、`share_links`（Phase 9 用，已先建）、`care_members`（Phase 10 用，已先建）、`sessions`。

重要欄位規則：

- `eventDateTime`＝事件實際發生時間（台北時區），`createdAt`＝資料建立時間，補登可修改前者
- 刪除一律 `isDeleted` 軟刪除
- logs 有任何新增/修改/刪除，該日 `daily_summary` 立即重算

## Phase 對照與驗收狀態

| Phase | 內容 | 狀態 |
| --- | --- | --- |
| 0 | Beta 環境（獨立 LINE / Worker / D1，與正式版分離） | ✅ 程式就緒，待你建 channel 與部署 |
| 1 | 正式版只讀盤點 | ✅ 已完成（正式版零修改） |
| 2 | Beta 資料表 | ✅ `schema.sql` |
| 3 | LINE 記錄＋今日總計 | ✅ |
| 4 | 設定頁（毛孩/食物/藥物/醫院醫生） | ✅ |
| 5 | 明細修改/刪除＋重算 | ✅ |
| 6 | 網站月曆 | ✅ |
| 7 | LINE 查詢（今天/近7天/月曆/回診） | ✅ |
| 8 | 圖文選單 | ⬜ 下一批 |
| 9 | 醫生版分享連結 | ⬜ 下一批（`share_links` 表已建） |
| 10 | 共同照護權限 | ⬜ 下一批（`care_members` 表已建） |
| 11 | 完整測試＋3–5 位飼主試用 | ⬜ 部署後進行 |

## 可販售前的待辦（提醒）

- 隱私權政策與服務條款頁
- 資料匯出 / 刪除帳號功能
- LINE Login（LIFF）取代連結登入（目前 token 連結對 Beta 夠用）
- 金流與方案（企畫書明定 Beta 不做）

⚠️ 本服務僅協助記錄與整理，不提供醫療診斷；毛孩健康問題請諮詢獸醫師。
