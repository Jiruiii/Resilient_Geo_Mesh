# GitHub Pages 展示版底圖選擇

狀態：設計已由使用者確認。

## 目標

讓 GitHub Pages 手機展示版能像 App 一樣選擇底圖版本，同時維持離線 OSM 備援與展示模式對正式 App 的隔離。

## 使用者可見行為

- 地圖「圖層設定」與「個人」頁面共用既有 `BasemapSelector`，提供既有三種模式與文字：
  - 自動：有網路用圖資，離線用 OSM。
  - 國土測繪圖資：優先用圖資，離線改 OSM。
  - 離線 OSM：只用內建地圖，不連網。
- 展示版預設「自動」。兩個設定入口的選擇即時同步。
- 「自動」及「國土測繪圖資」直接探測既有 NLSC WMTS，啟用時立即探測，之後每 60 秒探測；不可達時顯示內建 OSM。切到「離線 OSM」會停止探測與線上底圖請求。
- 底圖設定只保存在當次頁面記憶體。重設展示情境或重新載入頁面後回到「自動」。
- EMAP 疊在內建 OSM 之上，只切換 raster 圖層可見度，不重載地圖樣式；設施、事件、告警及路線覆蓋層保持原狀。深色展示樣式使用 App 已有的 EMAP 深色濾鏡。

## 架構與限制

- 重用 `MapBasemapMode`、`MapBasemap`、`BasemapSelector`、`MapScreen`、`ProfileScreen` 和 `MapCanvas` 既有介面。
- 狀態及 NLSC 探測由 `ShowcaseApp` 管理；可注入探測函式供 widget 測試使用。
- NLSC 圖磚與探測只由瀏覽器直接連至 `wmts.nlsc.gov.tw`。不新增專案 API、伺服器、依賴或資料服務。
- 本功能屬於使用者已確認的 GitHub Pages 展示版例外：不修改正式 App 的底圖設定、`MapAppController` 或 Android 行為。`MapCanvas` 僅在 `showcaseMode` 路徑新增展示版所需的 EMAP 樣式與可見度控制；一般 App 路徑維持原設定。
- 展示資料、固定時間、告警動畫、路線與頁籤行為不在本功能範圍內。

## 驗收

- Flutter widget 測試涵蓋預設、自動探測失敗、OSM 停止探測、兩個設定入口同步、重設回自動，以及切換底圖時路線仍存在。
- 樣式測試涵蓋展示版淺色與深色 EMAP 圖層及深色濾鏡。
- Web 建置成功；瀏覽器確認三種模式可切換、失去 NLSC 可達性時回到 OSM、OSM 模式沒有 NLSC 請求且圖層／路線仍可用。
- Flutter 分析、相關測試與 Android debug 建置通過；這些檢查不宣稱等同於實機互動驗收。
