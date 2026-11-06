# 等待時間優化與實機量測（2026-11-06）

使用者回報 App「有點卡」。實測後發現主因是手機上裝的是 Flutter debug（JIT）版；換成與 release 同速的 profile 版後，地圖拖動已經順暢（見下方 Pixel 8a 數據）。本批只處理仍明顯的等待：道路搜尋可用前的等待、第一次規劃路線，以及政府工作台開啟時的凍結。

## 變更

| 項目 | 變更 | 影響範圍 |
| --- | --- | --- |
| 道路搜尋索引 | 內建道路只以名稱、別名、行政區建立索引，不再索引 OSM way id 與一律相同的 `road` 類別（原本占 8.2M／11.5M 筆 postings）；掃描路徑同步調整，索引與掃描結果仍一致 | Web、Android 共用 Dart 程式 |
| 道路 n-gram | 一字／二字 gram 改以 UTF-16 code unit 整數為 key，不再為每個 gram 建立字串；二字 key 用乘法以免 dart2js 位移截斷 | Web、Android 共用 |
| 搜尋資料載入 | Android 直接把 42 MB 原始位元組交給背景 worker，以 UTF-8/JSON 合併解碼；UI isolate 不再產生、複製與快取整份字串 | 僅 Android（Web 無 isolate，維持原流程） |
| 步行路網預載 | `EvacuationRouteService.prewarm()` 在 bridge 建立 3 秒後背景載入路網與搜尋工作區；失敗時由下一次 `calculate()` 重試並回報 `GRAPH_UNAVAILABLE` | 僅 Android（Web 沒有路線計算） |
| 政府工作台行政區索引 | Android 在 `Isolate.run` 解析 43 MB 行政區索引；230 萬個座標改存 `Float64List`；Web 讀取時不再快取整份字串 | 解析位置僅 Android；Float64List 兩端共用 |

行為差異：輸入 OSM way id（例如 `319679961`）或 `road` 不再命中內建道路。設施（避難所、醫療）仍可用 id 搜尋，與原本相同。

## Samsung A53 實測（profile 版，USB）

以 `-PmeshTestApplicationIdSuffix=.perf` 安裝為獨立套件，不影響手機上原有 App 與資料；每版從冷啟動量兩次，工具為 `tools/maps/measure_android_latency.py`（僅套件名稱改為 `.perf`）。

| 指標 | 修改前（main） | 本批前兩項 | 最終 |
| --- | --- | --- | --- |
| 啟動到搜尋可用 | 9.9 s／9.2 s | 9.6 s／8.3 s | 9.0 s／7.3 s |
| 第一次規劃路線 | 2,211 ms／2,196 ms | 71 ms／67 ms | 75 ms／96 ms |
| Dart heap | 488 MB／245 MB | 144 MB／143 MB | 139 MB／138 MB |
| App 總 PSS | 983 MiB／903 MiB | 798 MiB／790 MiB | 798 MiB／800 MiB |
| 拖動 total p95（600 幀） | 11.6 ms／13.7 ms，0 慢幀 | 11.3 ms／11.8 ms，0 慢幀 | 11.8 ms／12.0 ms，0 慢幀 |

暫時加入計時記錄（量完已移除）得到 A53 上搜尋載入各階段：讀取資產 0.17 s、JSON 解碼 1.8 s、建立物件 0.5 s、建立索引 2.6 s（整數 key 前）。電腦上建立索引由 2.19 s（原始）→ 1.23 s（排除 id）→ 0.98 s（整數 key）；行政區索引由 UI isolate 上 613 ms 改為背景 458 ms，點位查詢結果相同。

## Pixel 8a 觀察（換機前）

| 指標 | debug（JIT） | profile（AOT） |
| --- | --- | --- |
| 冷啟動 TotalTime | 2.56 s | 0.92 s |
| 全台縮放拖動 total p95 | 12.1 ms | 8.7 ms |
| 臺北街道層級拖動 total p95 | — | 8.4 ms，0 慢幀 |
| 啟動到搜尋可用 | 9.5 s | 6.1 s |

給使用者的版本應為 release；目前 `release` 沒有簽章設定，尚無法產生可安裝的 release APK。

## 驗收

- Flutter：`flutter analyze` 無問題；79 個測試檔逐檔執行全數通過（整批同時執行在本機會卡住，與本變更無關，逐檔可通過）。
- Android：`:app:testDebugUnitTest` 279 項通過，含兩項新的預載測試。
- Web：`flutter build web --release` 成功，Chrome 搜尋「成功路」列出新店、永和、板橋、三重的成功路；本機未啟動 Server，事件更新失敗訊息為預期。

## 兩機功能驗收（2026-11-07）

Pixel 8a（Android 17）與 Samsung A53（Android 16）以 USB 連接，安裝本分支 debug 版為獨立套件 `com.resilientgeo.mesh.perf`。

| 項目 | 結果 |
| --- | --- |
| `RealPeerSyncInstrumentedTest`（Pixel 持 FLOOD、A53 持 ROAD_BLOCKAGE） | BLE、Nearby、Wi-Fi Direct 三種方式都通過：首次相遇各收到 1 片，再次相遇 `already in sync`、`chunksApplied=0`；Wi-Fi Direct 未出現系統連線邀請 |
| 全部 instrumented 測試 | 兩台各 48 項通過（opt-in 項目略過） |
| 正式 App 緊急模式（自動選擇） | Pixel 送出淹水回報，約 26 秒後 A53 經 Nearby 收到並列入通知；A53 送出求救，約 44 秒後 Pixel 經 BLE 收到並顯示求救點；A53 取消誤報，約 25 秒後 Pixel 經 Nearby 收到並移除求救點、不列入通知 |
| 搜尋與路線（`measure_android_latency.py`） | 兩台搜尋「成功路」4 筆、「中正路」7 筆、完整地址 1 筆；所有路線 `ok` |

上述時間為按下送出到對方套用的手機計時，含同步冷卻與搜尋時間，非傳輸速度。測試期間 Wi-Fi 與行動數據保持開啟（傳輸本身不經網際網路）；未重跑完全離線與政府警告離線轉傳（需本機政府伺服器並關閉兩台網路）。debug 版的伺服器位址為模擬器專用的 `10.0.2.2`，測試回報與求救沒有上傳。

測後兩台都移除測試套件，只保留以本機開發金鑰簽章的 release 版。Web 沒有原生無線交換，本次未更動 Web。

## 限制與後續

- 搜尋可用時間在 A53 仍約 7–9 秒，量測變異大。主要剩下 JSON 解碼與建立索引；若要再大幅縮短，需在資料管線預先產生二進位索引，改動 `tools/maps/build_taiwan_search_index.py` 與兩端載入程式。
- 啟動時主執行緒約 1 秒的阻塞尚未處理：Pixel 8a 不允許 simpleperf 取樣，原因仍待以 Perfetto 追蹤。
- 數據只來自一台 A53、每版兩次冷啟動，非全裝置效能保證。
