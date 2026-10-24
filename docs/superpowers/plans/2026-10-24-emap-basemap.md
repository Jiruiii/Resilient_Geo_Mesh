# EMAP 線上底圖 + OSM 離線備援

分支：`feat/emap-basemap`

## 已確認的決策

- 有網路時以內政部國土測繪中心 EMAP 為底圖，連不上時退回內建離線 OSM PMTiles。
- EMAP raster 圖層在載入樣式時注入於 OSM 圖層之上；切換只改圖層可見度，不重新載入樣式（避免重建 app 圖層）。
- 底圖模式：自動（預設，每 60 秒與回到前景時探測一張 EMAP 圖磚）／圖資／OSM，以 SharedPreferences 保存。
- 深色模式：raster 濾鏡（亮度反轉 + 色相旋轉 180° + 降低飽和度）。
- CWA 縣市警報面須在 EMAP 之上、app 事件與路線圖層之下。
- 設定頁（主題旁）提供切換，地圖畫面也提供快速切換按鈕。
- 標示「© 內政部國土測繪中心」。
- Web（Flutter Web）與 Android 同步完成與驗收。

## 進度

- [x] 1. 樣式注入：EMAP source/layer、深色濾鏡、attribution（`lib/data/map_basemap.dart`，於 `OfflineMapAssetStore.loadStyle` 注入）
- [x] 2. 底圖模式資料模型與保存（`MapAppController.basemapMode` / `setBasemapMode`，key `map.basemap_mode`）
- [x] 3. NLSC 可達性探測（`map_basemap_probe_io.dart` / `_web.dart`，探測圖磚 12/1791/3436 約 2.4 KB）
- [x] 4. MapCanvas：`_applyEmapVisibility`；CWA 縣市警報面改放在 NCDR 面之下（EMAP 之上）
- [x] 5. 設定頁 + 地圖「圖層設定」面板共用 `BasemapSelector`
- [x] 6. 遠端地圖檢查工具：只允許 wmts.nlsc.gov.tw，其他圖磚主機會被擋
- [x] 7. 單元／widget 測試：新增 13 項通過；全套 441 通過、8 失敗，同樣 8 項在未修改的 main 也失敗（既有問題，非本次造成）
- [x] 8. Web（Chrome）實測：EMAP、離線退回、深色、各功能
- [x] 9. Android 實測（Pixel 9 Pro XL 模擬器，API 36）
- [x] 10. 完整回歸：流暢度、介面、道路顯示、避難所／路線／搜尋／設定（物資點與警報面見下方限制）

## 紀錄

- 文件已更新：`flutter/README.md`、`Map_description.md`（新增「線上國土測繪圖資（NLSC EMAP）」章節）。
- 第一次全套測試（預設 30 秒逾時、模擬器同時開機）有 8 項失敗，含逾時；改用 README 指令 `--timeout 2m --concurrency 2` 重跑中。
- 驗收工具（在 session scratchpad，不進版控）：`pw/serve.mjs`（支援 Range 的靜態伺服器）、`pw/run.mjs`（Playwright 腳本，用 localStorage `flutter.map.basemap_mode` 設定模式，可擋 NLSC、量 FPS）。
- 比較基準（Map_description）：Web 拖曳 p95 約 18 ms；Android 模擬器拖曳 p95 約 28–29 ms。
- 既有失敗（main 亦同）：attestation_index、crowd_report_sheet（地址候選）、evacuation_route_flow ×2（找不到 `evacuation-disaster-context`）、government_device_event、map_screen（道路索引逾時）、ncdr_map_filter ×2。
- Web 實測（release build，Chrome，412×860）：
  - 自動模式：載入 EMAP，attribution 顯示「© 內政部國土測繪中心」。OSM 模式：0 個 NLSC 請求，畫面與原本相同。
  - 流暢度（拖曳＋縮放 8 秒）：EMAP 60 FPS、p95 16.8 ms、0 個 >50 ms；OSM 完全相同。
  - 離線切換：上線 EMAP → 擋 NLSC＋回到前景 → OSM → 新區域仍為 OSM → 解除＋回到前景 → EMAP。
  - 強制圖資模式但 NLSC 不通：顯示 OSM，不會空白。
  - 深色：濾鏡可讀；把暗部從 0.08 調到 0.15，避免純黑。
  - 圖層設定面板與個人設定的「底圖」下拉選單都能切換並同步；手機寬度原說明文字會被截斷，已縮短。
  - 道路搜尋（離線索引）與選取後定位：EMAP／OSM 都正常。
- 演練 App 的暫時性 EMAP／OSM 強制修改已還原（未提交），`.drill-state/` 已刪除。
- Android 實測：
  - 自動模式載入 EMAP；圖層面板與個人設定切換即時生效、相機與定位點不變。
  - 流暢度（Profile APK、台北車站、16 次拖曳 gfxinfo）：EMAP p95 46 ms／p99 57 ms；OSM p95 48–57 ms／p99 69–81 ms，EMAP 不比 OSM 慢。此模擬器解析度較高，絕對值比 Map_description 舊基準差，只做同條件比較。
  - 發現問題：手動 EMAP 模式離線時，原生 MapLibre 會把快取的低 zoom EMAP 放大補位（模糊），不會露出 OSM。處理：自動模式在地圖停止移動時也探測（每 10 秒最多一次）；手動模式說明改為「一律用圖資，離線可能模糊」。修正後：飛航模式＋拖一次 → 數秒內變成清晰 OSM；恢復網路＋拖動 → 回到 EMAP。
  - 演練資料（避難所 B、規劃逃生路線 218 公尺／4 分鐘）：EMAP 與 OSM 兩種底圖的標記位置、詳細資料、路線線條完全一致，路線貼合 EMAP 道路。
  - 演練的物資站事件在 EMAP 與 OSM 都沒有顯示成標記（行為一致，非本次造成）。
  - 深色模式（系統深色）：EMAP 濾鏡正常。
- 最後全套測試：441 通過、9 失敗；8 項與 main 相同，第 9 項 `map_app_controller_test` 的到期測試單獨重跑 6 次皆通過（全套負載下時間相關的不穩定，測試中不會啟動探測）。
  - Web 本機無後端，避難所／醫療簽章圖層、feed 為 404（兩種底圖相同，非本次造成），這些點位功能改在 Android 驗。
