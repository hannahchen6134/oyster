# 蚵仔 LINE 後端

這個後端的目的只有一件事：

1. 接 LINE webhook
2. 驗證 LINE 簽章
3. 把文字訊息送到 Apps Script 存進 Google 試算表
4. 用 LINE Reply API 回覆「這次紀錄 + 今日累積總結」

## 環境變數

複製 `.env.example` 後填入：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `APPS_SCRIPT_API_URL`
- `APPS_SCRIPT_API_TOKEN`

## 本機啟動

本機穩定版（會自動重連 tunnel）：

```bash
npm run start:manager
```

只啟動純 LINE 回覆服務：

```bash
node server.js
```

## webhook 路徑

```text
/webhook
```

## 雲端部署

這個資料夾已附上 `render.yaml`，可直接部署到 Render。

- 雲端啟動指令：`npm start`
- 本機自動修復版：`npm run start:manager`

## 架構

- Google Apps Script：資料庫與網站
- Node 後端：LINE 回覆

這樣就不用再讓 Apps Script 直接呼叫 LINE，也不會再卡 Google 的 `UrlFetchApp` 授權頁。
