# 量測模式（2026-10-30 實作）

目的：替 `docs/finals-field-test-plan.md` 產生可重複、可匯出的數據。量測模式做到這幾件事：

- 固定只用一種傳輸。
- 選擇資料量。
- 在手機上輸入距離和環境。
- 每一次試驗自動寫一列 CSV。

距離測試時手機離電腦很遠，所以操作都在手機上完成，量完再用 `adb pull` 拉回 CSV。

## 已決定

1. 量測畫面用**原生 Kotlin**。
2. 負載用 App **內建台灣資料的事件內容**，由發送端用**量測金鑰重簽**（見下方〈資料〉）。
3. **兩個階段一起做**。
4. **Web 不做量測模式**（瀏覽器沒有 BLE GATT、Nearby、Wi-Fi Direct）。Web 的量測（測試計畫第 14 項）用 Chrome DevTools 節流完成。

## 兩個階段

| 階段 | 內容 | 對應測試計畫 |
| --- | --- | --- |
| **一：量測畫面** `debug/MeshMeasureActivity` | 固定傳輸、選資料量、逐次 CSV | 1 距離、2 吞吐量、3 重複相遇、6 三台接力、8 走路錯身、9 機型、10 擁擠、11 多台 |
| **二：正式服務量測紀錄** `measure/ServiceMeasurementLog` | 正式 `EmergencyModeService` 寫入每次同步結果，並每 5 分鐘記錄電量、螢幕和 Doze | 4 鎖屏與 Doze、5 耗電、7 完整情境（自動選擇） |

鎖屏和耗電一定要測正式服務。量測畫面會讓螢幕一直亮著，測出來不是真實情況。

## 資料

原本打算直接用 `assets/events/taiwan/ncdr-hazard-events` 的 203 片簽章分片，實作時發現行不通：

- 這 203 片的簽章全部無法用 App 信任的 `taiwan-static-2026` 公鑰驗證（hash 正確，簽章不符）。
- 目前也沒有任何 Kotlin 程式讀取這份資料。

改用的做法：

- 發送端讀取這些分片，保留事件內容和幾何，改寫命名空間（`measure.exercise`）、資料集（`measure-taiwan`）、有效期限（+1 天）和金鑰，再重新簽事件與分片（`MeasurementSigner`）。
- 量測金鑰 `measurement-local-v1` 由公開字串推導，每台手機算出的結果相同，所以離線也不用先交換金鑰。
- 只有量測畫面的獨立資料庫信任這把金鑰，正式資料庫和其他手機的一般 App 都會拒收。有測試確認：同一片資料用正式 trust store 驗證會失敗。
- 接收端走正式的 `MeshRepository.ingestChunk` 驗章和套用流程。

級距依 manifest 的 `size_bytes` 由小到大累加選片。`size_bytes` 比整片 JSON 小，實際傳輸量以右欄（原始分片壓縮成單行 JSON 的 UTF-8 位元組）為準。重簽後大小與原片相差 2% 以內（單元測試確認），實際收到多少以 CSV 的 `received_bytes` 為準：

| 級距 | 片數 | manifest `size_bytes` | 整片壓縮 JSON |
| --- | --- | --- | --- |
| 1 片 | 1 | 2,568 | 3,151 |
| 約 50 KB | 20 | 52,376 | 64,036 |
| 約 1 MB | 157 | 1,648,514（第 157 片較大，所以超過 1 MB） | 1,738,722 |
| 約 10 MB | 168 | 10,489,966 | 10,586,609 |
| 全部 | 203 | 38,702,775（最大一片約 2.2 MB，低於 4 MiB 上限） | 38,819,739 |

- BLE 最多只能選到「約 1 MB」。
- CSV 會記錄實際收到的位元組數。
- 資料庫用暫存檔，不放在記憶體，39 MB 也不會撐爆記憶體；離開畫面就刪除。

## 時間點

`AutoPeerSyncEngine` 多了一個預設不做事的 `onTrace` 回呼，事件依序為：

1. `PeerSeen`（含 RSSI）
2. `Connecting`
3. `Connected`
4. `HelloReceived`
5. `Requested`（片數、位元組）
6. `ChunkApplied`（訊息位元組）或 `ChunkRejected`
7. `SessionEnded`（成功，或失敗碼）

另外新增 `exchangeTimeoutCapMillis`，預設 300 秒，跟原本寫死的值相同。量測畫面會把它放大到試驗的逾時時間，大資料才不會被 5 分鐘上限切斷。正式 App 行為不變。

## 使用方式

安裝 debug APK 後，兩台手機都開啟量測畫面。手機不連電腦時，也可以在手機上用任何能開 activity 的方式進入：

```bash
adb shell am start -n com.resilientgeo.mesh/.debug.MeshMeasureActivity
```

**事前準備**：

- 先關閉一般 App 的緊急模式，否則量測畫面會拒絕啟動。
- 兩台選同一種傳輸。
- 附近不要有其他開著緊急模式的手機。
- **正式數據要讓兩台都離開 Wi-Fi**（忘記網路，或關掉路由器／熱點）。兩台連同一個 Wi-Fi 時，Nearby 可能改走路由器，Wi-Fi Direct 也可能受影響，測出來會比沒有網路的災害現場好看。量完再接電腦或連回 Wi-Fi 拉 CSV。

**發送端**：

1. 角色選「發送端」，選資料量。
2. 按「發送端：載入資料」，重簽並驗章，載入全部約需數分鐘。
3. 按「發送端：開始提供」。

**接收端**：

1. 角色選「接收端」。
2. 填測試代號（例如 `distance-wifi`）、距離、環境、備註和逾時秒數。
3. 按「開始一次試驗」，或填好次數和間隔後按「連續試驗」。
   - 每次試驗都會換新的無線身分和空資料庫，所以發送端每次都當成第一次相遇。
   - 勾「保留資料」時，接收端不清空，試驗結束後無線電也繼續開著，可以轉送給第三台。這用在再次相遇和三台接力。
4. 畫面會顯示即時進度，以及本次的成功率、完成時間 p50／p95 和中位數 KB/s。

**用 adb 操作（無人值守）**：畫面是 `singleTop`，可以重複送指令給同一個畫面。指令會先把欄位填好，再按對應的按鈕，畫面上也會記一行「adb 指令：…」。

```bash
adb -s <發送端> shell am start -n com.resilientgeo.mesh/.debug.MeshMeasureActivity --es cmd load --es role sender --es tier MB1 --es transport nearby
adb -s <發送端> shell am start -n com.resilientgeo.mesh/.debug.MeshMeasureActivity --es cmd provide --es role sender --es transport nearby
adb -s <接收端> shell am start -n com.resilientgeo.mesh/.debug.MeshMeasureActivity --es cmd trials --es role receiver --es transport nearby --es test_id desk-nearby-mb1 --es distance 1 --ei timeout 300 --ei gap 35 --ei count 5
```

- `cmd`：`load`、`provide`（已在提供時會先停再開）、`trials`、`stop`。
- `tier`：`ONE`、`KB50`、`MB1`、`MB10`、`ALL`。
- 進度看 logcat 的 `MeshMeasure` 標籤：「發送端已載入」、「第 N 次：成功／失敗」。

**取回 CSV**：

```bash
adb pull /sdcard/Android/data/com.resilientgeo.mesh/files/measurements/
```

- `measure-<日期>-<機型>.csv`：量測畫面寫的。
  - 接收端每次試驗一列。
  - 發送端每次服務一列，`trial` 欄為 0。
- `service-<日期>-<機型>.csv`：正式服務寫的。

**量測畫面 CSV 欄位**：

- `wall_clock_start`、`wall_clock_end`：三台接力時用來對時，測前先連網校時。
- 試驗條件：`test_id`、`trial`、`role`、`transport`、`device`、`android`、`distance_m`、`environment`、`notes`、`screen`、`keep_data`、`payload_tier`。
- 結果：`success`、`failure_reason`、`attempts`。
- 時間點：`t_discover_ms`、`t_connect_ms`、`t_hello_ms`、`t_request_ms`、`t_first_chunk_ms`、`t_last_chunk_ms`、`t_complete_ms`、`elapsed_ms`，都是相對試驗開始的毫秒數。
- 資料量：`requested_chunks`、`requested_bytes`、`chunks_applied`、`received_bytes`、`rejected_chunks`。`requested_bytes` 是對方摘要裡宣告的大小（跟 manifest 的 `size_bytes` 同一種算法，比實際小），算吞吐量請用 `received_bytes`。
- `bytes_per_second`：`received_bytes` 除以「REQUEST 到最後一片」的時間。
- `rssi_min`、`rssi_median`、`rssi_max`：只有 BLE 有值。
- `battery_pct`。

**正式服務紀錄（鎖屏、Doze、耗電）**：

1. debug 版同步頁最下方有「量測紀錄（開發版）」開關，打開後開啟緊急模式。
2. 每次同步結果寫一列 `outcome`。開始、停止各寫一列，執行中約每 5 分鐘寫一列 `sample`，內容包括電量、是否插電、螢幕、`device_idle`、省電模式和目前傳輸。
3. Doze 會拉長服務的迴圈間隔，所以 `sample` 之間的空檔本身就是量測結果。
4. release 版沒有這個開關，也不會寫檔。

## 已知限制

- **Samsung 的 Wi-Fi Direct 邀請框**：系統邀請框需要有人按，沒按就會記成 `connection_failed`。程式分辨不出是沒按還是傳輸失敗，請在 `notes` 註明「邀請未接受」。2026-10-31 兩台都鎖屏時，Pixel 發的邀請 Samsung 不用按就加入了（兩台之前已連過多次），第一次相遇的手機仍要注意。
- **量測畫面要在前景、手機要解鎖**：鎖屏後螢幕熄滅會進入 Doze，發送端載入會卡住；畫面退到背景時，系統可能把 Wi-Fi Direct 閒置關閉（見下方問題 4）。
- **RSSI**：Nearby 和 Wi-Fi Direct 平台不提供，欄位為空。
- **Nearby 連續試驗可能卡啟動**：上一次的 Nearby 連線要等 Play services 約 30 秒才完全關閉，期間新的廣播和掃描可能啟動失敗。量測畫面在 20 秒內沒有就緒就會換一個新的傳輸重來，該列 `notes` 會加上 `[radio-restarts=N]`，等待時間算在這一次裡。分析時把這些列另外列出或排除；要避免的話，Nearby 的間隔設 30 秒以上。正式服務本身已有同樣的 30 秒重啟機制。
- **跨日**：CSV 依手機日期命名，跨過午夜的連續試驗會分在兩個檔案。
- **發送端紀錄**：發送端每次連線一列，時間從這次連線的第一步（連線或 HELLO）算到結束，沒有發現時間，也不記送出的位元組數。距離等條件以接收端填寫的為準。
- **本次統計**：換傳輸方式時自動清除；換距離或環境不會清除，請按「清除本次統計」。CSV 不受影響，每一列都完整保留。
- **BLE 傳不完「約 1.7 MB」**：同步引擎每次連線最多 300 秒（`EXCHANGE_TIMEOUT_CAP_MS`）。BLE 約 3.5 KB/s，這個級距需要約 8 分鐘，其中一片就約 0.7 MB。10-31 實測每次都在 300 秒被切斷，收到 156／157 片，之後的重連都是 `hello_timeout`。第 3 個傳輸問題修正後，10-31 08:28 實機 2/2 成功（約 540 秒）：第一次連線在 300 秒被切斷，重連後只補剩下那一片。量 BLE 1.7 MB 時逾時至少設 900 秒。
- **接收端 `payload_tier` 欄為空**：接收端不知道發送端載入哪一級，請用 `test_id` 標示（例如 `desk-nearby-mb1`）。

## 驗證

| 項目 | 結果 |
| --- | --- |
| Android 單元測試 | `testDebugUnitTest` 全部通過，含新增的 `MeasurementTrialTest`、`MeasurementPayloadTest`（各級距片數；重簽後通過正式 `ChunkVerifier`／`EventVerifier`，正式 trust 拒收）和 `AutoPeerSyncEngineTest` 的 trace 順序 |
| Flutter | 487 個測試通過（新增量測紀錄開關測試）；`flutter analyze` 無問題；`flutter build web --release` 成功 |
| Instrumented | 新增 `MeasurementPayloadInstrumentedTest`：50 KB 級距用暫存檔資料庫走正式 ingest、正式 trust 拒收、服務紀錄只在開啟時寫入，並寫到暫存資料夾 |
| Instrumented（Pixel 8a，2026-10-30） | `MeasurementPayloadInstrumentedTest` 2/2 通過；完整 instrumented 測試 48 個通過（雙機配對測試未帶參數時略過） |
| 單機實機（Pixel 8a，2026-10-30） | 量測畫面開啟正常；發送端載入「約 50 KB」：20 片重簽並驗章通過，63,806 bytes（原片 64,036）。同步頁「量測紀錄（開發版）」開關可開關，設定確實寫入。實機發現並已修正：Android 15 以上的狀態列遮住標頭、預填欄位沒有標題、深色模式標頭字看不清、載入位元組數誤用字元數 |
| Instrumented（Samsung SM-A5360，2026-10-30） | `MeasurementPayloadInstrumentedTest` 2/2 通過 |
| 雙機實測（Pixel 8a 發送、Samsung 接收，「約 50 KB」，桌上約 1 公尺；Pixel 連著 Wi-Fi，Samsung 沒有） | 功能驗證，不是決賽數據。Nearby 3/3（6.6–9.9 秒，27–46 KB/s）；Wi-Fi Direct 3/3（排除操作延誤的第 1 次後 8.4–10.4 秒，約 150 KB/s，Samsung 沒有跳邀請框）；BLE 3/3（20.3–22.7 秒，約 3.5 KB/s，RSSI −38）。每次都收齊 20 片、約 65 KB，各時間點依序遞增；發送端記到的成功次數與接收端一致。實機發現並已修正：發送端時間改成單次連線計時、換傳輸方式自動清除本次統計、Nearby 啟動卡住時自動重啟（修正後 Nearby 連續 5 次全部成功，其中 1 次重啟） |
| 單機大資料（Pixel 8a，2026-10-30） | 載入「全部」203 片約 1 分 50 秒，記憶體最高 374 MB，沒有當掉 |
| 桌面基準（2026-10-31 夜間自動執行，106 次接收端試驗） | Pixel 8a 發送、Samsung 接收，桌上約 1 公尺，用 adb 指令無人值守跑完 13 個條件。完整表格見 [`summary.md`](../../adr/evidence/2026-10-31-desk-baseline/summary.md)，原始 CSV 在同資料夾。1 片：三種傳輸各 20/20。50 KB：各 5/5。1.7 MB：Nearby 5/5（約 10 秒）、Wi-Fi Direct 5/5（中位數 15 秒）、BLE 0/5（見已知限制）。10.5 MB：Nearby 2/3（約 30 秒）、Wi-Fi Direct 1/5。全部約 39 MB：Wi-Fi Direct 5/5（中位數 78 秒，約 590 KB/s），Nearby 0/3。失敗都對得上下面「實機發現的傳輸問題」。桌面基準不是決賽數據 |
| 傳輸修正實機驗證（2026-10-31 08:06–08:47） | 修正 1、3 和 Nearby 重連，條件同桌面基準。BLE 1.7 MB 2/2、Nearby 10.5 MB 3/3、Wi-Fi Direct 10.5 MB 5/5（夜間 1/5）、Nearby 39 MB 1/1、Wi-Fi Direct 39 MB 3/3。見 [`summary-wifi-fix.md`](../../adr/evidence/2026-10-31-desk-baseline/summary-wifi-fix.md) |
| Nearby 佇列修正與鎖屏（2026-10-31 11:02–11:49） | Nearby 39 MB 3/3（約 77 秒，一次連線）、Nearby 10.5 MB 3/3、Wi-Fi Direct 39 MB 4/4（另 1 次因畫面被切到背景中斷，見問題 4）。問題 4 修正後重現閒置關閉，Wi-Fi Direct 自己恢復並傳輸成功。兩台鎖屏時 `RealPeerSyncInstrumentedTest` 的 Nearby、Wi-Fi Direct、BLE 雙機都通過。見 [`summary-nearby-queue.md`](../../adr/evidence/2026-10-31-desk-baseline/summary-nearby-queue.md) |

## 實機發現的傳輸問題（正式程式碼）

量測時發現的問題都在正式傳輸程式碼裡，量測模式只是把它們量出來。2026-10-31 經使用者同意修正了下面 1–3 的程式，Android 單元測試 276 個全部通過，全部已實機驗證（[`summary-wifi-fix.md`](../../adr/evidence/2026-10-31-desk-baseline/summary-wifi-fix.md)、[`summary-nearby-queue.md`](../../adr/evidence/2026-10-31-desk-baseline/summary-nearby-queue.md)）。第 4 點是之後發現的，同日經使用者同意修正並實機驗證，Android 單元測試 277 個全部通過。

1. **Wi-Fi Direct 卡在拿不到 IPv4 的群組**（`WifiDirectTransport`）
   - 現象：Pixel 加入群組後一直記「P2P interface has no IPv4 address」，每 3 秒重試。`connect()` 在 85 秒逾時，但群組沒有拆掉；群組存在時暫停掃描，兩邊互相看不到。
   - 次數：10-30 夜間 39 MB 第一次；10-31 夜間 10.5 MB 連續 4 次 `session_failed`（各 85 秒），約 40 分鐘後第 5 次才成功。兩次都發生在 Nearby 大資料傳輸之後。
   - 原因（10-31 實機 log 確認）：群組是 Samsung 新建的，不是留下的舊群組。Pixel 被邀請、被動加入時，系統沿用上一次的 client IP 模式，而 Nearby 升級到 Wi-Fi Direct 時把它設成只拿 IPv6 本機位址（`start Ip client with provisioning mode: 1`），所以拿不到 IPv4。Pixel 自己發邀請時會帶 IPv4 DHCP 設定（mode 0）。
   - 正式 App：掃描狀態是「已就緒」，`maintainLane` 不會重啟這條通道，會卡到服務重啟。
   - **2026-10-31 已修正並實機驗證**：新增 `WifiDirectStaleGroup`。群組存在、本機介面 20 秒拿不到 IPv4、而且沒有任何 socket 時，`WifiDirectTransport` 主動 `removeGroup` 退出，並記下下次要自己邀請。`connect()` 會改由這一方用 IPv4 DHCP 設定邀請；系統還在拆群組而丟掉請求時，隔 2 秒重試，不讓整次連線失敗（`P2P_UNSUPPORTED` 除外）。只做「退出」的第一版，在實機上只會反覆被拉回 mode 1 的群組，所以加了自己邀請這一步。實機：Nearby 10.5 MB 之後的 Wi-Fi Direct 10.5 MB 5/5（夜間 1/5），第 1 次 210 秒，之後沒有再出現 mode 1。正式服務同時只開 Nearby 或 Wi-Fi Direct 其中一條快速通道，所以退出的群組不會是正在使用的 Nearby。單元測試 `WifiDirectStaleGroupTest` 3/3 通過。
2. **Nearby 大資料在頻寬升級時中斷**（`NearbyConnectionsTransport`）
   - 現象：從藍牙升級到 Wi-Fi Direct 的那一刻連線中斷，這次同步記 `transfer_incomplete`。
   - 次數：39 MB 三次都在第 88 片（約 1.9 MB、開始後約 14 秒）停住，可重現；10.5 MB 3 次中 1 次在第 63 片停住。1.7 MB 以下 Nearby 全部成功。
   - 39 MB 失敗後 15 分鐘內沒有再連線。10.5 MB 那次有再連，但 HELLO 等到逾時（見第 3 點）。
   - **2026-10-31 已修正「不再連線」**：斷線時如果對方已經被回報為看不到，`forgetConnection` 會把它刪掉，之後 Nearby 也不會再回報同一個對象。現在刪掉時會重新啟動掃描（2 秒後開始，失敗再試，最多 3 次），讓對方被重新回報，同步引擎就能重連。
   - **根本原因（10-31 實機 log 確認）**：不是升級本身失敗。升級到 Wi-Fi Direct 後資料到得很快，接收端驗章、寫入跟不上，我們自己只有 8 則的收件佇列滿了，記 `Rejected payload: Nearby receive queue full`，然後主動斷線。Wi-Fi Direct 傳輸用 TCP，讀不完時對方會自動放慢，所以沒有這個問題。
   - 實機（佇列修正之前）：Nearby 39 MB 1/1，146 秒（夜間 0/3）。中途因佇列滿斷線兩次，都由第 3 點的修正接回來，只補缺的片。
   - **2026-10-31 佇列已修正並實機驗證**：新增 `NearbyReceiveQueue`，改用位元組上限（64 MB），取代 8 則上限，超過上限才斷線。單元測試 `NearbyReceiveQueueTest` 2/2。實機：Nearby 39 MB 3/3，各約 77 秒，一次連線完成，log 沒有再出現 `queue full`；Nearby 10.5 MB 3/3，約 25 秒。
3. **失敗後的下一次連線收不到 HELLO**（`AutoPeerSyncEngine`）
   - 現象：BLE 1.7 MB 和 Nearby 10.5 MB 在 `transfer_incomplete` 之後，發送端重新連線，但每次都在 300 秒後記 `hello_timeout`，剩下的資料一直沒有補上。
   - 原因：引擎只在每次 session 開始時送 HELLO。一方先失敗、重連並送出新的 HELLO 時，另一方還在舊的交換裡等那些不會再來的片，要等到自己逾時（正式版 300 秒，量測畫面最多 900 秒）才開新 session 回覆，所以重連的一方只能等到 `hello_timeout`。
   - **2026-10-31 已修正並實機驗證**：交換進行中收到對方另一個 session id 的 HELLO，而且舊交換還在等對方的片或 `REQUESTS_DONE`，就結束舊交換（記為 `peer_restarted`），馬上開新 session 回覆。新 session 重新比對資料，已收到的片不會再要。舊交換如果已經收齊、只差自己還在送，就照常完成，不會被中斷。單元測試新增 2 個：中途斷線重連後只補缺的片，以及收齊後再收到 HELLO 不會中斷。實機：BLE 1.7 MB 2/2（夜間 0/5），Nearby 39 MB 斷線兩次後補完。
4. **Wi-Fi Direct 系統閒置關閉後不會自己恢復**（`WifiDirectTransport`）
   - 現象：10-31 11:22 量測畫面被切到背景，約 2 分鐘後 Pixel 記 `WifiP2pService: IdleShutDown`。畫面回到前景後，每次搜尋都記 `discovery step=SEARCH failed: Wi-Fi Direct action failed: 3`，該次試驗到 900 秒逾時。
   - 原因：本地服務（`addLocalService`）和搜尋請求（`addServiceRequest`）只在傳輸啟動時註冊一次；系統關閉 Wi-Fi Direct 時把它們清掉，`discoverServices` 之後一直回 `NO_SERVICE_REQUESTS`，自己也不再被對方看到，要重建傳輸才會恢復。
   - 影響：正式服務是前景服務，會不會遇到還不確定。
   - **2026-10-31 已修正並實機驗證**：搜尋失敗、原因是 `NO_SERVICE_REQUESTS` 時（`WifiDirectConnectionPolicy.mustReregister`），先清掉舊的本地服務和搜尋請求，再重新註冊，記 `service registration restored`，下一次搜尋照常進行。單元測試 `WifiDirectConnectionPolicyTest` 新增 1 個。實機（12:07–12:12）：先傳 1 次成功（8 秒）；Pixel 量測畫面切到背景 220 秒後系統記 `IdleShutDown`；畫面拉回後第一次搜尋回 3，9 毫秒內重新註冊，第二次傳輸 18 秒成功。
