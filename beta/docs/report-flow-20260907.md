# 介面減步驟與報告用途拆分

基準：main 0046f7b。實作不含資料庫 migration、後台管理員登入修改或新分享權限。

## 六個入口

| 入口 | 基準行為 | 本輪 |
|---|---|---|
| 記一筆 | message 記一筆 → 常用捷徑／打字提示 → 紀錄 | 保留；需要決定記什麼，非中繼 |
| 近七天紀錄 | message 近七天記錄 → 雙長條資訊卡，可再開趨勢 | 保留；卡片有實際資訊 |
| 出報告 | message 出報告 → 用途 quick reply → visit 七天卡／handoff 當日交班卡 | 改「這次要給誰？」Flex → 對應 LIFF 預覽 |
| 管家後台 | 個人選單 URI 已直接 LIFF；文字指令 website 才回入口卡 | 個人 URI 保留，v9 觸發舊綁定更新；靜態備援改 LIFF |
| 怎麼記 | message 怎麼記 → 可點教學／範例 | 保留；教學是目的內容 |
| 照護月曆 | message 照護月曆 → 當月卡 → 點指定日期 | 保留；日期選擇有必要 |

不能僅憑 repo 判斷真人帳號目前綁了哪個 Rich Menu；上線需另查綁定。v9 在使用者下次送訊息時透過既有 ensurePersonalRichMenu 更新，不是主動群發。

## 報告資料與用途

- 原 API `/me`、`summary`、`highlights`、`weights`、`meds`、`vets`：保留 Bearer session 與 resolveDataOwner/assertPetOwner。
- doctor：主人想說的事 → 最近異常（先5筆）→ 精確體重變化 → 用藥狀態筆數 → 已記錄飲食/水分/熱量變化 → 其他重要紀錄 → 摺疊明細。空區不顯示、不作診斷。
- care：餵食飲水（主人填）→ 用藥設定（可確認）→ 貓咪備註 → 指定醫院聯絡（可補主人聯絡）→ 最多5筆近期觀察，明標為歷史。
- 沒有指定貓的餵食時程，不把家庭共用食物庫或歷史吃40g轉成指示。用藥與醫院只取指定貓設定。
- doctor 沿用 vetAsk 同類文字做初值，報告草稿以 sessionStorage 的 actor/pet/purpose 鍵區隔；不新增資料欄位，跨分頁/裝置不保證保存。
- 單貓直達預覽；多貓先選一次。各次讀取有 revision 與 petId 檢查，慢回應不覆蓋後來選的貓。
- 預設手機閱讀 PNG，A4 為選項。HTML預覽與圖片同一份 sections 資料；先固定 snapshot 再產圖。

## 分享與權限

没有 QR renderer、QR action 或已接通的公開報告頁。schema 的 share_links 不是已完成 QR 功能。本輪不新增公開分享站。

沿用原流程：本機多頁PNG → 系統分享/逐頁長按；傳LINE → 登入後POST /shot → 完整上傳後 sendMessages → shareTargetPicker → 手動多頁圖片。超5頁不截掉後頁。

/shot/id 是長亂數能力連結：持有者可免登入看指定PNG，不能藉此進帳號後台；伺服器6小時後回410，瀏覽器原有private cache最長1小時，已下載圖片不會自動收回。登入URI/token不得放進報告。

## 驗證

- node --test：578/578（原570保留，新增8項用途/六格/授權/圖片存取測試）。
- Chrome本機假資料：11個主流程 + 9個邊界情境；實際Worker API + node:sqlite記憶體DB。
- 已驗證320/390/430/1280無水平溢出、PNG實際1170px寬、A4 2480×3508、長字/換行分頁、空資料、網路錯誤、共照、切貓競態。
- LINE SDK、換登入與傳訊備援為模擬；未發送真人LINE訊息。Android LINE/iPhone Safari、正式選單綁定與實際Cloudflare部署待發布後核對。

## 未納入

不含保姆帳號/任務/勾選/異常回報、新角色、AI判斷、QR分享站、PDF引擎、schema重構、框架更換、Workers付費折線PNG、ADMIN_KEY登入表單硬化。
