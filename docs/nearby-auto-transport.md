# Nearby 與自動備援交換

2026-10-10：Android 新增 Nearby Connections adapter；正式預設由手動 BLE 改為自動模式。
既有使用者的舊 transport 設定遷移為自動，進階選單仍可指定 Nearby、Wi-Fi Direct 或 BLE 做診斷。

## 使用與平台範圍

- 在 Android「個人設定 → 同步狀態」開啟緊急模式，允許附近裝置權限，開啟 Bluetooth 與 Wi-Fi。
  Nearby 不需 SIM、網際網路或共同路由器，但需要可用的 Google Play services。
- Android 17 / target 37 的區域網路權限包含在授權流程。原生 Wi-Fi Direct 仍要求系統定位開啟，
  某些裝置會顯示系統連線邀請，需要使用者接受；自動選擇不繞過平台授權。
- GMS 不可用時略過 Nearby。Wi-Fi、權限或裝置功能不足時，仍嘗試已就緒的原生方式。
- Web 同步頁提供離線交換說明，不呼叫 Android MethodChannel、不顯示可操作的無線交換開關；
  網頁既有的伺服器簽章資料下載仍可使用。

## 選擇與恢復

自動模式一次運行一個高速候選：Nearby 優先，再 Wi-Fi Direct。Nearby 初始搜尋預算 30 秒，
Wi-Fi Direct 100 秒；進行中的同步不因搜尋預算到期被切斷。搜尋啟動錯誤、連線／摘要／發送錯誤
會讓候選在閒置後退出，冷卻 120 秒再試。成功且對端仍存在時保留連線，不為較高優先序打斷它。
單一方式的診斷模式不自動切換；搜尋失敗以 30 秒節奏恢復。

BLE 與高速候選並行廣播／搜尋，維持跨機型、跨啟動時間的相遇機會。首次開啟時給高速候選
20 秒優先嘗試；之後 BLE 也可主動交換。對方已送來 HELLO 時不受這個延遲阻擋。
這不是每個 peer 的精確測速選路，也不是固定的 5G/4G/3G 階梯。Nearby 底層如何選 Bluetooth／Wi-Fi
由 SDK 管理，介面顯示的是 Nearby，不假裝知道當下實際使用哪種無線通道。

目前高速候選切換是服務層級，BLE 保持常駐；不同通道可能同時遇見同一台手機。
附近節點數按通道計數，可能重複，畫面明示這一點。兩個引擎共用 repository，重新比對庫存並沿用
現有序列化驗簽／套用流程；不因傳輸切換清除資料。極短時間內的雙通道 REQUEST 仍可能重複下載。
手機 radio 共存、長時間耗電及實際吞吐量必須由實機量測，不由此策略推論。

## Nearby adapter

- 使用 `play-services-nearby:19.4.0` 與 `P2P_POINT_TO_POINT`，一次一個高速 peer。
  19.5.0／19.5.1 的 Kotlin 2.4 metadata 與現有 Kotlin 2.2 不相容，故固定 19.4.0；
  啟用 SDK 要求的 core library desugaring，coroutines 主程式與測試一併對齊 1.10.2。
  以 D8/R8 8.13.19 覆寫原 AGP 8.9.1 的編譯工具，支援 SDK 內的 Kotlin 2.3 metadata；
  保留既有 Gradle／AGP 與 Flutter 整合。
  未啟用 Cluster；多人由逐次接觸與既有 Store-Carry-Forward 完成，不宣稱 Nearby 自動多跳路由。
- 專用 service ID `com.resilientgeo.mesh.nearby.v1`；每次 transport 啟動產生隨機身分。
  依身分排序只讓一方邀請，避免雙方同時連線。端點名稱只是路由提示，不是信任或使用者認證。
- 自動接受符合協定的相遇，只交換既有公開 mesh 訊息；政府與群眾資料仍走原有 Ed25519、hash、
  版本／TTL／namespace 驗證。Nearby 的鏈路加密不取代資料來源驗證。
- 使用 BYTES payload，每片最多 24 KiB，加 20-byte 協定標頭，避免 SDK 的 bytes 大小上限。
  邏輯訊息上限 4 MiB；依序重組、拒絕錯序／越界／30 秒未續傳的半包，完整訊息才交同步引擎。
- 每片等待 SDK 的 SUCCESS callback，不把 sendPayload Task 被接受當作傳完；這仍不是對方
  已驗簽入庫的證明。發送逾時／斷線會清理 pending 工作，下一次以新庫存 diff 重送完整未完成訊息。
- `close()` 結束的是同步回合，不直接切斷雙向鏈路；真正服務停止或斷線才釋放 SDK 資源。

## 驗證方式

JVM：`NearbyFramingTest` 驗證 1 MiB 訊息、分段大小、錯序／惡意長度拒收、逾時、斷線後重送及不同
peer 隔離；`AutomaticTransportPolicyTest` 驗證缺 GMS、逐級降級、冷卻、忙碌保護、成功連線保留。
`AutoPeerSyncEngineTest` 驗證 BLE 優先等待期間仍可見，解除等待或收到對方 HELLO 後正常交換。
Flutter 測試涵蓋自動模式、降級原因、原生備援不受 GMS 阻擋、進階覆寫與 Web 不輪詢 native API。

單機啟動測試（先授權並開啟 Bluetooth/Wi-Fi，關閉正式緊急模式，避免搶同一個 GMS client）：

```text
adb -s <serial> shell am instrument -w -e nearby_smoke true -e class com.resilientgeo.mesh.transport.NearbyStartupInstrumentedTest com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
```

加上 `-e auto_smoke true` 可在沒有其他 mesh peer 的單機環境驗證真實緊急服務先啟動
Nearby + BLE，再因 Nearby 搜尋逾時切換 Wi-Fi Direct + BLE。需系統定位開啟；測試結束
會關閉服務並恢復原本的傳輸模式設定。

雙機完整驗證：兩台同時執行 `RealPeerSyncInstrumentedTest`，指定 `-e peer_transport nearby`，
一台 `-e peer_seed flood`、另一台 `-e peer_seed road`。測試以暫存金鑰即時簽署 FLOOD／ROAD_BLOCKAGE
群眾回報，使用獨立 in-memory Room 及暫存快取，驗證分片互補及第二次相遇不重複接收。
舊 `shelter` 參數保留作為 `flood` 的相容別名；不再載入被現行來源規則拒絕的 official 示範分片。

先關閉行動數據並保留 Wi-Fi radio，再加 `-e peer_offline true`：測試會暫時斷開目前的 Wi-Fi AP，
驗證期間持續拒絕可上網的網路，結束後恢復該 AP。原本未連 AP 也可測試；其他已儲存 AP 若自動連上，
測試會失敗。外層測試腳本須在 finally 恢復 Wi-Fi／Bluetooth／行動數據／定位原始設定。

若手機既有 App 由不同金鑰簽署，可用 `-PmeshTestApplicationIdSuffix=.nearbytest` 建置 debug App 與
測試 APK，安裝為 `com.resilientgeo.mesh.nearbytest`／`com.resilientgeo.mesh.nearbytest.test`，不解除安裝
正式 App。省略參數時仍使用原本的 application ID。獨立測試 App 測完即可移除。

## 本次驗證紀錄（2026-10-10）

- Android JVM：198 項測試通過；debug App 與 instrumentation APK 建置成功。
- Flutter：`flutter analyze` 無問題；完整測試 286 項通過，另 1 項大型離線地圖 hash 校驗
  在同時建置時逾時，單獨重跑通過。同步頁最終 8 項測試通過。
- Web：release build 成功；Web 同步頁不呼叫 native API 的 widget 測試通過。
- SH-M32 / API 36 / Google Play services 26.32.34：2 項 opt-in 實機測試通過（33 秒）。
  Nearby 廣播與搜尋啟動成功，這次沒有重現歷史 INTERNAL_ERROR；自動服務先顯示
  Nearby + BLE，無對端約 30 秒後切換為 Wi-Fi Direct + BLE，原因為 `nearby_no_peer`。
  測試後關閉服務並恢復原本 Wi-Fi 關閉狀態，更新安裝保留既有 App 資料。

上述單機結果只證明啟動與服務切換，也未在該次單機測試中封鎖所有網際網路連線。

## 雙機離線實測（2026-10-11）

| 手機 | Android API | Google Play services | 測試結果 |
| --- | --- | --- | --- |
| Pixel 8a | 37 | 26.37.37 | 通過，17.947 秒 |
| Sharp SH-M32 | 36 | 26.32.34 | 通過，15.350 秒 |

- 兩台使用同一份隔離測試 App；Pixel 既有正式 App 簽章不同，因此沒有解除安裝或覆蓋它。
- 關閉行動數據，暫時斷開 Wi-Fi AP，Wi-Fi／Bluetooth radio 保持開啟；兩端皆記錄
  `OFFLINE_CONFIRMED`，交換與重逢期間的無網際網路檢查均通過。
- 首次相遇：Pixel 持有 FLOOD，Sharp 持有 ROAD_BLOCKAGE，即時 Ed25519 簽章的群眾回報。
  兩端各收到並驗證套用 1 個分片，Room 各有 2 個分片；皆記錄 `FIRST_EXCHANGE_OK`。
  本輪 TRANSFER 訊息約 1.94／1.95 KB。
- 停止 transport、等待 5 秒，再建立新身分與連線：兩端皆記錄 `already in sync` 與
  `SECOND_ENCOUNTER_OK`，`chunksApplied=0`，未重複下載。
- 本輪沒有出現 Nearby `INTERNAL_ERROR`。最初測試在載入舊 official 示範資料時失敗，
  原因為它已不符合目前來源白名單；測試已改用現行正式支援的群眾回報，沒有放寬驗簽或來源規則。
- 測後已移除本次暫時測試 App，保留兩台原 App 與資料，恢復原始行動數據／Wi-Fi／Bluetooth／定位設定。
- Flutter：以 Android 原生交換層與正式 repository 完成本次雙機驗收；本次未更動 Flutter 畫面。
  Web：不支援原生 Nearby，本次未更動 Web；平台說明頁的建置與 widget 驗收沿用 2026-10-10 紀錄。

此結果涵蓋這一組機型的小型回報互傳與重逢去重；不代表已完成其他機型、鎖屏、長距離、
大型檔案、長時間耗電或吞吐量測試，也沒有宣稱 SDK 當下必定使用 Wi-Fi。

## 後續安裝與已知問題（2026-10-11）

- Pixel 原 App 的簽章與本機 debug APK 不同。依使用者要求，以原套件 ID 安裝新版：先備份原 APK、
  資料庫、離線地圖與設定，再移除舊版、安裝新版並還原資料；資料庫（含 WAL）與 Flutter 設定的
  SHA-256 比對一致，主畫面可正常啟動。Android Keystore 包裝金鑰無法隨不同簽章移轉，
  未還原舊加密 seed，新回報會建立新的裝置簽署身分。備份與手機操作腳本僅保存在忽略的本機目錄。
- 避難所未顯示是另一個尚未修復的資料服務問題：兩台原 App 都未取得新版 `static-layer-bundles`
  快取；目前設定的 `https://resilientgeo-feed.pages.dev/` 在
  `/v1/layers/taiwan-shelter/manifest.json` 回傳 HTTP 200、`text/html` 首頁，而非簽章圖層 JSON。
  `main` 既有載入邏輯已改為先下載再離線快取，不再讀取舊內建 `shelter` 圖層。
  本次 Nearby PR 不包含資料服務部署、舊快取遷移或靜態圖層錯誤提示修復；更新 App 本身不會恢復點位。

## 歷史根因與來源

2026-09-05 的兩台 API 37 Pixel 回報 INTERNAL_ERROR，是未查明的歷史啟動失敗。
舊 Manifest 未包含 ACCESS_LOCAL_NETWORK，且舊 adapter 只記錄接收 log；不能沿用「確定只能 Google 修」的結論，
也不能在未重測前認定補權限就一定解決。

- [Nearby 概述](https://developers.google.com/nearby/connections/overview)
- [Android 權限](https://developers.google.com/nearby/connections/android/get-started)
- [BYTES 與傳輸完成語義](https://developers.google.com/nearby/connections/android/exchange-data)
- [傳輸策略](https://developers.google.com/nearby/connections/strategies)
- [Kotlin 與 D8/R8 相容版本](https://developer.android.com/build/kotlin-support)
