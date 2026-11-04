# Android 事件湧入時的順暢度（2026-11-04）

既有 [Pixel 8a 量測](taipei-offline-routing.md#pixel-8a-實測紀錄2026-09-27) 顯示「單純拖動地圖」沒有掉幀。
這份文件處理另一個情境：緊急模式同步或伺服器更新時，Room 在短時間內被寫入很多次，
同時使用者還在操作地圖。

## 改了什麼

| # | 問題 | 改法 | Android | Web |
| --- | --- | --- | --- | --- |
| 1 | `FlutterMapBridge` 事件串流在 Android 主執行緒解析每筆事件 JSON；Flutter 3.29 的 UI 與主執行緒合併，所以等於直接佔用 Flutter 畫面時間。每寫入一個分片就把整份清單重新轉換一次。 | 解析與比對移到 `Dispatchers.Default`；每 250 ms 最多送一次（第一筆立即送、最後一筆不丟）；未變更的事件沿用上次解析結果，只重算與時間有關的 `apply_state`。`getInitialState` 的轉換也移出主執行緒。 | 已改 | 不適用：Web 沒有 Android bridge 與 Room，事件來自已驗證的 feed |
| 2 | `MaterialApp` 被 `AnimatedBuilder` 包住，任何 controller 通知（事件、EMAP 探測、救援資料）都會從 `MaterialApp` 往下整棵重建，並重新以 `ColorScheme.fromSeed` 建立兩份 ThemeData；每次 build 還會把通知清單重算三次。 | ThemeData 只建立一次；`MaterialApp` 只在主題模式改變時重建；`_MapAppHome` 自行監聽 controller；通知清單與未讀數每次 build 只算一次（`notificationEventsFrom`、`unreadAmong`）。 | 已改 | 已改（共用 Flutter 程式碼） |
| 3 | 41 MB `taiwan-roads.json` 用 `rootBundle.loadString` 讀取，預設快取會讓原始字串在 App 存活期間一直留在記憶體；政府工作台的 42 MB 行政區索引同樣被快取，且在 UI isolate 上 `jsonDecode`。 | 道路索引改 `cache: false`（解析後的索引仍由搜尋 worker／Web 索引保存）。行政區索引改讀 bytes（不進字串快取），並用 `compute` 在背景 isolate 解 UTF-8 與 JSON；`TaiwanAdministrativeArea` 物件仍在 UI isolate 對應，維持與 directory 同一個 instance。 | 已改 | 已改：Web 同樣不再快取原始字串；Web 的 `compute` 在同一執行緒執行，解碼時間不變 |

功能、資料、畫面、載入與錯誤狀態都沒有改變：bridge 仍只送已驗證事件，最後一份快照一定送達，
失敗時照舊顯示「事件更新失敗，目前保留最後一份已驗證資料」。

### 第二批（同日）

| # | 問題 | 改法 | Android | Web |
| --- | --- | --- | --- | --- |
| 4 | 冷啟動約 6.8 秒後道路搜尋才可用。容器內量測：JSON 解碼約 1 秒，建立 30 萬筆道路的 n-gram 索引約 4.4–4.8 秒，後者為主要成本。 | 建索引時把 1～2 字元的 UTF-16 gram 編碼成整數，不再為每個 gram 產生子字串，也不再為每筆資料建立暫存 Set。容器內 `prepare` 由 4,674 ms 降到 2,245 ms（−52%）；231 個查詢、1,269 筆結果與修改前逐字相同。 | 已改（搜尋 worker） | 已改（Web 用同一個 `MapSearchIndex`） |
| 6 | Android 固定使用 Hybrid Composition。程式註解說明這是為了避開模擬器 Virtual Display 黑畫面，實機上還沒和 texture layer 比較過。 | debug／profile 版可用 `--esa dart_entrypoint_args --map-texture-layer` 啟動 texture layer 模式；`ext.resilientgeo.performance` 回報 `map_composition`；量測腳本加 `--map-texture-layer`（需搭配 `--restart`）。release 版忽略這個參數，預設不變。 | 已改（只用於量測） | 不適用：Web 不使用 Android platform view |
| 7 | release 版沒有啟用 R8。 | 開啟 `isMinifyEnabled`，但不混淆名稱（`-dontobfuscate`），讓錯誤堆疊與 bridge 錯誤訊息仍可讀。新增 `android/app/proguard-rules.pro`：保留 Flutter 外掛註冊與 Bouncy Castle。容器內 `assembleRelease` 建置成功。 | 已改；**需在實機做 release 冒煙測試** | 不適用 |
| 8 | 每次回到前景都觸發政府資料同步。 | 不需修改：`GovernmentSyncManager.sync(automatic = true)` 已有 5 分鐘最短間隔，同步造成的 Room 連續寫入已由第 1 項節流。 | — | — |
| 9 | `MapScreen` 約 2,758 行，任何 `setState` 都會重建整個畫面。 | 只做低風險的局部修正：非展示模式不再為每份事件快照建立事件 key 集合。不做大規模拆分，以保持既有架構；若之後要拆，需先另外規劃。 | 已改 | 已改（共用程式碼） |

未處理：第 5 項（預熱並快取 FlutterEngine）。緊急模式的前景服務會讓 process 一直存活；
如果 engine 也跟著常駐，退出畫面後約 1 GiB 的地圖與搜尋記憶體不會釋放，系統在記憶體不足時
更可能回收整個 process，連帶中斷 mesh 交換。這項風險大於啟動時間的改善，所以這次不做。

## 量測工具

- Android `measurementEventBurst`（只在 debuggable 的 debug／profile 版提供）：把 `events`
  表每列寫回自己的值 N 次。資料不變，但 Room 會像 mesh 寫入一樣通知所有觀察者。
  執行時在主執行緒放 16 ms 心跳，回報心跳延遲的 p95、最大值與超過 16 ms 的次數。
- Flutter `ext.resilientgeo.eventBurst`／`eventBurstResult`：`mode=native` 呼叫上面的 Android 方法；
  `mode=replay` 讓 `MapAppController` 重送目前快照，走 controller 通知、`MapScreen` 與 `MapCanvas`
  的重建路徑。
- `tools/maps/measure_android_latency.py --event-burst-only`：同一組拖動手勢分三次做：
  沒有事件、native burst 進行中、replay burst 進行中，各自記錄 frame timing。

release 版不註冊 VM extension，Android 方法也會拒絕執行。

## 前後對照步驟

前測使用只含量測工具的提交 `775ef5d`，後測使用本分支最新提交。兩次都用 profile 版、同一支手機、
同一份手機資料。手機 Room 裡至少要有幾十筆事件（例如已同步過政府 feed），否則 `touched_rows`
為 0，這項比較沒有意義。

```powershell
git checkout 775ef5d
cd android
./gradlew :app:assembleProfile -Ptarget-platform=android-arm64 --max-workers=2
adb -s <serial> install -r app/build/outputs/apk/profile/app-profile.apk
adb -s <serial> shell am start -n com.resilientgeo.mesh/.MainActivity
cd ..
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/event-burst-before.json --event-burst-only
```

```powershell
git checkout claude/elegant-dijkstra-2462mr
cd android
./gradlew :app:assembleProfile -Ptarget-platform=android-arm64 --max-workers=2
adb -s <serial> install -r app/build/outputs/apk/profile/app-profile.apk
adb -s <serial> shell am start -n com.resilientgeo.mesh/.MainActivity
cd ..
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/event-burst-after.json --event-burst-only
```

預設為 60 次、間隔 50 ms（約 3 秒），可用 `--burst-count`、`--burst-interval-ms` 調整。
開始前先把地圖移到街道層級，與既有拖動量測一致；量測期間不要碰手機。

第 4 項看冷啟動後搜尋可用的時間（`search_ready_after_start_ms`），前後各跑一次：

```powershell
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/search-ready.json --restart --swipes
```

第 6 項用同一個 APK 跑兩次，比較 `pan_frames` 與 `event_burst`；兩次都使用 `--restart`，只差在有沒有 `--map-texture-layer`：

```powershell
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/hybrid.json --restart --swipes --event-burst
python tools/maps/measure_android_latency.py --adb <adb.exe路徑> --serial <serial> --output .sim-out/texture-layer.json --restart --swipes --event-burst --map-texture-layer
```

texture layer 模式下也要確認地圖沒有黑畫面、標記位置正確。只有實機數據較好、而且畫面正常時，才考慮改預設值。

第 7 項建置 release 版，安裝到測試機後至少確認：地圖、搜尋、事件推播、民眾回報簽章、避難路線、緊急模式開關都正常。`adb logcat` 不應出現 `ClassNotFoundException` 或 `NoSuchMethodError`。release 版沒有設定簽章，需要用你們自己的 keystore 簽署。

## 判讀

| 欄位 | 意義 | 預期改善 |
| --- | --- | --- |
| `native.result.main_lag_p95_ms`／`main_lag_max_ms` | burst 期間 Android 主執行緒（也是 Flutter UI）最晚延遲多久 | 後測應接近 `quiet` 基準，不再隨事件數量增加 |
| `native.pan_frames.slow_frames`、`total_p95_ms` | 拖動時 build 或 raster 超過 16 ms 的 frame | 後測應接近 `quiet_pan_frames` |
| `replay.pan_frames.build_p95_ms` | Flutter 重建成本 | 後測應下降，因為不再重建 `MaterialApp`、不再重算 ThemeData |
| `native.result.touched_rows`、`replay.result.events_per_snapshot` | 這次量測有多少事件 | 前後測應相同；數字太小時差異不明顯 |

限制：

- `native` 模式不改資料，前後測的 bridge 都會判斷快照相同而不送給 Flutter，所以它量到的是主執行緒上的解析與比對成本，不包含 Flutter 重建。
- `replay` 只量 Flutter 重建成本，不經過 Android。
- 兩種模式都不能取代兩台手機實際 mesh 同步的量測。
- Flutter frame timing 不等於 MapLibre 原生 GPU FPS。
- 一支手機的結果不代表其他機型。

## 雲端驗證（2026-11-04）

雲端容器沒有手機，以下只是單元測試與靜態檢查，不是實機結果：

- Android JVM：`BridgeEventStreamTest` 4 項通過：第一筆立即送且 20 次連續寫入合併到最後一筆；安靜一段時間後的單次更新不延遲；未變更的 payload 只解析一次、`apply_state` 仍隨時間更新；同一事件 payload 改寫後會重新解析。全部 281 項中 279 項通過；`TaipeiWalkGraphTest` 2 項因容器內 `taipei-walk.rgmz` 只是 Git LFS 指標檔而失敗，與本次修改無關。
- Flutter：`flutter analyze` 無問題；509 項測試 508 項通過，失敗的 `offline_map_package_files_test` 同樣是 PMTiles 只有 LFS 指標檔。
