# 資料一致性與兩機驗證（2026-09-27）

本輪先處理資料一致性、TTL、更新失敗提示及避難所推薦，再驗證 Pixel 8a 與 Sharp SH-M32。測試採 `adb install -r` 覆蓋安裝；不清除 App 資料。故障注入與兩機協定測試使用獨立的記憶體 Room 資料庫及暫存快取，不把模擬回報寫進使用者資料。

## 修正

- 分片內容先以暫存檔與原子替換保存，事件與分片庫存在同一筆 Room 交易中提交。資料庫失敗時復原原有快取；不同 repository 實例共用寫入鎖，避免版本檢查與寫入交錯。
- 快取淘汰同步移除庫存；HELLO 前核對遺失或截斷的快取。快取名稱改用完整識別欄位的 SHA-256，舊檔案依內容確認身分後原子遷移。
- 群眾回報較舊版本及同版本不同內容不能覆蓋新快取。
- 顯示時重新計算 TTL，原生事件串流每 30 秒檢查狀態變更；Flutter 在事件到期及返回前景時刷新，不修改原始簽章資料。
- 事件更新錯誤會保留最後快照並顯示失敗提示，提供重新取得快照及訂閱的重試操作。
- 避難所推薦按直線距離排序，搜尋 20 公里內最多 50 處；可達路線距離提供提前停止的下界，另有逐次檢查的 15 秒搜尋預算。保留額滿、起點不在路網等原生原因，並揭露搜尋範圍。單次原生呼叫的時間不包含在硬性中斷機制中。
- 驗證拒收或請求逾時不再計為同步成功；通知的分片計數按分片計算，不按分片中的事件數計算。

## BLE 私有位址問題

第一次跨機型自動交換重現：兩機能建立 GATT 並收到 HELLO，卻反覆報告 `no HELLO`。原始 log 顯示同一台裝置的廣播位址與 central 連線來源位址不同，原本按 MAC 建立的 session 把同一個 peer 分成兩個。

修正為每個 BLE transport 實例產生隨機 8-byte 身分，放在掃描回應的 service data；協定 envelope 帶 `sender_transport_id`，同步引擎以此對應 session，另保留最新廣播位址供 GATT 連線。身分只用於路由，並不是認證；事件／分片仍須通過原有簽章驗證。身分隨 transport 重建更新，不是永久裝置追蹤碼。

主要廣播保留 service UUID，身分放在另一份掃描回應，遵守兩份資料各自的大小限制；API 行為見 [Android BluetoothLeAdvertiser](https://developer.android.com/reference/android/bluetooth/le/BluetoothLeAdvertiser)。自動同步的 BLE 節點需一起更新此版本；原生 transport harness 的 MAC 介面與資料分段格式保持相容。

## 驗證結果

- Flutter analyze：通過；完整 Flutter 測試 242 項通過，最終搜尋範圍說明另跑 27 項路線測試通過。
- Android JVM：138 項通過，包含廣播位址與連線來源位址不同的回歸測試。
- Pixel 8a、Sharp SH-M32：在 Wi-Fi 與行動數據關閉時，各 16 項 instrumentation 通過。包含 7 項 repository 一致性測試、5 項庫存測試、3 項 migration 測試與雙北路線測試。
- 原生路網測試：Pixel 8a 載入約 2,550 ms、暖機路線 p95 約 10.7 ms；Sharp 載入約 2,814 ms、暖機路線 p95 約 13.5 ms。這是原生引擎測試，不代表 Flutter 完整 UI 延遲。
- 兩機 BLE：第一次測試失敗並定位上述位址問題；修正後兩機各通過一項真實 BLE 測試。第一輪各收到一個缺少的簽章分片；重建 transport 後第二輪皆 `peersSynced=1`、`chunksApplied=0`，確認不重複要求已有分片。兩輪均關閉 Wi-Fi 及行動數據。
- 正式前景服務：由 Flutter 緊急模式開關啟動，熄屏後兩機都完成 `already in sync` HELLO 核對；本次正式資料本來一致，因此沒有藉此驗證正式資料的 TRANSFER。初次 GATT 連線有逾時，後續重試成功，不能把單次成功視為穩定成功率。
- 熄屏觀察：20:41:04 將 App 切到背景並關閉螢幕，20:41:34 與 20:42:15 核對 Pixel 為 `Dozing`、Sharp 為 `Asleep`，兩機心跳持續，至最終各有三次成功 HELLO 核對。這是約 71 秒的短期觀察；更早一段 Pixel 曾自行回到 Awake，未計入連續熄屏證據。兩機 `deviceidle` 仍為 ACTIVE，USB 連線下的結果不能當作 Doze 或長時間存活驗收。
- 地圖：Pixel 的五個 PMTiles 大小與修改時間維持不變；Sharp 原先缺少 `.version` 側檔，首次啟動依既有資產機制重新安裝同尺寸地圖並建立側檔。沒有清除 App 資料。
- 測試收尾：兩機緊急模式已關閉。恢復原設定：Pixel 藍牙關閉、Wi-Fi／行動數據開啟；Sharp 藍牙開啟、Wi-Fi 關閉、行動數據開啟。App 的 BLE 與通知權限保留為允許，供後續使用。

原始記錄位於本機 `.sim-out/`：`flutter-reliability-tests.log`、`flutter-route-reliability-tests.log`、`android-peer-identity-build.log`、各裝置的 `*-reliability-instrumentation.log`、`*-real-peer-sync-fixed.log`、`*-peer-fixed-logcat.txt`、`*-peer-failure-logcat.txt`、`*-lock-screen-service.log`、`*-lock-screen-final-state.txt` 與 `*-hardware-test-logcat.txt`。

## 重跑

```powershell
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest -Ptarget-platform=android-arm64 --max-workers=2
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <serial> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <serial> shell am instrument -w -e class com.resilientgeo.mesh.data.RepositoryConsistencyInstrumentedTest com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
```

兩機測試需先授予本 App 的 BLE 權限、開啟藍牙，並在兩個終端同時執行：

```powershell
adb -s <Pixel serial> shell am instrument -w -e class com.resilientgeo.mesh.data.RealPeerSyncInstrumentedTest -e peer_seed shelter com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
adb -s <Sharp serial> shell am instrument -w -e class com.resilientgeo.mesh.data.RealPeerSyncInstrumentedTest -e peer_seed road com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
```

`RealPeerSyncInstrumentedTest` 預設跳過，只有帶 `peer_seed` 才執行；它要求第一輪互補缺片、重建 transport 後第二輪沒有新 TRANSFER。這項測試使用真正 BLE 和同步引擎，但不等同正式前景服務的鎖屏／Doze 驗收，也不取代三機中繼及災情改道演練。

## 下一批

災害類型篩選、同步狀態頁、跨接觸續傳、路線自動重算、離線資料管理、預建搜尋索引、正式查證上行、精簡摘要及穩定分片仍屬後續功能。本輪先完成上述可靠性修正及擴大避難所搜尋，不把整份功能規劃視為已完成。

後續更新：同步狀態頁與手動災害情境篩選已於下一輪完成，詳見 [功能與實機驗證](sync-status-disaster-filter.md)；其餘功能仍待實作。

## 2026-10-02：兩機 mesh 流程檢查與修正

分支：`codex/fix-two-phone-mesh-sync`。本輪從 Flutter 緊急模式入口、權限、
BLE discovery/GATT、HELLO/DIFF/REQUEST/TRANSFER，追到驗證、Room 庫存及重試。
尚未取得組員的手機型號、失敗步驟或 log，因此以下是程式檢查與可重現的本機問題，
不是已確認的組員實機故障根因。

### 已修正

| 階段 | 問題與修正 |
| --- | --- |
| 發現節點 | Android 11 以下未宣告舊版 BLUETOOTH／BLUETOOTH_ADMIN，緊急模式也未請求掃描所需的 fine location。補上宣告、請求與服務端檢查；Android 12 以上維持附近裝置權限流程。 |
| 建立連線 | connect 超時、取消或設定失敗時，尚未加入連線表的 GATT 無法被 close 找到。現在失敗路徑會 disconnect/close；檢查服務探索與 ACK 訂閱結果，MTU 操作超時則放棄連線。引擎總預算改為 40 秒，涵蓋底層四個設定階段。 |
| 連線回覆 | 寫入／ACK 等待狀態原本跨連線共用，舊連線的延遲 callback 可干擾另一連線。改為每個 GATT 實例持有等待狀態，斷線 callback 只移除所屬實例。 |
| 雙向交換 | 接收 collector 直接等待整批回傳，阻塞另一方向的接收；有限緩衝會丟掉已被 BLE ACK 的訊息。改為每個 session 的序列回傳工作，接收端只排入 REQUEST，並保留提早抵達的請求。 |
| 分片對應 | 等待結果改以 dataset、namespace、chunk id、hash 完整比對；一筆分片不能滿足另一資料集的同名請求。 |
| 成功判定 | 快取缺片、回傳失敗／中斷及 manifest 衝突不再被當作成功；REQUEST 送出失敗立即記錄失敗。 |
| 重試與停止 | 清除上一輪未完成請求，避免已到期／不再公布的分片讓後續同步永久失敗。stop 取消所有 session 與回傳工作，並由 finally 關閉連線。 |

權限與 GATT 生命週期依據：[Android Bluetooth permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)、[BluetoothGatt](https://developer.android.com/reference/android/bluetooth/BluetoothGatt)。

### 本機驗證範圍

- 修改前，新增的四個回歸測試均失敗：雙向交換 40 片只收到 32 片、逾時殘留污染下次同步、回傳失敗卻計為成功，以及 stop 未關閉進行中連線。
- 修改後，17 項 AutoPeerSyncEngine 測試與 52 項 protocol／trust／report／ingest 測試，共 69 項 JVM 測試通過。包含雙向交換、私有位址對應、三節點中繼、竄改拒收、簽章、版本與 TTL。
- 本機使用 Gradle 內附 Kotlin 2.0.20 編譯器、專案指定版本的 JUnit／coroutines／JSON／Bouncy Castle 執行上述測試。為避開 Android host，暫存 runner 直接抽取原始 ChunkIngestResult 與 DeviceSigningKey 宣告；未改寫驗證或同步邏輯。
- BleGattTransport 與 BleDiscovery 以 Android 14 API 類別庫通過編譯檢查。這不是完整 APK 建置或 GATT 實機測試。
- 此環境缺少完整 Android SDK／Flutter module 生成檔；未執行 Gradle Android 全套測試、Room instrumentation、APK 安裝及雙機藍牙實測。

有完整 SDK 的環境可重跑：

```powershell
cd android
./gradlew :app:testDebugUnitTest --tests com.resilientgeo.mesh.emergency.AutoPeerSyncEngineTest
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest -Ptarget-platform=android-arm64 --max-workers=2
```

### 組員雙機重測

1. 兩台皆安裝此分支的同一版 APK，記錄機型、Android 版本與 Git commit。保留 App 資料；更新可用前文的 `adb install -r`。
2. 開啟藍牙與必要權限；Android 11 以下另確認定位服務開啟。先以前景執行，使用前文的 RealPeerSyncInstrumentedTest 互補 seed 測試，確認兩邊都收到缺片，第二輪沒有重複 TRANSFER。
3. 再測正式緊急模式：兩邊各新增不同回報並同時交換；測試資料應明確標為演練。增加至超過 32 片，核對兩側實際已驗證庫存與地圖，而不只看通知數字。
4. 傳送中關閉其中一台的緊急模式，再重新開啟，確認另一台記錄失敗後可重試、已完整接收的分片不用重傳。最後再測熄屏與背景。
5. 若失敗，保留兩側同一時段的 `ResilientGeoEmergency`／`ResilientGeoBleGatt` log，連同手機型號、版本與操作步驟比對 HELLO、REQUEST、TRANSFER 與驗證結果。

### 仍有的限制

- 本輪未新增應用層的雙向完成／驗證回執。BLE ACK 只代表重組完成，發送端不能因此證明接收端已驗證寫入；6 秒接收窗口與慢速多資料集的交互仍應在實機確認。
- 5 分鐘的資料等待上限、完整 inventory HELLO，以及接收端驗證速度仍可能影響全國大資料集。真正斷線後的半片續傳仍未持久化；已驗證的完整分片可跨接觸保留。
- Android 10／11 的背景掃描授權、系統定位開關、執行期間切換藍牙與長時間 Doze 尚未驗收。原始 GATT 重組器的異常 frame／記憶體上限也仍需要獨立強化與測試。

## 2026-10-02：針對互相無法發現的修正與 APK

組員補充實際症狀為「兩台手機無法互相發現」。本輪仍未取得手機型號及雙機 log，
因此不能把以下修正當作已確認的實機根因。

- 將同步必要的 8-byte transport identity 放入 BLE 主廣播封包；含 flags 共 29 bytes，
  不超過 legacy advertising 的 31-byte 上限。掃描同時接受 service data 與舊版 UUID list，
  降低只收到主廣播、未收到 scan response 時無法建立 session 的機會。
- 未收到 identity 的 mesh 廣播仍顯示為附近節點，並留下診斷訊息；取得 identity 後才同步，
  避免把 Android 私有位址誤當成跨連線的身分。同一位址稍後補上 identity 不重複計數。
- 緊急模式每 5 秒重新檢查藍牙、權限及 Android 11 以下的定位服務。
  使用者補開藍牙／授權後自動恢復；掃描失敗以至少 30 秒間隔重試。
  重啟 discovery 時保留本次服務累積的同步數，停止時盡力釋放所有 GATT 資源。
- BLE 與通知權限依序請求，避免兩個權限對話框同時啟動；授權後由服務恢復掃描。

### 完整建置與驗證

本輪已補齊建置環境，取代上一輪僅能使用暫存 JVM runner 的限制：

- Flutter 3.29.2／Dart 3.7.2、JDK 21、Gradle 8.11.1；沿用專案鎖定的套件版本。
- `flutter analyze` 無問題，`flutter test` 共 258 項通過。
- Android `:app:testDebugUnitTest` 共 162 項通過，無失敗、錯誤或跳過；
  `:app:assembleDebug -Ptarget-platform=android-arm,android-arm64,android-x64 --max-workers=2` 成功。
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，764,463,020 bytes，
  minSdk 26（Android 8.0），內含 ARM32、ARM64、x86_64 的 Flutter 引擎與完整離線地圖。
- `apksigner verify` 通過（debug certificate、APK v2），ZIP 完整性通過；
  五份 PMTiles 均逐一核對大小與 SHA-256，與原始資產相同。
- APK SHA-256：`5e83a5ff695834bdac5cdf0d6054a27cbbc796bebd061125b97f65170a9b37ae`。
- 本次 debug 簽章憑證 SHA-256：`21e932858e75038d87236d4284b803cae328105dc0471fea8ac2c383f9524daf`。
  保留本機建置金鑰供後續測試更新；跨開發環境的舊 APK 是否使用同一憑證尚未確認。
- 原始建置、Flutter 測試、簽章及資產核對紀錄在本機忽略目錄 `android/build/`。
  本輪未連接實機，尚未驗證 APK 安裝與兩機發現；下列步驟仍需組員重測。

### 兩機發現重測

1. 兩台安裝同一版 APK，開啟藍牙、允許附近裝置權限，再開啟緊急模式。
   Android 11 以下另允許定位權限並開啟系統定位服務。
2. 先保持螢幕亮起、相距約一公尺，查看同步狀態頁的附近節點數與同步結果。
   可先觀察 30 秒；這是測試觀察窗口，不是硬體發現時間保證。
3. 保持緊急模式開啟，將一台藍牙關閉再開啟，確認不用切換緊急模式即可重新發現。
4. 若仍失敗，擷取兩台同一時段的記錄：

   ```powershell
   adb -s <serial> logcat -d -v threadtime ResilientGeoEmergency:I ResilientGeoBleGatt:I '*:S'
   ```

   一併提供手機型號、Android 版本、附近節點數，以及是否出現 `advertise started ok`、
   `scan failed`、`advertise failed` 或 `without transport identity`。

## 2026-10-02：Samsung／Pixel 實機追查

裝置為 Samsung SM-A5360（Android 16）與 Pixel 8a（Android 17），以無線 ADB 操作。
原有 APK 簽章不同，經使用者分別同意後移除舊 App 並安裝測試版；後續更新保留資料。

### 實測找到並修正的問題

- `90f6897` 可互相發現並建立真正的 BLE GATT 連線，但掃描 callback 也收到其他藍牙廣播，
  UI 曾顯示 25／34 個附近節點。service-data 篩選改用非 null 的空 byte pattern，
  callback 另核對本 App 的 service UUID／service data，避免依賴硬體篩選而誤計數。
- 正式資料不對稱時，Pixel 自己沒有缺片，在 Samsung 的大型 REQUEST 完整抵達前便結束
  6 秒接收窗口並宣告成功。記錄中先出現 `sync ... complete`，後續才收到 32,240-byte REQUEST。
- HELLO 新增每次連線隨機 `session_id`；新版本在送完全部資料集的 REQUEST 後發出
  `REQUESTS_DONE`。只有收到對應回合的結束標記、排隊回傳工作完成且本機請求成功後，
  才結束本輪同步。等待仍有上限；舊版沒有 session id 時沿用原本接收窗口。
  此標記代表「請求清單已結束」，並非接收端驗證寫入的回執。
- 回歸測試已重現修正前的慢速多資料集請求完全收不到資料；修正後通過。
  另驗證舊回合的 `REQUESTS_DONE` 不會誤結束新連線。完整 Android JVM 測試 164 項通過。

修正版 APK 仍位於 `android/app/build/outputs/apk/debug/app-debug.apk`，764,572,711 bytes，
SHA-256 為 `8c640274448f6cc855f18f05b6da6821354cf1db149c184edb2dc39b05100c4d`；
APK 簽章、ZIP 完整性與五份地圖資產雜湊均通過核對。

### 修正後的實機結果

- 兩台皆以保留資料方式更新修正版，已安裝的 `base.apk` SHA-256 均與上述建置相同。
- `RealPeerSyncInstrumentedTest` 在兩台同時執行並各自通過：第一輪各收到並驗證 1 片，
  庫存補齊至 2 片；重建 transport 後第二輪 `chunksApplied=0`、`already in sync`。
  另斷言附近只有另一台 Mesh 手機，沒有把環境中的其他藍牙廣播算入。
  此測試使用記憶體 Room 與暫存快取，結束後釋放，不寫入正式回報資料。
- 正式緊急模式：兩側 UI／服務 heartbeat 均顯示 `peers=1`。
  Pixel 向 Samsung 傳送正式缺片，Samsung 收到並驗證 58 片，兩側均完成同步。
  Pixel 本輪沒有缺片，因此其正式服務接收數為 0；雙向能力由前述互補資料測試驗證。
- Samsung 藍牙關閉時停止掃描，`peers=0 discovery=false`，既有 58 片累積數保留。
  重新開啟藍牙後，未重新切換緊急模式，兩側自動恢復 `peers=1 discovery=true`，
  完成次數增至 2，Samsung 接收數仍為 58，沒有重傳已持有分片。
- 測試收尾關閉兩台緊急模式，藍牙維持原先開啟狀態；未更動 Wi-Fi 或螢幕逾時設定。
  App 的 debug 鎖屏顯示測試入口已還原為一般顯示，手機鎖定設定未變更。

本機證據在忽略目錄 `android/build/`：`mesh-*-hardware-test.log`、
`mesh-*-hardware-logcat.log`、`mesh-*-recovery.log`、`mesh-samsung-radio-off.log`、
`mesh-*-success.png`、`mesh-device-final-unit.log`；修正前重現記錄為
`mesh-slow-request-red.log` 與 `mesh-*-initial.log`。

本次證明上述兩台的發現、互補資料交換、再次相遇及藍牙重啟恢復；
不代表已驗收所有機型、長時間 Doze、三機中繼或大型資料集的所有接觸情境。
