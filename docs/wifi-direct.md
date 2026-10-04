# Wi-Fi Direct 同步

2026-10-04：新增可選的 Android Wi-Fi Direct transport，沿用現有
HELLO / DIFF / REQUEST / TRANSFER、簽章驗證、Room 與分片快取。
藍牙仍是預設。兩種傳輸方式需在兩台手機上選擇一致；目前不自動切換。

## 使用

1. 兩支手機安裝同一版 App，到「個人設定 → 同步狀態」。
2. 關閉緊急模式，將傳輸方式改為「Wi-Fi Direct」。
3. 開啟 Wi-Fi、系統定位服務，允許附近 Wi-Fi 裝置權限；Android 12 以下需精確定位權限，Android 17 以上另需區域網路權限。
4. 兩台開啟緊急模式，若 Android 顯示連線邀請，接受邀請。
5. 同步頁顯示附近節點、同步次數、已接收並驗證的分片與失敗原因。

不需網際網路或同一個無線基地台。一次加入一個 P2P 群組，Android 可能因機型與既有
Wi-Fi 連線而限制建群；若失敗，可關閉緊急模式、切回藍牙，再開啟。
切換模式不會清除已驗證資料。

## 實作與邊界

- DNS-SD 只接收 `resilientgeo._rgmesh._tcp`、版本 1 的服務，身分是每次 transport
  啟動隨機產生的 128-bit 識別碼。這是連線路由資訊，不是官方或裝置身分認證。
- 依身分排序決定由哪一方發起邀請，避免双方同時邀請。Android 決定群組擁有者。
- 群組擁有者監聽實際 P2P 介面的 IPv4 位址。Client 優先把 socket 綁到介面名稱一致
  的 Android Network，另綁定 P2P 來源位址；不更改 App 的全域預設網路。
- TCP 使用有長度上限的訊息框架（4 MiB），完整收到後才交同步引擎。簽章、hash、版本及
  TTL 驗證仍由原有 ingest 處理。Socket 寫入成功不等於對方驗證成功。
- Socket 握手／讀取／寫入有期限，讀取與寫入並行；閒置 keepalive 不會計入同步資料。
  當一側同步完成時保留雙向 socket，避免切斷另一側尚在處理的資料。
- Wi-Fi Direct 不支援半片續傳。實際斷線後重新比對庫存，完整分片不重傳，未完成訊息
  從頭重傳。服務停止、Wi-Fi 關閉或群組失去時釋放 socket 與服務探索資源。
- 前景服務改用 `connectedDevice` 類型，對應持續與附近裝置交換資料的用途。
- 這是單群組同步，尚未實作 Wi-Fi 多群組自動漫遊、BLE 引導升級或自動 fallback。
- 搜尋使用 0.1～2.5 秒隨機啟動延遲，首次搜尋約 6 秒後刷新，後續以 7～13 秒
  隨機間隔刷新服務查詢；收到原生搜尋停止事件時縮短恢復等待。實驗過的搜尋／
  listen 交替沒有證明優於舊流程，已移除正式 transport 的顯式 listen 切換。
- 只在已發起連線邀請、平台回報正在邀請或已建群時暫停重掃。收到對方服務不代表
  對方也看見自己；當本機依身份排序等待對方邀請時，仍持續搜尋重試，避免
  整段最長 85 秒的被動等待都沒有恢復搜尋的機會。這些間隔不是發現期限保證。
- Wi-Fi Direct 同步失敗後的冷卻時間由 15 秒改為 3 秒，BLE 維持原值。
  `ResilientGeoWifi` 記錄相對啟動時間、原生 peer 數、服務發現及搜尋狀態，
  區分尚未發現裝置、尚未取得 App 服務與建群延遲。

## 驗證

JVM `WifiDirectFramingTest` 包含真實 loopback TCP 雙向傳送、1 MiB payload、連續訊息、
keepalive、截斷訊息及惡意長度拒收。Flutter 測試覆蓋傳輸選擇、執行中禁止切換及 Wi-Fi
狀態不依賴藍牙權限。

雙機 instrumentation 使用獨立記憶體 Room 與暫存快取，不修改正式災情資料。在兩台
已授權且 Wi-Fi／定位開啟的手機同時執行（必要時接受系統邀請）：

```text
adb -s <phone1> shell am instrument -w -e class com.resilientgeo.mesh.data.RealPeerSyncInstrumentedTest -e peer_transport wifi_direct -e peer_seed shelter com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
adb -s <phone2> shell am instrument -w -e class com.resilientgeo.mesh.data.RealPeerSyncInstrumentedTest -e peer_transport wifi_direct -e peer_seed road com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
```

確認 `FIRST_EXCHANGE_OK`（雙方各取得一片並驗證）及 `SECOND_ENCOUNTER_OK`（重建
transport 後沒有新增分片）。

完整離線回歸另加 `-e peer_offline true`：測試開始前兩台須連上控制用 Wi-Fi、
關閉行動數據並保持亮屏。`OfflineWifiTestNetwork` 暫時停用該已儲存網路，確認
沒有 Wi-Fi／行動數據 INTERNET network 後才開始交換，最後恢復控制網路。
無線 ADB 會中斷，須在手機內以 detached 程序執行並保存 instrumentation／
`RealPeerSyncTest`／`ResilientGeoWifi` 輸出，不能依賴持續連線的電腦 shell。
測試只驗證亮屏條件；鎖屏與 Doze 需另行驗收。Samsung 可能需要恢復原本的無線
偵錯設定才能取回結果；不要因此重置 App 或清除資料。

### 2026-10-04 實機結果

- Pixel 8a（Android 17 / API 37）與 Samsung SM-A5360（Android 16 / API 36）各通過
  `RealPeerSyncInstrumentedTest`。初次建群由使用者接受 Android 系統邀請。
- 第一輪兩側各收到 1 個原先缺少的簽章分片，Room 庫存由 1 片增加為 2 片，
  `peersSynced=1, chunksApplied=1`。兩側附近節點均僅計入另一台測試手機。
- 停止並重建兩側 transport 後再次建群，兩側均 `peersSynced=1, chunksApplied=0`，
  記錄 `already in sync`。完整測試各耗時 50.681 秒、47.947 秒（含邀請等待與重連）。
- Pixel 在 `p2p-wlan0-0 / 192.168.49.1:8988` 監聽，Samsung 綁定 P2P 來源介面後連入。
  本次 Samsung 的 `ConnectivityManager` 未提供對應 Network；來源位址綁定仍成功。
  兩台與電腦的無線 ADB 使用 192.168.0.x，沒有用該區網充當資料傳輸路徑。
- 測試使用同一份已編譯原生程式的精簡通訊包（移除地圖與 Flutter UI 資產），
  獨立記憶體 Room／暫存快取；測試後回裝完整 App，兩台已安裝 APK 的 SHA-256
  均與完整建置產物一致。這不等同完整 UI 雙機交換或長時間背景驗收。
- 完整 App 在 Pixel 同步頁完成傳輸方式選擇、啟動與停止；藍牙關閉時 Wi-Fi Direct
  前景服務仍正常探索，觀察約 45 秒、9 次 heartbeat 無錯誤。測試結束後恢復預設
  BLE、關閉緊急模式並恢復兩台原本的螢幕逾時；兩台皆無殘留 P2P 群組。
- JVM 168 項通過，Flutter 260 項通過，Flutter analyze 無問題；完整 debug APK 建置成功。
- 原始記錄：本機忽略目錄 `android/build/wifi-{pixel,samsung}-test-3.log` 與
  `wifi-{pixel,samsung}-success-logcat.log`。

實測迭代：第一輪能發現並收到邀請，但建群逾時。禁止在連線協商期間重啟
`discoverServices`，並把 transport 自己的逾時轉為一般失敗，讓引擎能重試。
第二輪發現 Samsung 在 `stopPeerDiscovery` 後發出 DEVICE_LOST 並拒絕 connect；
改由 connect 自行管理搜尋停止後，第三輪完成以上兩階段驗證。

### 同日使用者協助的離線手動測試

使用者依步驟斷開路由器、關閉行動數據後，在完整 App 建立各自的回報並開啟
Wi-Fi Direct；測試後連回路由器取得兩側既有 logcat。離線操作由使用者執行，
並非由電腦連續監控網路狀態。原始記錄位於本機忽略目錄
`android/build/wifi-offline-{pixel,samsung}-logcat.log`。

- 兩台約 11:08:04 啟動；Samsung 11:08:04.316 開始探索，11:09:46.986 才發現
  Pixel，約 103 秒。Pixel 同期持續顯示探索中、附近節點為 0，11:09:46.162
  發現 Samsung。不是另一台較晚開啟所造成的等待。
- Pixel 初次邀請立即收到 Android 通用錯誤碼 0；約 16.5 秒後重試。
  11:10:04 左右兩側建立 P2P TCP 連線。錯誤碼本身不足以判定底層原因。
- Pixel 傳出 502 個不同 ID 的分片，合計 1,941,295 bytes（TRANSFER 訊息大小）：
  501 片 `government-shelter-status` 與 1 片群眾回報；Samsung 記錄恰好
  502 次接受、502 個不同 ID，這段沒有拒收記錄。反向傳送並接受 1 片群眾回報。
- Pixel 11:10:10.967 完成本地同步流程，但 Samsung 到 11:10:21.366 才完成
  全部接收與驗證。完整結果應以較晚的一側為準：約 137 秒，其中連線後約 17 秒。
  不應把 Pixel 約 6 秒的本地完成時間當成雙向完整驗收時間或純無線吞吐量。
- 後續同連線再次核對庫存，兩側記錄 `already in sync`，接收計數未再增加。
  這不是另外一次斷線重連測試。

目前已定位主要等待在裝置／服務發現階段，約占 103 秒；這次結果不符合短暫
擦身接觸的延遲需求。後續已修改上述搜尋排程，但尚不能把它認定為該次 103 秒
等待的唯一底層原因，改善幅度須以對照測試為準。

### 搜尋延遲診斷與回歸

`WifiDiscoveryProbeTest` 是 opt-in 雙機探索診斷；`discovery_probe` 可選
`legacy`（舊版固定重啟）、`steady`、`listen`、`jitter`（隨機重掃間隔）或
`transport`（目前候選版 transport）。
只探索、不建立資料連線、不修改災情資料，將單調時間計時寫到 app-private 的
`files/wifi-discovery-probe-<probe_run>.log`，測試端可透過 `run-as` 讀取。

設定 `probe_offline=true` 時，測試須從已連線的控制用 Wi-Fi 開始，手機行動數據
須事先關閉。測試暫時停用該已儲存網路、保留 Wi-Fi 開關，確認無 Wi-Fi／行動數據
INTERNET network，最後在 `finally` 恢復原網路。使用 Android instrumentation 的
shell 權限僅切換測試條件；進入搜尋前即放棄該權限。從無線 ADB 執行時應以裝置內
脫離 ADB 生命週期的程序啟動並保存輸出。若程序被強制終止，需手動連回控制用 Wi-Fi。
測試不讀取／刪除密碼，也不修改正式 App 所需權限。

初次 `legacy1` 探索在 Pixel 約 4.85 秒取得服務；該輪使用了
`probe_global_autojoin_off=true` 等效條件，會同時停用系統尋找基地台的掃描，
因此不當成原手動離線條件的直接對照，亦不能據此宣稱已修好 103 秒問題。
後續診斷預設改為只停用目前連線的網路，保留系統其他掃描行為。

搜尋排程的 6 項 JVM 測試涵蓋：啟動與重試間隔、協商暫停與恢復、停止搜尋事件
恢復、失敗退避、不同隨機序列不保持同步，以及原生 STOPPED→STARTED／重複
STARTED 廣播不造成快速重掃或無限延後恢復。
此版 JVM 合計 174 項通過，完整 debug APK 建置成功。

先前候選版的 Pixel 單機觀察已確認約 26.9 秒收到 LISTEN 成功回應、約 32.5 秒恢復 SEARCH；
沒有搜尋 API 失敗。該輪無另一台服務可發現，因此雙機 probe 的「找到對方」斷言
未通過，不能列為雙機成功或延遲改善證據。

同日晚間將相同完整候選 APK 安裝至兩台，安排四輪離線探索對照。Pixel 保存的結果
如下；每輪均確認已斷開控制 AP、保留 Wi-Fi 且無行動數據 INTERNET network。

| 輪次 | 流程 | Pixel 首次取得服務 | 觀察時間 |
| --- | --- | --- | --- |
| legacy2 | 舊版固定重掃 | 12.854 秒 | 90 秒 |
| fixed1 | 候選搜尋／listen 排程 | 47.055 秒 | 60 秒 |
| legacy3 | 舊版固定重掃 | 17.043 秒 | 90 秒 |
| fixed2 | 候選搜尋／listen 排程 | 未取得 | 60 秒 |

**這組結果不能作為有效速度對照。** 取回 Samsung 紀錄後發現，其 `fixed1`
原定 60 秒卻於 128.850 秒才結束，`fixed2` 更於 494.500 秒才結束；後續輪次
已與 Pixel 錯開，且 `legacy3`／`fixed2` 均未發現服務。疑似 CPU 休眠影響測試
延遲，不能把這組數字歸因於搜尋演算法。最初使用者手動測試的 103 秒等待期間
仍有規律的服務 heartbeat，不能直接套用此休眠推論。
原始 Pixel 記錄位於本機忽略目錄 `android/build/wifi-pixel-{legacy2,fixed1,legacy3,fixed2}.log`。
後續 probe 已增加 epoch 時間記錄與休眠／超時檢查；重跑前以測試腳本喚醒兩台，
暫時延長螢幕逾時，最後恢復原設定。亮屏離線探索重測如下（各輪 60 秒，兩側
均找到對方，實際計時正常，開始時間相差約 1.7～2.8 秒）：

| 輪次 | 流程 | Pixel 首次取得服務 | Samsung 首次取得服務 |
| --- | --- | --- | --- |
| legacy4 | 舊版固定重掃 | 4.545 秒 | 5.340 秒 |
| fixed3 | 搜尋／listen 交替候選版 | 6.347 秒 | 10.081 秒 |
| jitter1 | 隨機重掃 | 6.181 秒 | 8.921 秒 |
| jitter2 | 隨機重掃 | 5.561 秒 | 8.446 秒 |

本輪沒有重現 103 秒延遲，也不足以證明隨機重掃平均比舊版快；不能宣稱根因已完全
消除。正式修正採用隨機重掃、保留協商保護並解除被動等待時的重掃限制，另將
連線失敗冷卻縮至 3 秒。探索紀錄為本機忽略目錄
`android/build/wifi-{pixel,samsung}-{legacy4,fixed3,jitter1,jitter2}.log` 與
`wifi-{pixel,samsung}-awake-logcat.log`。

排程腳本另發現 Android shell 的整數乘法會溢位，原本的 epoch 秒乘 1000 沒有
產生正確的毫秒值，因此上述比較使用實際記錄的起訖時間，不能聲稱同一毫秒啟動。
腳本已改用秒數文字附加 `000`，probe 也拒絕過期起始時間。正式 transport 使用
`SystemClock.elapsedRealtime()`，沒有這個 shell 計算問題。

### 2026-10-04 深夜至 10-05 的修正版離線同步回歸

兩台均安裝相同完整 APK，SHA-256 為
`d4c9346e2851ab4b9b15c14d5f00310921548d2dd1b3052efefaa925bd0ec6ee`。
`RealPeerSyncInstrumentedTest` 使用 `peer_offline=true`，兩側先確認已脫離控制 AP
且沒有行動數據 INTERNET network，再執行兩次獨立建群；測試期間保持亮屏。

| 驗證項目 | Pixel 8a | Samsung SM-A5360 |
| --- | --- | --- |
| 首次服務發現（相對本機 transport 建立） | 11.994 秒 | 8.360 秒 |
| 首次同步完成（相對本機引擎啟動） | 15.018 秒 | 10.294 秒 |
| 首次交換結果 | 收到並驗證 1 片，庫存 1→2 | 收到並驗證 1 片，庫存 1→2 |
| 重建 transport 後服務發現 | 6.946 秒 | 11.742 秒 |
| 第二次交換結果 | already in sync，新增 0 片 | already in sync，新增 0 片 |
| 完整 instrumentation 結果 | PASS，34.851 秒 | PASS，30.033 秒 |

兩次均由 Samsung 發起邀請、Pixel 擔任群組擁有者，TCP 使用 P2P 的
`192.168.49.1:8988`。Pixel 建群初期短暫沒有 P2P IPv4，下一次查詢即成功啟動
listener；未造成測試失敗。兩側最後均恢復行動數據與原螢幕逾時，Samsung 的
無線偵錯仍由使用者協助重新開啟後才取回紀錄。

這是修正版的真實離線雙向傳輸與重連證據，不代表所有啟動都能在 15 秒內完成，
也不是 502 片的大批資料或完整 Flutter UI 操作回歸。原始紀錄為本機忽略目錄
`android/build/wifi-{pixel,samsung}-offline-final.out` 與
`wifi-{pixel,samsung}-offline-final-logcat.log`。測後測試 transport 已關閉；使用者
若要繼續 App 測試，重新開啟 App 後將緊急模式關閉再開啟。

尚未驗收：反向群組擁有者、其他機型、多人同群組、全台規模資料、反覆離線連線
成功率、長時間 Doze／鎖屏及耗電。上述交換不作為純 Wi-Fi 吞吐量或覆蓋距離量測。

## 參考

- [Android Wi-Fi Direct](https://developer.android.com/develop/connectivity/wifi/wifi-direct)
- [DNS-SD 與權限](https://developer.android.com/develop/connectivity/wifi/nsd-wifi-direct)
- [單一 socket 綁定 Network](https://developer.android.com/reference/android/net/Network#bindSocket(java.net.Socket))
- [Android 17 區域網路權限](https://developer.android.com/about/versions/17/behavior-changes-17)
- [Android 搜尋／listen API](https://developer.android.com/reference/android/net/wifi/p2p/WifiP2pManager#startListening(android.net.wifi.p2p.WifiP2pManager.Channel,android.net.wifi.p2p.WifiP2pManager.ActionListener))
- [AOSP P2P 服務實作](https://android.googlesource.com/platform/packages/modules/Wifi/+/refs/heads/master/service/java/com/android/server/wifi/p2p/WifiP2pServiceImpl.java)：`DISCOVER_SERVICES` 會更新 supplicant 的服務查詢再啟動完整搜尋；這是比較不同重掃排程的依據，不能單獨證明舊實測 103 秒的原因，也不能證明減少重掃一定較快。

ADR-001 的 2026-09-05 結果是舊實作與舊測試紀錄，保留作為歷史；不將其推論為所有
Android 手機都需要 root 才能使用 Wi-Fi Direct。
