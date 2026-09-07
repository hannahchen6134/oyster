# 出報告外框一致性修正（2026-09-07）

範圍：只有 public/index.html 的 CSS、元件標記與顯示狀態。沒有修改資料結構、報告生成、API 路由或 LINE 分享實作。

## 原因與共用容器

五個分頁原本都是同一個 `.shell > #appView` 內的 `.panel`。報告另外用 `.report-mode .shell` 改成 `width:min(920px,calc(100% - 72px))`、`padding-top:36px`，覆蓋手機共用 `.shell` 的 `width:calc(100% - 40px)`、`padding-top:16px`；再以 `.report-mode #reportView {padding:18px}` 重複內縮。

已移除這些報告特例，以及 reportEditor/purposePreview 的額外寬度／min-width 和 report-mode 的切換。既有 #appView 白色背景、頂線、圓角、陰影、左右 padding 都保持同一來源；沒有新建 Shell、固定高度或特別 min-height，繼續沿用自然內容高度（computed min-height: 0px）。html 的 stable scrollbar gutter 讓短／長頁切換不因捲軸出現而橫向移動。

## 元件與節奏

- 選貓 `.pet-options`：兩欄 minmax(0,1fr)，12px gap；`.pet-option` 正常名字 54px 高，長名換行、每列保持等高。不以裁字或縮字處理。
- 標題 18px／500，移除 h2::after 短線。返回至標題 22px、標題至選項 16px、選項至分享列 24px。
- `.accordion` 保留原生 details/summary，整列 52px，SVG 細 chevron 隨 open 旋轉；toggle 同步 aria-expanded，保留 Enter/Space 操作。空資料顯示「目前還沒有已分享的報告」。
- 選貓畫面清除前次清單並呼叫既有清單載入函式，避免切換狀態時顯示空白或上一次的列表；API 與篩選條件不變。
- 共用 `.back-to-line` 上距 36px，共用 `.colophon` 上距 32px；保留同一份頁尾 DOM 與 `.disclaimer-fold`。品牌句允許自然換行，避免放大文字溢出。
- 返回按鈕共用 `.link-btn.back-link`；共用導覽按鈕移除左右 6px 文字內缩，與標題／內容左側對齊。

## 驗證

Chromium 模擬，使用 SQLite 記憶體測試資料，LINE SDK 只模擬 closeWindow，不對真人發訊息。

| viewport | 五個分頁外框邊緣／頂部誤差 | 蚵仔／麵線高度 | 橫向溢出 |
|---|---|---|---|
| 360 | 0px | 54px／54px | 無 |
| 375 | 0px | 54px／54px | 無 |
| 390 | 0px | 54px／54px | 無 |
| 412 | 0px | 54px／54px | 無 |
| 432 | 0px | 54px／54px | 無 |

各尺寸同時比對 radius、shadow、background、padding、min-height、頂線與 footer style，全部相同。主要內容七條左側基準線誤差 0px。

通過整列最右側點擊、Enter、Space、aria-expanded、三貓兩欄換行、長貓名與 200% 文字；也重走選貓、範本、圖片生成、QR 生成、查看既有分享、停用及回 LINE closeWindow。

完整回歸：587/587 通過。360／390／432 今日與出報告模擬截圖、200% 文字截圖、測量 JSON 在本次工作區 outputs/report-shell/。原 HTML 備份為 outputs/index-before-shared-shell.html。

未做 iOS／Android 真人 LINE 發送；本輪發布驗證採靜態檔案 hash、健康檢查及非寫入路由。
