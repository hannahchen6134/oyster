# Oyster Care Cloudflare Worker

這個資料夾是第 1 階段的 Cloudflare Workers 版 LINE webhook。

目標：

- 先穩定接住 LINE webhook
- 先回一則 `已收到，整理中...`
- 再背景寫入目前的 Apps Script / Google 試算表
- 最後用 push 補送真正的每日總結

## 需要的環境變數

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `APPS_SCRIPT_API_URL`
- `APPS_SCRIPT_API_TOKEN`
- `EARLY_ACK_TEXT` 可選

## 本機開發

1. 安裝套件
2. 複製 `.dev.vars.example` 成 `.dev.vars`
3. 填入實際值
4. 執行 `npm run dev`

## 部署

1. `npm install`
2. `npx wrangler login`
3. 設 secrets
   - `npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN`
   - `npx wrangler secret put LINE_CHANNEL_SECRET`
   - `npx wrangler secret put APPS_SCRIPT_API_URL`
   - `npx wrangler secret put APPS_SCRIPT_API_TOKEN`
   - 如果要改提示字，再加 `npx wrangler secret put EARLY_ACK_TEXT`
4. `npm run deploy`
5. 把 LINE Developers 的 webhook URL 改成部署後的 Worker 網址

## 跟現在 Render 版的差異

- Render 免費版會睡眠，Workers 不會用同樣方式冷啟動
- Workers 會先快速回 LINE ACK，再背景處理
- 這對免費方案下的回覆穩定性會好很多
