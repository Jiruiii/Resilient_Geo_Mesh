# 地圖覆蓋控制與資料更新時間設計

日期：2026-10-18

狀態：已實作；需求相關驗收通過，Flutter 全量測試仍有兩項無關失敗

## 目標

調整地圖首頁的輔助資訊與避難情境控制，並讓 Web 與 Flutter/Android 顯示同一套已驗證靜態資料更新時間。

已確認的需求：

- 移除左下角 MapLibre attribution 的「i」按鈕外觀。
- 避難情境控制移至左下角，並可展開與收合。
- 左上角不再顯示全臺院所／避難所數量，改顯示最新資料更新時間，格式如 `2026/09/3 10:00:32`。
- Web 與 Flutter/Android 同批完成。

## 方案與取捨

1. 只改畫面：Android 目前沒有把資料時間交給 Flutter，因而只能在 Web 顯示時間。此方案會造成兩端資訊不一致，捨棄。
2. 將已驗證圖層時間納入 Android bridge 契約，並在兩端用同一格式呈現。這會觸及 repository、MethodChannel、Flutter model/controller 和地圖 UI，但保持現有資料驗證責任邊界；採用此方案。
3. 另開一次 Android bridge 呼叫只取時間。這會重複載入或讀取同一組圖層，增加同步與錯誤處理分支，捨棄。

地圖來源資訊不會隨按鈕一起消失：保留 MapLibre/圖層所需的 attribution，以右下角縮放控制內可點擊的文字呈現。將原生 attribution 按鈕移至右下角控制覆蓋區下方，左下角不再顯示圓形「i」。

## 畫面行為

### 左上角狀態卡

- 移除「全臺院所／避難所」數字及其載入中版本。
- 顯示 `最新更新資料：yyyy/MM/d HH:mm:ss`。例如 `2026/09/3 10:00:32`；月份補零，日期不補零，時分秒補零。
- 將已驗證清單的 RFC 3339 時間轉成台灣時間（UTC+8）後格式化，不依賴裝置目前時區。
- 靜態資料驗證中時顯示 `最新更新資料：載入中`；驗證完成但沒有有效時間時顯示 `最新更新資料：無資料`。失敗狀態沿用目前的未驗證資料提示，不以未驗證資料推算時間。
- 保留事件數與目前位置狀態。事件標記仍遵守現有規則：靜態資料驗證期間不顯示，驗證完成或失敗後才顯示。

### 左下角避難情境

- 移除目前位於搜尋列下方的情境 ActionChip，改在地圖左下角顯示。
- 初始為展開狀態，呈現目前情境與收合控制；收合後顯示白底圖層設定圖示與獨立展開箭頭。點圖示開啟圖層設定，點展開箭頭恢復情境控制。
- 點擊情境內容仍開啟現有圖層設定面板；選擇情境的路由與篩選行為不變。
- 使用 SafeArea，並沿用目前在通報選點或通報表單開啟時隱藏情境控制的規則；其他情境沿用現有可見性。

### Attribution 與右下角控制

- 左下角不再呈現 MapLibre「i」按鈕。
- 右下角縮放控制內顯示 `© OpenStreetMap contributors · Protomaps`，以可點擊文字開啟地圖來源與授權說明。
- 同時調整 MapLibre attribution button 的位置，避免原生按鈕回到左下角；自訂文字必須清楚可見且可操作。

## 資料與跨端介面

- Web 延用 `loadNLSCStaticLayers()` 已驗證 manifest 的 `created_at`，取避難所、醫療院所及醫療院所目錄圖層中最新的有效時間。
- Android 的 `MeshRepository` 在載入同一組已驗證圖層時保留各 manifest 的 `created_at`，只從成功驗證的圖層計算最新時間。此處不包含 OSM 道路/POI 圖層。
- Android `getStaticFeatures` MethodChannel 回覆新增 `snapshot_at`，原有 `static_features` 欄位與驗證流程不變。
- Dart bridge/controller 將 `snapshot_at` 放入既有 `StaticFeatureCollection`；MapScreen 用同一格式器顯示。不可因 timestamp 欄位缺少而回退到未驗證預覽資料。
- 所有時間欄位仍以來源 manifest 的簽署內容為準，不新增伺服器欄位或資料庫遷移。

## 範圍

預計修改：

- Android：`MeshRepository`、`FlutterMapBridge`、`MapBridgeProtocol` 及相關 protocol/repository 測試。
- Flutter：`map_bridge.dart`、`map_app_controller.dart`、`display_time.dart` 或新的靜態資料時間格式器、`map_screen.dart`、`map_canvas.dart`、`map_zoom_controls.dart` 及相關測試。
- Web：既有靜態圖層載入器使用簽署 manifest 時間來源，按時間點而非字串排序挑選最新時間；共用 Flutter 畫面負責格式化與呈現，不另建資料請求。

不改變事件同步、設施驗證、避難路徑篩選或資料來源。

## 驗收條件

1. Web 與 Flutter/Android 左上角都不顯示全臺院所／避難所數字，且顯示最新資料時間。
2. RFC 3339 `2026-09-03T02:00:32Z` 顯示為 `2026/09/3 10:00:32`；缺值、載入中、失敗狀態均符合上述文案，沒有未驗證資料回退。
3. 左下角情境預設展開，可收合/展開；收合後圖示開啟圖層設定，展開箭頭恢復情境控制；底部操作流程不重疊。
4. 左下角沒有「i」按鈕；右下角 attribution 文字可見、可操作，地圖來源資訊仍保留。
5. Android bridge 回覆同時帶有 `static_features` 和 `snapshot_at`；Web 與 Android 以相同圖層集合和最新時間規則呈現。
6. 保留目前工作樹中與個人設定畫面相關的未提交修改，不納入本次變更。

## 審閱重點

- 日期範例是否按「月份補零、日期不補零、台灣時間」解讀。
- 右下角以文字 attribution 取代左下角「i」按鈕的呈現方式。
- 避難情境展開/收合的初始狀態與表單佔用底部時隱藏的規則。
