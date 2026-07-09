# 貓貓照護管家 Beta — 部署結果

部署日期:2026-07-09(台北時間)

## 部署資訊

| 項目 | 值 |
| --- | --- |
| Worker 名稱 | `cat-care-beta` |
| 部署網址 | https://cat-care-beta.hannahchen6134.workers.dev |
| Webhook URL | https://cat-care-beta.hannahchen6134.workers.dev/webhook |
| D1 資料庫 | `cat-care-beta`(database_id 見 `wrangler.toml`,區域 ENAM) |
| LINE 官方帳號 | 喵喵照護管家(basic ID:`@232mjffx`) |
| 加好友連結 | https://line.me/R/ti/p/@232mjffx |

Secrets(`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`)已用
`wrangler secret put` 設定,未寫入任何檔案。

## 驗證結果(全部通過)

- 單元測試:30/30 通過(`npm test`)
- `GET /healthz` → `{"ok":true,"service":"cat-care-beta"}`
- `schema.sql` 已套用:11 張資料表建立完成
- LINE webhook 端點已透過 API 設為上方 Webhook URL
- LINE 官方 webhook test → `{"success":true,"statusCode":200}`
- 模擬簽章 webhook(訊息「水 20」)→ 簽章驗證通過,users/pets/logs/daily_summary 各寫入 1 筆
- 錯誤簽章請求 → 正確回 401
- 測試資料已全部清除(資料庫歸零)

## 尚需手動完成(LINE 後台)

1. LINE Official Account Manager → 回應設定:把「回應方式」切成 **Webhook**
   (目前 webhook `active: false`,聊天模式為 bot/自動回應,切換後機器人才會收到訊息)
2. 建議同時關閉「自動回應訊息」與「加入好友的歡迎訊息」
