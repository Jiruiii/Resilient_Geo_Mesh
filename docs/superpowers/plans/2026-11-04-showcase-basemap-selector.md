# GitHub Pages 展示版底圖選擇 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task after user review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitHub Pages 手機展示版加入與 App 一致的三種底圖選擇、NLSC 探測及離線 OSM 備援。

**Architecture:** `ShowcaseApp` 持有當次頁面的底圖模式與可達狀態，並將同一狀態傳給地圖與個人設定頁。沿用現有 `MapBasemap`、`BasemapSelector` 和 MapLibre raster 圖層，只讓 `showcaseMode` 載入 EMAP 並套用可見度；一般 App 的底圖控制流程不變。

**Tech Stack:** Flutter/Dart、MapLibre、Flutter widget tests、GitHub Pages Flutter Web build。

**Spec:** `docs/superpowers/specs/2026-11-04-showcase-basemap-selector-design.md`

## Global Constraints

- 展示版預設「自動」；模式名稱與說明沿用 `MapBasemapMode` 現有文字。
- 自動與國土測繪圖資模式啟用時立即探測 NLSC，之後每 60 秒探測；探測失敗時顯示內建 OSM。
- 離線 OSM 模式停止 NLSC 探測與底圖請求。
- 模式只保存在展示頁記憶體；重設或重新載入回到自動。
- 不新增專案 API、伺服器、套件或資料服務；線上圖資僅使用既有 `wmts.nlsc.gov.tw`。
- 這是使用者已確認的 GitHub Pages 展示版例外；不得改動正式 App 的 `MapAppController`、偏好儲存或 Android 行為。
- 切換底圖不得重載 MapLibre 樣式或清除設施、事件、告警及路線圖層。

## Review Focus

- NLSC 探測回傳 false 或丟出錯誤時，選中的網路模式仍顯示 OSM 及離線狀態。由 Task 1 的 false 與 thrown error widget tests 鎖定。
- 切到 OSM 後經過一個 60 秒週期不得再探測；切回自動後立即恢復探測。由 Task 1 的計時 widget test 鎖定，並在 Task 3 瀏覽器網路檢查確認沒有 NLSC 請求。
- 從地圖圖層設定或個人頁選擇後，另一入口都應顯示相同模式。由 Task 1 的入口同步 widget test 鎖定。
- 重設展示情境應回到自動並重新探測。由 Task 1 的重設 widget test 鎖定。
- 底圖切換不得關閉已開啟路線；展示版深色 EMAP 應使用深色濾鏡。分別由 Task 1 路線 widget test 與 Task 2 樣式測試鎖定。

---

### Task 1: 展示版底圖狀態、探測與設定入口

**Files:**
- Modify: `flutter/lib/showcase/showcase_app.dart`
- Test: `flutter/test/showcase_app_test.dart`

**Interfaces:**
- `ShowcaseApp` 可選接收 `EmapReachabilityProbe? basemapProbe`，正式執行預設使用 `MapBasemap.probeEmap`。
- `_ShowcaseAppState` 管理 `MapBasemapMode _basemapMode`、`bool? _emapReachable`、60 秒探測 timer 與 `_setBasemapMode(MapBasemapMode)`。
- 地圖頁與個人頁接收相同的模式、`MapBasemap.emapVisible(...)` 結果及 `_setBasemapMode` callback。

- [ ] **Step 1: 寫出失敗的 widget tests**

在 `showcase_app_test.dart` 加入測試，使用可控制結果的注入探測函式，涵蓋：初始自動模式；從個人頁選擇後地圖圖層面板同步、反向選擇也同步；探測回傳 false 或丟出錯誤時，選單仍保留所選模式但狀態顯示離線 OSM；切到 OSM 後推進超過 60 秒不再呼叫探測、切回自動立即探測；重設回自動並再次探測；已開啟的逃生路線在選擇底圖後仍顯示。

- [ ] **Step 2: 執行新測試確認先失敗**

Run: `cd flutter && flutter test --no-pub test/showcase_app_test.dart`
Expected: 新增的 selector 狀態與探測測試因展示頁尚未接線而失敗；既有告警及路線測試仍可執行。

- [ ] **Step 3: 在 ShowcaseApp 接上底圖狀態與 NLSC 探測**

加入可注入的探測函式；初始化與情境重設時設回自動並立即探測；每 60 秒重新探測；每次模式改變時淘汰舊探測結果，避免異步結果覆蓋新選擇；OSM 模式取消 timer 且不發起探測。將同一模式、可見狀態及 callback 傳給 `MapScreen` 與 `ProfileScreen`。

- [ ] **Step 4: 重跑展示版 widget tests**

Run: `cd flutter && flutter test --no-pub test/showcase_app_test.dart`
Expected: 新增的底圖狀態、探測週期、同步、重設與路線保留測試及原有展示版測試皆通過。

### Task 2: 展示版 MapLibre EMAP 圖層與深色樣式

**Files:**
- Modify: `flutter/lib/widgets/map_canvas.dart`
- Modify: `flutter/lib/data/offline_map_asset_store.dart`
- Test: `flutter/test/map_basemap_test.dart`

**Interfaces:**
- `MapCanvas._loadStyle` 對展示版呼叫 `OfflineMapAssetStore.loadStyle(..., includeEmap: true)`。
- `MapCanvas._applyEmapVisibility` 以 `MapRuntimeState.emapVisible` 控制既有 EMAP raster layer；OSM 保留為底層。
- `OfflineMapAssetStore.loadStyle` 對 `assets/map/styles/showcase-dark.json` 使用和 App 深色樣式相同的 EMAP 濾鏡。

- [ ] **Step 1: 寫出展示版淺色與深色樣式測試**

在 `map_basemap_test.dart` 載入 `showcase-light.json`、`showcase-dark.json`，確認 `includeEmap: true` 時各只有一個 NLSC layer，淺色 paint 為空、深色 paint 含既有亮度反轉與 180 度色相旋轉，OSM source 保留。

- [ ] **Step 2: 執行新樣式測試確認深色案例先失敗**

Run: `cd flutter && flutter test --no-pub test/map_basemap_test.dart --plain-name "showcase styles include EMAP with the matching theme paint"`
Expected: 深色展示樣式尚未套用 EMAP 濾鏡，測試失敗。

- [ ] **Step 3: 只為展示版啟用 EMAP 樣式與可見度控制**

將 showcase 的 `includeEmap` 設為 true；允許 `showcaseMode` 的 `_applyEmapVisibility` 執行；在 `OfflineMapAssetStore` 將 `showcase-dark.json` 識別為深色樣式。一般 App 的樣式載入與 controller 流程保持原樣。

- [ ] **Step 4: 執行底圖與地圖互動回歸測試**

Run: `cd flutter && flutter test --no-pub test/map_basemap_test.dart test/map_interaction_test.dart`
Expected: 標準 App 與展示版樣式、既有圖層互動及底圖選擇測試通過。

### Task 3: Pages 使用說明與整體驗收

**Files:**
- Modify: `docs/github-pages-showcase.md`

- [x] **Step 1: 更新 Pages 說明**

說明展示版預設自動、地圖圖層設定和個人頁可切換、自動／圖資模式的 NLSC 連線與 OSM 備援、OSM 不連線及重設後回到自動；明確指出不連接專案 API 或後端。

- [x] **Step 2: 執行 Flutter 靜態分析與相關測試**

Run: `cd flutter && flutter analyze --no-pub && flutter test --no-pub test/showcase_app_test.dart test/map_basemap_test.dart test/map_interaction_test.dart`
Expected: analyzer 無問題，相關測試全數通過。

- [ ] **Step 3: 建置 Android debug app 回歸編譯**

Run: `cd flutter && flutter build apk --debug --no-pub`
Expected: 建置成功；展示模式啟用條件仍限定 Web 的 `SHOWCASE_MODE`，一般 Android 啟動路徑不變。

Result: 已嘗試建置；Gradle 在編譯專案程式前因既有 `maplibre_gl` 0.27.1 腳本呼叫 `kotlin.compilerOptions`，而目前生成的 Android 專案套用 Kotlin Gradle Plugin 1.8.22，發生 API 不相容。為維持 Android 專案設定不變，本次未修改 Gradle 或套件版本。

- [x] **Step 4: 建置 GitHub Pages Flutter Web 版本**

Run: `cd flutter && flutter build web --release --no-pub --no-web-resources-cdn --pwa-strategy=none --base-href /Resilient_Geo_Mesh/ --dart-define=SHOWCASE_MODE=true`
Expected: 建置完成，輸出位於 `flutter/build/web`。

- [x] **Step 5: 在瀏覽器驗收底圖與覆蓋層**

使用 `npm run dev`（若 8767 已被使用，先關閉舊的開發伺服器或改用空閒連接埠）開啟展示版。確認 MapLibre 載入成功；兩個設定入口同步；三種模式可選；NLSC 不可達時回到 OSM；OSM 模式的瀏覽器網路面板沒有 NLSC 請求；醫院、避難所、告警及逃生路線仍顯示且切換底圖不會關閉路線。

