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
- [ ] 7. 單元／widget 測試（新增 `test/map_basemap_test.dart` 13 項已通過），全部既有測試通過
- [ ] 8. Web（Chrome）實測：EMAP、離線退回、深色、各功能
- [ ] 9. Android 實測（若有裝置／模擬器）
- [ ] 10. 完整回歸：流暢度、介面、道路顯示、物資／避難所／路線／警報／搜尋／通報

## 紀錄

- 文件已更新：`flutter/README.md`、`Map_description.md`（新增「線上國土測繪圖資（NLSC EMAP）」章節）。
- 第一次全套測試（預設 30 秒逾時、模擬器同時開機）有 8 項失敗，含逾時；改用 README 指令 `--timeout 2m --concurrency 2` 重跑中。
- 驗收工具（在 session scratchpad，不進版控）：`pw/serve.mjs`（支援 Range 的靜態伺服器）、`pw/run.mjs`（Playwright 腳本，用 localStorage `flutter.map.basemap_mode` 設定模式，可擋 NLSC、量 FPS）。
- 比較基準（Map_description）：Web 拖曳 p95 約 18 ms；Android 模擬器拖曳 p95 約 28–29 ms。
