# 喵喵管家 — 交接報告（給接手的工程師／Codex）

> LINE 紀錄效能第一批：回覆優先、背景維護去重、完整進度差額與匿名 timing。實作、量測判讀及尚未處理的加總競態見 [docs/record-performance.md](docs/record-performance.md)。

> 2026-09-07 最新：以 main 為唯一發布來源；新增照護範本、AI 原句分類及醫生／照護 QR 分享。完整行為與權限以 [docs/report-sharing.md](docs/report-sharing.md) 為準。下方早期『無 LLM／main 落後／QR 未實作』敘述為歷史資訊。

> 這份是「接手前先讀我」。目標：讓你在**不打破現有功能**、**不誤動正式環境**的前提下，
> 能快速看懂架構、找到對的檔案、安全地改與部署。全專案程式與註解以繁中為主。

---

## 0. 一分鐘定位

- **產品**：LINE 上的貓咪日常照護紀錄管家。使用者用自然語言在 LINE 記錄（吃飯／喝水／用藥／
  嘔吐／體重…），系統整理成今日／近七天／回診摘要；完整管理在網站「管家後台」。
- **前台品牌名**：**喵喵管家**（舊全名「喵喵照護安心管家」已逐步收斂）。
- **技術**：Cloudflare **Worker**（V8 isolate，不是 Node）+ **D1**（SQLite）+ **Static Assets**，
  單一 Worker 同時服務 webhook、REST API 與網站。**純 JavaScript ES Modules，無 TypeScript、
  無前端框架、無 LLM**（解析是規則式 regex/keyword）。
- **Repo**：`hannahchen6134/oyster`，所有 Beta 程式都在 **`beta/`** 目錄。
- **線上環境**：Worker 名稱 `cat-care-beta`，網址 `https://cat-care-beta.hannahchen6134.workers.dev`
  （這是 **Beta**；**沒有**獨立的 production worker，詳見 §7 鐵則）。

---

## 1. 開發／測試／部署（最重要，先記這段）

```bash
cd beta
npm install
npm test              # node --test，目前 570 項全綠（55 個測試檔）
npm run deploy        # = npm test && wrangler deploy  ← 正式部署指令（測試沒過不會部署）
npm run dev           # 本機 wrangler dev
```

- **部署一定走 `npm run deploy`**（會先跑測試當閘門）。`deploy:notest` 只在你很確定時用。
- **換行（Windows 注意）**：repo 根目錄有 `.gitattributes` 強制文字檔以 **LF** 檢出，避免 CRLF
  造成字串比對測試誤判。若你**在加入 .gitattributes 前**就已用 CRLF 檢出過，跑一次
  `git add --renormalize . && git checkout -- .`（或重新 clone）把工作區換回 LF，再 `npm test`。
- **憑證**：`CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID` 由環境提供；本機你要自己設定或 `wrangler login`。
- **機密（絕不寫進 repo）**：用 `wrangler secret put`：
  - `LINE_CHANNEL_SECRET`（webhook 驗簽＋權杖自動換發）
  - `LINE_CHANNEL_ID`（設了就啟用權杖自動換發，永不因過期斷線）
  - `LINE_CHANNEL_ACCESS_TOKEN`（固定權杖，備援）
  - `ADMIN_KEY`（後台 `/admin/*` 用；至少 8 碼，否則後台一律關閉）
- **非機密設定**在 `wrangler.toml` 的 `[vars]`：`LIFF_ID`、`LIFF_CHANNEL_ID`、`APP_BASE_URL`。
- **D1**：`wrangler.toml` 綁定 `DB`；`npm run db:init`（remote）初始化 schema。**遷移是手動**
  （`wrangler d1 execute cat-care-beta --remote --file=./migrations/00xx_*.sql`）。

### Git 慣例（這份專案特別要注意）
- 開發分支：`claude/cat-care-bot-deploy-df6jy4`，且需**同步鏡射**到 `claude/continue-0t38um`
  （兩個都要 push）。過去的部署是**直接用目前分支的工作區部署**（wrangler 部署的是本機檔案，
  不是某個 git 分支），所以 **`main` 目前落後於分支**：**線上＝分支最新，不是 `main`**。
  接手後若要恢復「main＝線上」的習慣，先把 main 快轉到分支再說（見 §7）。

---

## 2. 檔案地圖（`beta/`）

```
src/
  index.js     (3737 行) 入口：fetch(webhook/API/網站/admin)、scheduled(cron)、
                          事件分派、handleTextMessage / handlePostback / handleRecord、
                          每人專屬圖文選單 ensurePersonalRichMenu、/shot /export /admin/*
  parser.js    (1154 行) 規則式自然語言解析（唯一「看懂人話」的地方，無 LLM）
  flex.js      (1648 行) 所有 LINE Flex 卡片（含 weekFlex 近七天卡）
  db.js        (1148 行) D1 存取（軟刪除、daily_summary 重算、app_kv、邀請碼／登入碼／限流）
  api.js       (794 行)  網站用 REST API（/api/*）
  replies.js   (484 行)  純文字回覆與備援文案
  summary.js   (298 行)  每日摘要計算、buildHandoff、食物欄位推導（真源，勿另立第二套）
  line.js      (225 行)  LINE Messaging API：驗簽、reply/push、權杖自動換發、loading 動畫
  reminders.js (124 行)  照護提醒
  util.js      (106 行)  時間(台北)、ID、加密級亂數、constantTimeEqual、體重格式
  brand.js     (23 行)   品牌字串唯一真源（BRAND.name/site/tagline…）
  plan.js      (57 行)   封閉測試門檻文案
public/         網站（單一 index.html 309KB + a4-report.js + html-to-image.js + richmenu.png）
richmenu/       圖文選單設計稿與工具（richmenu.html 設計、render.mjs 渲染、create-rich-menu.mjs 靜態備援、week-preview.html 示意）
migrations/     0002–0015，手動套用
test/           55 個檔、570 項（node --test；用 node:sqlite 記憶體 DB 跑真正的 db.js）
docs/, PRODUCT.md, README.md, CHECKLIST.md, VERIFICATION.md  背景與規格
schema.sql, wrangler.toml, package.json
```

---

## 3. 資料流（一定要先在腦中有這張圖）

```
LINE 使用者打字
  → /webhook（index.js）：verifyLineSignature 驗簽（HMAC-SHA256）
  → processWebhookEvents：事件去重（webhookEventId / message.id）
  → 1:1 文字時先 showLoadingAnimation（免費「處理中…」動畫）
  → handleTextMessage：Beta 門檻（source.type==='user' + betaAccess）→ parseMessage
  → 依 intent：handleRecord（寫入 logs + 重算 daily_summary）或 query 分派（today/week/visit/…）
  → 以 Flex 卡片 reply（replyOrPushFlex：reply 優先、push 備援、再退純文字）
```

網站（管家後台）：LIFF/登入碼登入 → `/api/*` 讀寫同一個 D1 → 完整管理、歷史、圖表、報告。

---

## 4. 不可違反的鐵則（踩到會出事）

1. **不要動正式環境**：只有 `cat-care-beta` 這個 Beta worker。除非使用者**明確**授權，
   不要建立／部署 production，不要跑不可逆的 D1 遷移。要遷移前先把「內容＋原因＋rollback」講清楚。
2. **schema 不要亂改**：沒有被證明必要就不要加欄位／改結構；要改先問。遷移是手動、逐檔套用。
3. **解析安全原則**：**能確定才寫入**。只認得到貓、後面無法可靠解析時，走既有 partial／確認機制，
   **不要猜、不要寫錯資料**（healthcare 資料）。
4. **體重顯示**：一律用 `util.js` 的 `formatWeightKg`（最多兩位小數、去尾 0、**嚴禁 toFixed(1)/
   四捨五入到一位**）。`public/index.html` 與 `public/a4-report.js` 是瀏覽器包、無法 import，
   各自保留同規則複本——改規則要三處一起改。
5. **家庭資料隔離**：跨使用者資料用 `assertPetOwner` / `resolveDataOwner` 檢查；別繞過。
6. **機密只用 `wrangler secret`**，不要進 repo；`ADMIN_KEY` < 8 碼後台會自動關閉。
7. **LINE 優先 reply（免費）**，push 才計費且有月額度；reply token 有效期約 60 秒。
8. **回覆別破版**：Flex 卡片改動後跑 `npm test`，很多測試會斷言卡片字串／結構。
9. **不要為了讓測試綠燈刪測試**；文案改了就同步改對應斷言（見 §8 陷阱）。

---

## 5. 幾個「你一定會踩到」的實作細節

- **圖文選單有兩份定義**：
  - **權威版＝每人專屬**：`index.js` 的 `ensurePersonalRichMenu()`，把本人登入連結烤進選單，
    圖片用 `public/richmenu.png`。**改版流程**：改 `richmenu/richmenu.html` →
    `node richmenu/render.mjs`（用預裝 Chromium 渲染成 2500×1686 PNG 覆蓋 `public/richmenu.png`）→
    改 `ensurePersonalRichMenu` 的送出字 → **把 `RICHMENU_VERSION` +1**（版本號一改，所有人下次
    互動就自動重建到新選單）。目前是 **v8**。
  - **靜態備援**：`richmenu/create-rich-menu.mjs`（很少用，改版時順手同步版面即可）。
  - 目前六格與送出字：記一筆→`記一筆`、近七天記錄→`近七天記錄`(week)、出報告→`出報告`(report)、
    管家後台→URI(網站)、說明・怎麼記→`怎麼記`、照護月曆→`照護月曆`(calendar)。
- **「照護站」是 parser 指令關鍵詞**（`website` 查詢）。前台顯示已更名為「管家後台」，但
  **按鈕送出的指令字仍相容「照護站」**；parser 另加了「管家後台/開啟管家後台/後台」。
  改顯示名 OK，**千萬別改到送出的指令字**，否則按鈕會失效。品牌字集中在 `src/brand.js`。
- **app_kv 這張 KV 表**扛很多東西：LINE 權杖快取、`defaultFood:*`、`foodAlias:*`、`logincode:*`、
  `invite:*`、限流 `rl:*`、後台 cookie `adminsess:*`、選單快取 `menu:*`。
- **測試 harness**：`test/*.mjs` 用 `node:sqlite` DatabaseSync 建記憶體 DB，SCHEMA 由
  `schema.sql` + 需要的 migration（常見 0012_app_kv、0010_beta_access）串接而成。新測試若用到
  新表／欄位，記得把對應 migration 併進該檔的 SCHEMA。`handleTextMessage` 已 export 供端對端測試，
  但要通過需 `event.source.type==='user'` 且該 user `betaAccess=1`。

---

## 6. 這一輪（LINE 體驗改版）已完成、且已上線的內容

依序 commit（分支 `claude/cat-care-bot-deploy-df6jy4`）：
- **資安強化**：登入碼／邀請碼改加密級亂數＋兌換端限流；`/admin/*` 改 cookie session（金鑰不再掛
  網址）＋定時比對。（`util.js` randomDigits/randomFromAlphabet/constantTimeEqual、db.js rateLimited、
  index.js adminAuth）
- **品牌收斂**：喵喵照護安心管家 → **喵喵管家**（brand.js、網站 title、文案）。
- **入口更名**：照護站 → **管家後台**（僅使用者可見文字；指令字相容保留）。
- **處理中→已記錄**：`line.js showLoadingAnimation`（LINE 官方 loading API，免費、不算訊息、
  1:1 有效、失敗吞掉不擋回覆），在 webhook 收到文字時先亮。
- **新圖文選單 v8**＋**出報告入口**（`report` 查詢：先問就醫／照護，就醫→既有 `visit`、
  照護→既有 `handoff`）。
- **近七天卡**：改為**每日水分＋熱量雙長條**，並用**溫和大地色**（水分＝柔沙綠 `#7C9070`、
  熱量＝暖陶土 `#C08E5E`）；底部按鈕一鍵開後台折線圖頁。
- **報告資料來源**：喵喵照護站 → 喵喵管家（a4-report.js／index.html）。

---

## 7. main 與部署（main 為主）

- **`main` 已與最新開發成果對齊**，是**線上程式的真實來源**（本輪 LINE 體驗改版全部已合併進 main）。
- **慣例（產品負責人指定）**：完成的工作**整理／合併回 `main`**，**部署從 `main`**：
  ```bash
  git checkout main && git pull origin main
  cd beta && npm run deploy        # = npm test && wrangler deploy
  ```
- ⚠️ `wrangler deploy` 部署的是**當下工作區的檔案**（不是某個 git 分支名）——所以部署前務必先
  `git checkout main` 並 `git pull`，確認工作區就是 main 最新，再 deploy。
- 歷史備註：開發期間曾在 `claude/cat-care-bot-deploy-df6jy4`（鏡射 `claude/continue-0t38um`）上進行；
  現已整理回 main，之後以 main 為準即可。

---

## 8. 已知限制／未完成／給 Codex 的注意事項

1. **「近七天在 LINE 直接看折線圖圖片」尚未整合**。技術已驗證可行（`@resvg/resvg-wasm`
   把伺服器端 SVG 光柵化成 PNG，成品幾乎等同後台），但**每次渲染約 180ms CPU，超過 Workers
   免費方案 10ms 上限**，需 **Workers Paid（US$5/月）**。目前的免費備案是：LINE 顯示雙長條卡，
   想看折線圖點底鈕開後台趨勢頁。若之後升級付費要做，元件是 `@resvg/resvg-wasm` + 一個
   **子集化 CJK 字型**（別整包 wqy-zenhei，太大）。這是刻意未做，不是 bug。
2. **出報告用途已拆分（本機修改，部署狀態另查）**：`report` 回覆「這次要給誰？」Flex，兩個 URI 直接前往 LIFF `go=doctor`／`go=care`。
   就醫摘要保留 7／14／30 天、預設 14 天；照護說明由既有用藥／貓咪／醫院設定加主人確認文字組成，不從歷史紀錄推導指示。
   `public/report-purpose.js` 整理用途內容，`public/a4-report.js` 共用手機圖片／A4 分頁與原分享管線。細節見 `docs/report-flow-20260907.md`。
3. **文案／字串測試很嚴**：改 Flex 卡片或指令關鍵詞時，`teaching-consistency`、`food-brand-hint`、
   `pet-selection`、`richmenu-routing`、`brand-naming`、`week-chart` 等會斷言字串／顏色，改文案要
   同步改測試（但別為了綠燈刪掉有意義的測試）。
4. **`richmenu/render.mjs` 需要 `playwright-core`**（用預裝 Chromium：
   `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）。它是設計工具、**不是** app 執行期依賴，
   沒有列進 package.json；要重畫選單時 `npm i -D playwright-core` 再跑。
5. **CJK 字型**：機器上有 `wqy-zenhei.ttc` 可作子集化來源；`pyftsubset`/fonttools 未安裝（要先裝）。
6. **時間**：一律台北時間（`util.js` 用 UTC+8 位移，台灣無日光節約）。
7. **多貓家庭**：記錄前可能要先選貓（既有流程），別另立一套。
8. **後台登入仍需在 `/admin/login` 網址帶一次 `?key=`**：成功後換發 cookie，之後所有導覽／切換
   都免帶金鑰（金鑰只在**登入那一次**出現在網址）。**目前沒有**「把金鑰打進表單、完全不進網址」
   的 POST 登入頁——這是可選硬化項（未來可加 `GET /admin/login` 顯示表單 + `POST` 驗證設 cookie）。
   不影響現有安全性：cookie 為 HttpOnly/Secure/SameSite、`?key=` 以 constant-time 比對，且 `?key=`
   僅作 curl/JSON 端點的相容後路。

---

## 9. 建議接手第一步

1. `cd beta && npm install && npm test`（確認 570 綠）。
2. 讀 `README.md`、`PRODUCT.md`、本檔，掃一遍 `src/index.js` 的 fetch 與 `handleTextMessage`。
3. 確認 `main`／線上落差（§7），決定要不要先把 main 對齊。
4. 任何改動：**先寫／改測試 → `npm test` 綠 → `npm run deploy`**；別跳過測試閘門、別碰 production。

有背景脈絡在 `docs/`（付費方案、使用說明、資料備份與復原、LINE OA 介紹）與 `PRODUCT_ANALYSIS.md`。

### 2026-09-07 介面流程與報告修改補充
- 本輪六格圖片與標籤不變，個人選單版本為 v9；原本已是 LIFF URI 的後台入口保持直開，備援選單改讀同一個 LIFF 設定。
- 本機完整測試 612 項通過；先前的 570 是交接時基準。
- 高頻操作 MVP：記一筆及完成確認卡使用八類型 Quick Reply（主食／乾乾／乾糧／零食／水／藥／尿尿／便便）。類型按鈕不再帶入歷史份量或用藥結果；新版以 openKeyboard + fillInText 預填關鍵字，送出後沿用 parser；amount 等待僅相容舊卡片、多貓沿用 pendrec。完整現況、後台依賴及 25 項驗收見 `HIGH_FREQUENCY_UX.md`；本輪不做後台隱藏或另一套 Rich Menu。
- 編輯中的報告暫存於 sessionStorage（使用者／貓咪／用途分開）；按「存為範本」會存入既有 app_kv，依主人與貓咪隔離。再次開啟照護報告時自動帶入範本，當次草稿優先，不修改原始照護設定、不新增 DB schema。
- 照護編輯頁沿用共用 Shell，先顯示已有用藥、注意事項、指定醫院及範本內容；主人只補充這次不同的安排。最近吃喝與用藥透過既有 recent API 取得，明確列為歷史參考，不推論未來份量或用藥指示。
- **LINE 出報告目前流程**：先選貓，再選給醫生／給照護者，直接回報告 PNG（長文分頁）＋ QR Code PNG ＋閱讀連結，不再把出報告入口導向 LIFF 後台。醫生固定近 14 天；照護沿用該貓設定／範本。缺少餵食、餵藥方法或相處習慣時，只詢問缺項，可直接在 LINE 補充或到後台補範本；不再提供「先出已有資料」。資料完整後直接出圖。
- `src/line-reports.js` 管理 30 分鐘有效的流程、權限、重試與分批傳送；`src/report-renderer.js` 用官方 `@cloudflare/puppeteer` 搭配 `REPORT_BROWSER` 產圖。QR 與圖片共用不可變報告快照，7 天有效、可提前停用，沒有新增 DB schema。圖片以既有 app_kv 保存，cron 清除過期圖片。
- Browser Run 目前免費方案有每日 10 分鐘配額及啟動速率限制；耗盡或產圖失敗會回 LINE 重試按鈕，不假稱已成功。未切換付費方案。此途徑不使用先前受 Worker CPU 限制的 resvg。
- 驗證：595 項測試、實際 Cloudflare Browser 產出中文長文 3 頁＋QR、QR 解碼及全文分頁比對通過；測試資料未寫入線上 D1，也未向真實客戶發測試訊息。套件 audit 的 extract-zip 警示屬本機瀏覽器安裝工具依賴，Worker bundle 不含該解壓程式，沒有執行下載解壓。
- 程式修改與驗證不代表已部署；部署仍從 main，須另外取得本次發布授權。

---

## 10. 帳號與設定交接清單（**不在 repo 裡**，接手一定要另外取得）

> 下面只列「需要什麼、在哪裡設定」，**不放任何金鑰內容**。金鑰值請由擁有者透過安全管道交付，
> 或直接輪替後交付新值。

### 10.1 Cloudflare（執行環境）
- 帳號登入權（能進 Dashboard → Workers & Pages、D1）。
- Worker：`cat-care-beta`。網址 `https://cat-care-beta.hannahchen6134.workers.dev`。
- D1 資料庫：名稱 `cat-care-beta`，`database_id` 已在 `wrangler.toml`。**正式資料在這裡**。
- 部署用憑證：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（本機/CI 部署要）。
- **方案**：目前免費即可運作；「近七天在 LINE 直接出折線圖圖片」需升級 **Workers Paid（US$5/月）**（見 §8-1）。
- 備份/復原流程：`beta/docs/資料備份與復原.md`；`ops/backup-workflow.yml` 有備份工作流參考。

### 10.2 LINE（前台通道）
- **官方帳號（OA）**：basicId `@232mjffx`——需要 OA 管理權（名稱、大頭貼、好友訊息）。
- **Messaging API channel** 的三個機密（見 §1，存 wrangler secret）：
  `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ID`、`LINE_CHANNEL_ACCESS_TOKEN`。
- **Webhook URL**：`https://cat-care-beta.hannahchen6134.workers.dev/webhook`（在 LINE Developers 設定、需開啟 Use webhook）。
- **LIFF app**：`LIFF_ID = 2010761895-7VsJuJ3C`（`wrangler.toml`），所屬 Login channel `LIFF_CHANNEL_ID = 2010761895`。
  - ⚠️ LINE 內建瀏覽器上方標題顯示的名稱是 **LIFF app 名稱**（在 LINE Developers Console 設定，
    **不在程式碼**）。目前仍是舊名「喵喵照護安心管家」，要在 Console 改成「喵喵管家」。

### 10.3 測試者後台 `/admin/*`（就是你在用的那個後台網頁，已在本 repo `src/index.js`）
- 頁面：`/admin/testers`（測試者開通/關閉＋留存/使用數據，一頁看）、
  `/admin/metrics`（JSON 彙總）、`/admin/line-token`（權杖健康檢查）。
- 用 `ADMIN_KEY`（wrangler secret，≥8 碼）保護。**登入方式**：先開一次
  `/admin/login?key=<ADMIN_KEY>` → 換發 HttpOnly/Secure/SameSite cookie（8 小時），之後導覽免帶金鑰。
  ⚠️ 金鑰**只在登入那一次**出現在網址；目前**無**「金鑰完全不進網址」的 POST 表單登入（見 §8-8，
  屬可選硬化項）。`?key=` 也保留為 curl/JSON 端點的相容後路，但會把金鑰留在網址（瀏覽記錄/日誌），少用。
- **輪替金鑰**（洩漏或定期）：`cd beta && wrangler secret put ADMIN_KEY`（輸入新值）→ 立即生效、舊金鑰即刻失效。
  ⚠️ 金鑰**絕不要貼進聊天、網址分享或截圖**；要傳連結請用 `/admin/login` 拿 cookie 後的乾淨網址。

### 10.4 GitHub
- Repo：`hannahchen6134/oyster`（Beta 程式在 `beta/`）。
- 分支：開發 `claude/cat-care-bot-deploy-df6jy4`（鏡射 `claude/continue-0t38um`）；`main` 見 §7。

### 10.5 交接時要做的動作（建議）
1. 轉移或重設上述各平台的存取權（Cloudflare、LINE Developers、GitHub、OA 管理）。
2. **輪替所有 wrangler secret**（`LINE_*`、`ADMIN_KEY`），用新值交付，避免沿用舊值。
3. 確認 D1 有在備份（§10.1）。
4. 決定 Workers 方案（是否升級付費以啟用 LINE 折線圖圖片）。

- 2026-09-07：更多紀錄選單使用 app_kv 原子 UPSERT 合併每位使用者 3 秒內的連續事件；既有 webhookEventId 去重保留。不擋實際紀錄，無 schema 變更。新增重送、併發、冷卻後重開及 reply 失敗 push 備援測試。截圖所示歷史重複發送來源未由伺服器歷史日誌確證。

- 報告入口相容：給醫生看／就醫報告／就醫使用／照護報告／照護使用／給照護者統一進 LINE 選貓、選用途及圖片與 QR 流程。回診、看診、交班原摘要保留。LINE 端預設與舊個人選單需實際重綁，僅部署 Worker 不會更新既有 LINE 選單。

- 2026-09-07 報告補齊：醫生版用原 buildA4Report 版型與相同彙總定義顯示體重／水分／熱量趨勢、組成、回診重點與每日明細；分享快照保留經白名單清理的 doctorSource，QR 網頁同樣顯示。照護版安排優先、歷史最後；LINE 補充經規則分類、確認後存範本，未補齊繼續只問缺項。報告完成卡可補充照護說明，更新後使用新報告 ID，舊 QR 快照保持不變。

- 2026-09-07 醫生按鈕無回應修正：產图前先 reply 告知整理中，完成圖片與錯誤走 push，不重用 replyToken。雲端截圖改單次全頁 PNG、瀏覽器內逐頁裁切，避免逐頁 CDP 截圖耗時；總產圖等待 20 秒即明確失敗並可重試，逾時關閉瀏覽器。真實 Browser Run 合成 14 天醫生資料成功：7 張報告＋QR，約 15 秒；無真實客戶訊息發送。

- 摘要介面減法：使用者可見「報告」統一為「摘要」，選貓提示「需要分享哪隻貓的摘要？」；舊文字指令仍相容。v10 圖文選單第三格改為 reportStart postback，直接啟動選貓，不經文字關鍵字回覆。醫生預覽／PNG／QR 共用既有 buildA4Report，不再另加重複文字摘要。照護預設單一補充框、一次整理並儲存，逐欄編輯及預覽收合。
