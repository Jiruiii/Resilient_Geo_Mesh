# 雙北離線步行路線與效能驗證

雙北使用 `android/app/src/main/assets/routing/taipei-walk.rgmz`。
原始內湖 `walk-roads.json`、產生工具與 golden 測試保留，供相容性回歸。
新增資產約 28.9 MB，以 Git LFS 保存。

路網來源為 [Geofabrik 的台灣 OpenStreetMap 快照](https://download.geofabrik.de/asia/taiwan.html)，
固定輸入 `taiwan-260925.osm.pbf`，SHA-256：
`05d5ae22b805feeae2720701391515e615c295e57fa21b23d16e02351c3ab6ff`。
來源、邊界和產出雜湊另存於路網 manifest；保留 © OpenStreetMap contributors / ODbL attribution。

涵蓋臺北市、新北市及縣市聯集外框約 2 公里的邊界緩衝區。道路保留原始 OSM
node ID，避免把不同高度但座標相同的橋梁、隧道或道路誤接成路口。
排除 `foot=no/private/use_sidepath`，以及未明確允許步行的 `access=no/private`。
`oneway:foot` 會限制步行方向，一般車輛單行道不會直接限制步行。
保留共用路口；其餘幾何以 1 公尺容許誤差精簡，長路段補上最多 60 公尺間距的定位節點。
這是本機 OSM 步行網路，不包含即時路況、高程或對所有場所入口的人工驗證。

## 目的地類型（2026-10-23）

同一個路線引擎可規劃到三種目的地。Flutter 在 `calculateEvacuationRoute` 的
`destination.kind` 送出 `shelter`、`medical` 或 `supply`；舊版沒有送出 kind 時，
Android 一律視為 `shelter`，不認得的 kind 回 `invalid_input`。

| 目的地 | 入口 | 規則 |
| --- | --- | --- |
| 避難所 | 避難所詳情「規劃逃生路線」、推薦最近避難所 | 原有行為：開設狀態、額滿、災害情境適用性都會影響結果 |
| 醫療院所 | 已定位醫療點詳情「規劃步行路線」 | 不看避難所狀態，也不套用災害情境；未定位的醫療主檔沒有按鈕 |
| 物資點 | `SUPPLY_STATUS` 事件或 `SUPPLY_STATION` 物資站公告（須 `has_map_location` 且為點位）詳情「規劃步行路線」 | 同醫療院所；另由 Flutter 依最新版本加上供應狀態警示 |

- 封路、CRITICAL 危險區封鎖、PARTIAL／HIGH 加權、群眾回報只加權的規則，三種目的地完全相同。
- 醫療點或物資點位在 CRITICAL 危險區內時，和避難所一樣回 `no_route`，警示代碼為
  `DESTINATION_IN_HAZARD`。離路網超過 100 公尺、就在附近等訊息改稱「目的地」。
- 物資點的「暫停發放、已發完、已結束、狀態未知、已過期」只顯示警示，**仍提供路線**；
  未知數量不代表沒有物資。物資點更新、移動或到期會自動重新規劃；撤回或從本機移除後
  停止規劃並顯示「此物資點已撤回或不再提供」。
- 醫療點與物資點的路線面板標題為「步行路線」，並註明不是官方疏散指示。
- 主地圖目前只顯示物資站公告；`SUPPLY_STATUS` 事件來自演練資料，主地圖不顯示，
  但詳情與路線規則已一併支援。
- Web（Chrome）沒有 Android 路線引擎，三種目的地都顯示「此功能需要 Android App，
  Chrome 僅供地圖與資料預覽」，和避難所路線相同。
- 使用者手動規劃或推薦得到路線後，地圖會自動移到整條路線的範圍；事件更新造成的
  自動重算不移動鏡頭，避免打斷使用者正在看的位置。
- Android 先用 Google fused 定位；使用者拒絕「定位精確度」後，改用系統 LocationManager
  的 GPS 重試一次，之後的定位請求都直接走 GPS。定位權限被拒時不重試。

### 模擬器驗收（2026-10-26）

API 36（google_apis x86_64）模擬器，debug APK，`RouteValidationActivity` 以記憶體
fixture 提供兩個避難所、一個醫療點與一筆物資站公告，路線使用內建雙北路網：

| 項目 | 結果 |
| --- | --- |
| 推薦最近避難所 | `ok`，218 公尺；地圖由全臺視角自動移到路線範圍 |
| 醫療點步行路線 | `ok`，483 公尺；標題「步行路線」，有非疏散指示說明，無避難所狀態警示 |
| 物資站步行路線 | `ok`，464 公尺；地圖自動移到路線 |
| 物資站移動 | 自動重算到新位置，764 公尺，顯示「物資狀態更新，已自動重新規劃」 |
| 物資站撤回 | 不再呼叫原生引擎、移除路線，顯示「事件到期，已停止規劃」與撤回說明，無重試按鈕 |
| 拒絕定位精確度（主 App） | 改用 GPS 取得位置；因模擬器沒有 Server 圖層，推薦回報「20 公里內沒有可推薦的避難所」 |

限制：模擬器沒有正式 Server，主 App 沒有避難所／醫療圖層，因此主 App 只驗定位備援。
同一台模擬器在短時間連續注入大量 GPS 座標後，system_server 的 GNSS 服務曾卡住，
geolocator 的 LocationManager 路徑在註冊或解除 NMEA 監聽時觸發 ANR；重新開機並以正常
頻率注入座標後未再發生。實機上仍需確認此備援路徑不會 ANR。

## 重建

使用獨立 Python 環境並安裝 `osmium`（既有 search requirements 也包含此套件）。
下載輸入放 `tools/maps/.cache/`，不納入 Git。

```powershell
python -m venv tools/maps/.cache/routing-venv
tools/maps/.cache/routing-venv/Scripts/python.exe -m pip install -r tools/maps/requirements-search.txt
# 以下 python 使用上面的獨立環境；輸入 PBF 須先下載到 --input-pbf 路徑。
python tools/maps/build_taipei_walk_graph.py `
  --input-pbf tools/maps/.cache/taiwan-260925.osm.pbf `
  --source-date 2026-09-25 `
  --source-url https://download.geofabrik.de/asia/taiwan-260925.osm.pbf `
  --source-sha256 05d5ae22b805feeae2720701391515e615c295e57fa21b23d16e02351c3ab6ff
python -m unittest tools.maps.test_build_taipei_walk_graph
```

手機直接讀取預建的座標、路段、鄰接表、連通分量和空間索引，免除 JSON
解析及現場建圖。路線使用 A*；每條邊的成本仍包含既有災害、封路與群眾回報規則。
搜尋陣列由服務在 mutex 保護下重用；沒有封路時不再額外搜尋基準路線。
1,085,665 個節點、1,183,752 條路段、186,664 個 OSM way；最大連通分量含
1,072,617 個節點。道路是縣市聯集外框，並非只裁切行政區多邊形。

## App 延遲改善

- 全台道路 JSON 的解析、索引準備和文字搜尋在持續存在的背景 isolate 進行。
- 文字正規化結果快取，查詢只由輸入變更觸發；地圖重繪不會重跑搜尋。
- 單字／雙字 postings 與完整名稱反向比對，保留地址查詢的排名規則。
  只保存最佳 8 筆候選，必要時才推斷顯示用行政區，避免建立數十萬筆無用結果。
- Android 啟動不再先讀取之後會被已驗證來源取代的 preview 靜態資料。
- 底圖檔依內容版本及已安裝大小重用，免除每次開啟重新複製所有 PMTiles。
  更新先寫暫存檔再原子替換，失敗不會把上一份完整底圖截斷。
- 地圖樣式不因鍵盤開關重載，標記與行政區配置快取，拖動只更新座標。
- Android 實體像素轉成 Flutter 邏輯像素，修正停止拖動後標記移出畫面。
- 定位更新不重建所有靜態標記；5 公尺距離過濾減少 GPS 抖動造成的重繪。
  只使用 30 秒內、精度不超過 50 公尺的定位快取；新定位請求最多等待 10 秒。
- 修正 Android MapLibre 字型／圖示的 `flutter_assets/` 路徑。

## 驗證方式

`TaipeiWalkGraphTest` 驗證 12 個臺北市行政區和 29 個新北市行政區各有連通的
避難所與實際步行路線，並比較空間索引與完整掃描的候選路段。
這不代表所有避難所都有正確入口或所有道路都已現場查核。

`TaipeiRoutingPerformanceTest` 是實機 instrumentation 測試，不修改定位、
不送出回報、不清除 app 資料；涵蓋臺北、板橋、三重、新店、淡水及跨市橋梁。
接受標準為預建路網載入 < 5 秒、這組短程路線的暖機 p95 < 500 毫秒。

Android `profile` variant 使用 Flutter AOT，並沿用本機 debug 簽章，能覆蓋安裝
到開發手機並保留資料。畫面效能應以此版本衡量，debug 的 JIT 與檢查會增加成本。
debug/profile 提供 `ext.resilientgeo.performance` VM service extension，最多保存
600 個 frame timing；release 不註冊或收集此診斷資料。

## Pixel 8a 實測紀錄（2026-09-27）

USB 連線、Flutter AOT profile、手機 thermal status 1（輕度升溫）。
本輪覆蓋安裝並保留手機資料；冷啟動是新 process，仍保留已安裝底圖及既有驗證快取，
不等於清除資料後的首次安裝。完整避難所首次驗證的既有成本另見 [限制紀錄](../experiments/limitations.md)，本輪未獨立重測。
路線呼叫使用本機橋接與 Room 事件；instrumentation 則以空事件隔離路網運算。
每組路線重跑 6 次，第一次排除於暖機 p95；搜尋每個詞重跑 3 次。
拖動為 12 次 600 ms 橫向 swipe，統計最後 600 個 Flutter frame timing。

| 項目 | 最終觀察 |
| --- | ---: |
| instrumentation 路網載入（最後兩輪） | 2,247–3,614 ms |
| instrumentation 六組短程路線暖機 p95（nearest rank） | 11.3 ms |
| App 首次路線請求（新 process，含載入） | 1,798 ms |
| 冷啟動後全台道路搜尋準備完成（含 ADB／VM 連接） | 6,783 ms |
| App 六組短程路線暖機 p95 | 38.5 ms |
| App 含較長跨市路線的暖機 p95 | 68.6 ms |
| 約 7.4 km 臺北→板橋路線，六次最慢 | 115.9 ms |
| 約 19.9 km 淡水→板橋路線，六次最慢 | 116.6 ms |
| 一般搜尋 p95（成功路／板橋／中正路／板橋文化路地址） | 24.1–31.7 ms |
| 單字「路」搜尋，兩輪最慢 | 129.3 ms |
| 街道層級拖動 Flutter build p95 | 3.1 ms |
| 街道層級拖動 Flutter raster p95 | 4.1 ms |
| 街道層級拖動 Flutter total span p95 | 9.1 ms |
| 街道層級 build/raster 任一超過 16 ms 的 frame | 0 / 600 |
| 全台縮圖拖動 Flutter total span p95 | 8.9 ms |
| 全台縮圖 build/raster 任一超過 16 ms 的 frame | 0 / 600 |

搜尋數值包含 worker 往返，不包含 UI 的 180 ms 輸入 debounce。
道路索引在背景初始化；啟動初期的查詢暫時只搜尋已載入設施，索引準備完成後
會重跑目前的查詢。6.8 秒是初始化成本，不是每次搜尋都等待的時間；仍是後續可改善處。
Flutter frame timing 不等於完整 MapLibre GPU FPS 或觸控到螢幕顯示的延遲；
原生地圖另以實際拖動與停止後截圖檢查，確認標記保留且無 glyph/sprite 載入錯誤。
本次短程、跨市較長路線均回傳 `ok`，41 個行政區的避難所連通測試通過。
實際定位的推薦操作也顯示約 406 公尺路線；未修改定位或送出測試回報。

本輪接受門檻為首次路網載入 < 5 秒、暖機路線 p95 < 500 ms、一般搜尋 p95
< 100 ms、單字搜尋 < 150 ms，街道拖動 build/raster p95 均 < 16 ms；全部通過。
早期搜尋 p95 約 284 ms、單字搜尋最慢 680 ms，最終分別降到約 32 / 129 ms。
較早一輪長時間 USB 測試中載入曾達 5.79 秒；增大壓縮端讀取緩衝、手機休息後
後續兩輪測得 2.25–3.61 秒，不能將差異全歸因於程式改動，也不能保證所有溫度下低於 5 秒。

空間新增 28,891,043 bytes 路網；原本約 479 MB PMTiles 與舊內湖資料保留。
街道／較長路線測完的 app 總 PSS 約 1.10 GiB（含地圖圖形資源、全台搜尋、
雙北路網與 profile 引擎），Dart heap 使用約 247 MiB；並非只有路網的成本。
這次驗證針對 Pixel 8a，不代表較小記憶體手機或所有路段都具有相同表現。
多次重新啟動及覆蓋安裝後，五個 `files/maps/*.pmtiles` 大小、03:48 修改時間
均未改變，確認完整底圖直接重用。

最終檢查：234 項 Flutter 測試、135 項 Android JVM 測試、4 項產生器測試，
Flutter analyze、APK 內容與雜湊檢查，以及實機 instrumentation 全部通過。
原始 JSON 量測保存在本機忽略目錄 `.sim-out/pixel8a-verified-{overview,city}-latency.json`，
前幾輪亦保留於 `.sim-out/pixel8a-final-{overview,city}-latency.json`。
此表是有限案例的觀察，並非災害現場的安全性或全裝置效能保證。

## USB 重跑

```powershell
cd android
./gradlew :app:testDebugUnitTest :app:assembleProfile :app:assembleDebugAndroidTest -Ptarget-platform=android-arm64 --max-workers=2
cd ..
python tools/maps/check_routing_apk.py android/app/build/outputs/apk/profile/app-profile.apk
adb -s <serial> install -r android/app/build/outputs/apk/profile/app-profile.apk
adb -s <serial> install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <serial> shell am instrument -w -e class com.resilientgeo.mesh.routing.TaipeiRoutingPerformanceTest com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
adb -s <serial> shell am start -n com.resilientgeo.mesh/.MainActivity
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/latency.json --swipes
```

手機須顯示本 App 地圖；建議先用座標搜尋移到臺北或板橋街道層級，再量測拖動。
加上 `--long-routes` 會量測臺北／淡水到板橋；`--restart` 會重新啟動本 App，
另外記錄道路搜尋準備時間。鎖定測試手機時可與 `--over-keyguard` 一起使用。
若測試手機已鎖定，可在 debuggable 的 profile build 啟動時額外帶
`--ez performance_over_keyguard true`，使用 Android 的 `setShowWhenLocked` 顯示本 App。
此選項預設關閉，release 無效，手機鎖定和驗證設定不會改變。測完 force-stop，
以正常命令重開即可恢復一般顯示。全程不需假定位、清除資料或送出民眾回報。

路網副檔名使用 `.rgmz`：Android 會自動解壓縮並改名 `.gz` 資產。
APK 檢查驗證原始 gzip bytes／SHA-256、正確檔名、舊內湖檔案仍在，
並確認 PMTiles 與路網沒有再壓縮，避免打包記憶體耗盡及 range-read 延遲。
JVM 測試不使用 Android resources，故不為 unit test 額外打包全台底圖。
