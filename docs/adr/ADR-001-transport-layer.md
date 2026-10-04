# ADR-001：MVP 傳輸層選擇

> 2026-10-04 後續：BLE 仍為預設，新增可選 Wi-Fi Direct transport，使用 DNS-SD、P2P 介面／Network socket 綁定及現有驗證流程。使用與驗證見 [Wi-Fi Direct](../wifi-direct.md)。下方「否決」為 2026-09-05 舊實作的歷史決策；當時 TCP 逾時的根因未確認，不能據此判定 Wi-Fi Direct 必須 root。

- 狀態：**Accepted（BLE GATT），裝置相容性已轉正**，2026-09-05 實機 Spike 後定案，同日用 Sharp SH-M32 補測相容性後轉正
- 日期：2026-09-01（定案：2026-09-05）
- 範圍：階段 0 的 Peer discovery 與 chunk transfer

## 決策摘要（2026-09-05）

三個候選在同一晚的實機 Spike 中都跑過：**Nearby Connections 跟原生 Wi-Fi Direct 都在系統/平台層卡死（見下方實測記錄），只有 BLE GATT 端到端跑通**——discovery、連線、傳輸、位元組級斷點續傳全部在兩台真機上驗證成功。MVP 採用 BLE GATT 作為傳輸層，`PeerTransport` 介面維持不變（見下方 `BleGattTransport`）。

同時修正了原始 Spike 設計的一個假設：「1MB／10MB」是拿來壓力測試候選方案的數字，不是本專案實際酬載大小——`schemas/` 的 chunk 設計本來就是「固定大小或內容導向的小分片」，實際事件記錄是幾百 bytes 到幾 KB。

**2026-09-05 修正「夠用」的論證方式**：原本的推論是「單筆事件是 KB 級 → BLE 3–6 KB/s 夠用」，但這個比較單位錯了——真正決定夠不夠用的不是單筆事件多大，而是**一次 opportunistic contact（擦身、同車廂、排隊）的典型接觸窗（約 10–60 秒）內能傳完多少 bytes**。用 repo 自己的 pipeline 對 `fixtures/neihu/scale-v136.json`（500 筆事件）實測：

| 項目 | 實測 | BLE @ 4 KB/s |
| --- | --- | --- |
| 簽章後 chunk 總量 | 1.18 MB（183 片，平均 6.5 KB，最大 46.6 KB） | ≈ 289 秒（4.8 分） |
| `manifest.json` | 104 KB | ≈ 26 秒 |
| HELLO peer summary（183 條 chunk） | 36 KB | ≈ 9 秒單向 |

把 30 秒接觸窗拆開看：雙方都已有 manifest 時，HELLO 雙向 18 秒 + 剩下 12 秒約只夠傳 4% 的 chunk；**首次相遇（對方尚無 manifest）時，manifest 26 秒 + HELLO 雙向 18 秒 = 44 秒，已經超出 30 秒窗——連握手都做不完**，而首次相遇恰好是最需要成功的一次（對方什麼都沒有）。

這不代表 BLE GATT 的選擇錯誤——DTN 本來就是漸進擴散——但代表兩個接下來要做的決定：`pipeline/lib/bundle.mjs` 的 `targetSizeBytes = 4096` 應該從接觸窗口回推，而不是拍一個數字；`pipeline/lib/peer-sync.mjs` 的 `buildRequest()` 目前硬寫 `offset_bytes: 0`（v0 尚未接上跨接觸續傳），在這個吞吐量下，**跨接觸續傳**才是決定同步能不能推進的關鍵能力，見 `docs/peer-sync-v0.md`。

## 背景

ResilientGeo Mesh 需要在低頻寬或局部斷線時交換數百 KB 到數 MB 的事件分片。傳輸 API 必須可中斷續傳，也不能讓資料套用規則綁死單一 Android API。BLE 適合低功耗發現，但不應預設它能有效承擔大量 GIS payload。

## 暫定決策

先定義與平台無關的 `PeerTransport` 介面，至少包含：

```text
discover() -> PeerAdvertisement
connect(peer_id) -> Connection
send(request, offset) -> TransferStream
resume(request, offset) -> TransferStream
close(connection)
```

階段 0 同時 Spike：

1. Nearby Connections：作為較高階的 bulk-transfer 候選。
2. 原生 Wi-Fi Direct + BLE discovery：作為平台原生候選與 fallback 參考。
3. 純 BLE：只測 discovery 與小訊息，不列為 1／10 MB bulk transfer 的 MVP 候選。

在實機數據出來前，不把候選寫死成 Android App 的 domain logic。若 Nearby Connections 在指定機型／版本上通過驗收，MVP 優先採用它承載 chunk；否則採用原生 Wi-Fi Direct adapter，並保留同一個 `PeerTransport` 介面。

## Spike 必記錄數據

| 項目 | 方法 |
| --- | --- |
| 裝置相容性 | 至少兩個品牌、兩個 Android 版本，各跑 5 次 |
| Discovery latency | 從啟動掃描到雙方收到 HELLO 的 p50／p95 |
| Connection success | 20 次連線成功率，分亮屏／鎖屏情境 |
| Throughput | 1 MB、10 MB 的有效 payload bytes／秒 |
| Resume | 在 25%、50%、75% 進度人為斷線，重新連線後是否能完成 |
| Energy | 固定掃描頻率與傳輸量下的額外耗電 |
| Background behavior | 前景服務、鎖屏、切換 App 後能否完成最小同步 |

## 實測記錄（2026-09-04，BLE discovery 部分）

裝置：Pixel 7（`2A221FDH2004RL`，API 37）與 Pixel 8a（`41051JEKB12762`，API 37），同房間近距離，皆透過 USB 接同一台電腦以 `adb` 驅動（非手動操作 UI）；螢幕亮起情境跑 5 次，另跑 1 次鎖屏情境。

**重要發現並已修正的 bug**：`BleDiscovery.startScanning()` 原本以 `scanner.startScan(null, ...)` 掃描，未過濾 `SERVICE_UUID`，導致第一輪測試量到的是環境中任意 BLE 裝置（耳機、手錶等），不是彼此的廣播——Pixel 7 那輪甚至換了兩個不同 MAC，latency 高達 85–133 秒，明顯是雜訊。已加上 `ScanFilter.setServiceUuid(SERVICE_UUID)`（`transport/BleDiscovery.kt`）修正後重測，兩台裝置各自穩定只看到對方那一個 MAC。

- **Discovery latency（亮屏，5 次，ms）**
  - Pixel 7：246, 419, 531, 536, 540 → p50 = 531ms，p95 ≈ 540ms
  - Pixel 8a：99, 104, 114, 142, 283 → p50 = 114ms，p95 ≈ 283ms
- **裝置相容性**：目前只有兩台裝置，皆為 Pixel 品牌、同一 API 37 — 尚未滿足「至少兩個品牌、兩個 Android 版本」，這點還沒過關，需要再借一支非 Pixel 或不同 API 版本的機器。
- **Background / 鎖屏行為（初步）**：Pixel 7 於掃描中以電源鍵鎖屏（確認 `dumpsys power` 顯示 `mWakefulness=Dozing`），鎖屏後 15 秒內兩台裝置仍持續收到彼此的 BLE 廣播（logcat 持續有 `saw device` 紀錄），沒有立即被系統殺掉。**只驗證了 15 秒內**，尚未驗證數分鐘後進入 Doze 模式或背景多久之後是否會被系統掛起。
- **尚未測試**：Connection success rate（尚無 `connect()` 實作）、Throughput（1MB/10MB，需要 `NearbyConnectionsTransport`）、Resume（斷線續傳）、Energy（耗電）。

結論：BLE discovery 本身在受控環境下運作正常且延遲低（多在 1 秒內）。這部分數據後來也直接支撐了下方 BLE GATT 方案的採用。

## 實測記錄（2026-09-05，Nearby Connections — 已否決）

裝置同上（Pixel 7 + Pixel 8a）。`NearbyConnectionsTransport.kt` 實作完成、可編譯，接上 `com.google.android.gms:play-services-nearby`（先後試過 19.0.0、19.3.0，都能編譯）。**執行期兩台裝置的 `startAdvertising()`／`startDiscovery()` 都立即（約 60ms 內）回傳 `ApiException: 8: INTERNAL_ERROR`**，權限（`BLUETOOTH_SCAN/ADVERTISE/CONNECT`、`NEARBY_WIFI_DEVICES`、`ACCESS_FINE_LOCATION`）、藍牙、Wi-Fi 狀態都已確認正常。

關鍵排查發現：不管我們宣告哪個 client library 版本，實際執行的是 GMS 內部動態載入的模組（stack trace 顯示 `play-services-nearby@@19.2.0`，跟我們指定的版本不同）——代表這個錯誤完全發生在 Google 自己的 on-device 模組內，client 版本選擇改變不了執行期行為。這個錯誤模式跟 2023 年一次已知的 Google 側 regression（[google/nearby#2124](https://github.com/google/nearby/issues/2124)、[android/connectivity-samples#296](https://github.com/android/connectivity-samples/issues/296)）症狀完全一致，當時的解法是 Google 端手動 allowlist 個別 App 或等官方修復——不是我們能在 App 端修的問題。

**結論：否決。** 非我們程式碼可控的外部相依性失敗，且無法在 hackathon 時間內排查 Google 端狀態。

## 實測記錄（2026-09-05，原生 Wi-Fi Direct — 已否決）

裝置同上。`WifiDirectTransport.kt` 用平台原生 `WifiP2pManager`（無 Play Services 相依）。過程中修正了兩個真的邏輯 bug：

1. Group Owner 端不會透過自己的 `discoverPeers()`／`requestPeers()` 看到已連線的 Client（Wi-Fi Direct 固有行為，不是 bug）——改成 GO 端直接用已知連線角色開始監聽，不等自己的 discovery。
2. `ServerSocket(PORT)` 預設走 IPv6 wildcard bind，改成明確綁定到 `WifiP2pInfo.groupOwnerAddress` 取得的實際 IPv4 位址。

修正後仍卡住：**兩台裝置手動用系統原生 Wi-Fi Direct 設定連線成功**（`groupFormed=true`，GO IP `192.168.49.1`），ping 該 IP 成功（128–217ms、0% 封包遺失），`netstat` 確認 socket 正確綁定監聽中（`::ffff:192.168.49.1:8988 LISTEN`），**但 Client 端對這個 socket 的 TCP 連線持續 timeout**（不是立即拒絕）。ICMP 通、socket 確認在監聽、TCP handshake 就是進不去——這個組合不像應用層可修的問題，較可能是 Android 對 App 的 Socket／ServerSocket 在有多個網路（P2P + 行動網路皆存在）時，不會自動綁定到 P2P 介面路由（需要透過 `ConnectivityManager` 明確綁定到該 P2P 的 `Network` 物件），但在 hackathon 時間壓力下沒有進一步排查空間。

**結論：否決。** 需要 root 權限才能確認 iptables/netd 規則，且即使排查出根因，`ConnectivityManager` Network 綁定的額外實作複雜度在剩餘時間內風險過高。

## 實測記錄（2026-09-05，BLE GATT — 採用）

`BleGattTransport.kt` 重用已驗證穩定的 `BleDiscovery` advertise/scan 邏輯，加上一組自訂 GATT service（WRITE characteristic 供資料分片、NOTIFY characteristic 供 ACK）。雙方裝置同時扮演 Peripheral（GATT server，接收）與 Central（GATT client，發送）兩個角色。

實測結果（兩台裝置互相對傳，自動化跑完整序列：10KB → 100KB → 中斷於 ~1020 bytes → 續傳）：

| 測試 | Pixel 7 | Pixel 8a |
| --- | --- | --- |
| 10KB | 成功，3181ms（3.2 KB/s） | 成功，2130ms（4.8 KB/s） |
| 100KB | 成功，25331ms（4.0 KB/s） | 成功，17422ms（5.9 KB/s） |
| 100KB + 中斷續傳 | 中斷於 1020 bytes，續傳成功 24859ms（4.1 KB/s） | 中斷於 1020 bytes，續傳成功 16979ms（6.0 KB/s） |

續傳是真的位元組級續傳（不是重傳整包）：中斷點回報的 `bytesTransferred` 直接作為下一次 `resume()` 的 offset，接收端收到的資料長度跟預期完全吻合。

過程中修正一個真的協定層 bug：`ServerSocket`/GATT 的 ATT_MTU 協商到 517 後，算出的 payload room 是 514 bytes，但 BLE 規格對單一 attribute value 有獨立於 MTU 之外的 512 bytes 硬上限，導致 `writeCharacteristic()` 丟出 `IllegalArgumentException`；修正為 `(negotiatedMtu - 3).coerceIn(20, 512)`。

**結論：採用。** Discovery、連線、傳輸、斷點續傳全部驗證通過；不依賴 Wi-Fi、不依賴 Google Play Services，只需要藍牙——也最貼近「災難情境下不需要任何網路基礎設施」的產品定位。吞吐量（3–6 KB/s）遠低於 Wi-Fi 類方案，但符合本專案實際酬載（KB 級事件記錄）的需求。

## 未選方案與原因

- **Nearby Connections**：實機測試回傳 Google 側 `INTERNAL_ERROR`，非 App 端可控（見上方實測記錄）。
- **原生 Wi-Fi Direct**：discovery／連線可行，但 TCP 傳輸卡在疑似 Android per-app 網路路由限制，排查需要 root 權限與更多時間（見上方實測記錄）。
- **純 BLE advertise/scan（不含 GATT 傳輸）**：原始決策只把 BLE 列為 discovery 候選，理由是「吞吐量與 MTU／背景限制不適合大量 chunk 傳輸」——這個假設在加上 GATT 傳輸層並重新檢視實際酬載大小（KB 級，非 MB 級）後不再成立，已改為採用。

## 回填：接觸窗、連線成功率與耗電量測（2026-09-05）

上方「尚未涵蓋」列出的四項裡，三項已經有真機數據，寫在這裡而不是散在 `team-assignments.md` 各處，方便之後引用。

**接觸窗吞吐量**（`transport/BleGattMeasurementActivity.kt`，Pixel 7 + Pixel 8a，多輪）：

| 接觸窗長度 | 傳輸量 | 吞吐量 |
| --- | --- | --- |
| 10s | 36,864 B | 3,819 B/s |
| 30s（第一輪） | 122,880 B | 4,105 B/s |
| 30s（第二輪） | 126,976 B | 4,281 B/s |
| 60s | 262,144 B | 4,419 B/s |
| 60s（另一輪） | 傳輸中途 GATT write 逾時失敗 | — |

量級穩定在 **3.8–4.4 KB/s**，跟本 ADR 前面「3–6 KB/s」的估計吻合；60 秒那輪的失敗案例也如實記錄——長接觸窗不代表穩定，中途逾時是真實存在的現象，不是只在短窗才會發生。**這組數字就是 `targetSizeBytes` 回填的依據**（見 `pipeline/lib/bundle.mjs` 同段落的程式碼註解）：4096 bytes 在 3.8–4.4 KB/s 下約 1–1.5 秒傳完，遠低於 `WRITE_TIMEOUT_MS`（10s）／`ACK_TIMEOUT_MS`（30s），即使是最短的 10 秒接觸窗也能穩定送出好幾個 chunk 並留有中斷重試的餘裕——維持 4096 不變，因為它剛好也貼近內湖 scale 資料集的實際平均 chunk 大小（183 片平均 6.5 KB）。

**Connection success rate**（Pixel 7 → Pixel 8a，20 次一組）：

- **亮屏**：17/20 成功（85%），成功案例 latency p50=289ms／p95=566ms；最後 3 次連續失敗（`service discovery failed`，各逾時 10 秒）——懷疑連續高頻重連後 BLE stack／對端 GATT server 需要更長恢復時間。
- **鎖屏**：20 次裡扣掉按下按鈕當下仍亮屏的第 1 次，剩下 19/19 全部失敗，**0% 成功率**——沒有 foreground service 保護的一般 App，鎖屏後幾乎無法完成 BLE 連線，這正是 Emergency Mode 需要 foreground service 的直接證據。（跨機型重跑、換乙的正式 `EmergencyModeService` 骨架重跑鎖屏情境，仍是待辦，見 `docs/mvp-remaining-tasks.md`。）

**Energy Cost**（2026-09-05 重測，取代同日稍早已作廢的量測）：

| 條件 | 各輪中位數（6 輪） | 主要估計值 |
| --- | --- | ---: |
| baseline（App 已 force-stop，螢幕關閉） | 363, 367, 375, 395, 398, 748 | **385 mW** |
| Emergency Mode（BLE 廣播＋掃描前景服務） | 426, 433, 438, 440, 447, 474 | **439 mW** |

Emergency Mode 的邊際成本約 **+54 mW（+14%）**，以 Pixel 7 的 16.8 Wh 電池換算，持續開啟一小時約多耗 **0.3% 電量**。這是「待命中持續發現鄰居」的成本，**不含** GATT 連線與分片傳輸——目前的服務不會自行傳輸。

**同日稍早的 22.35 → 26.78 mW（「+4.4 mW、20%」、「1810 mW 連線尖峰」）已作廢，不應再引用。** 那次是在插著 USB、電量全滿的手機上取樣，電池電流在零附近震盪，記錄到的是計量器雜訊：兩個「不同條件」的 min／p25／median 完全相同（1.35／10.83／20.31），而且 22 mW 對整支手機物理上不可能（本次量到螢幕關閉的閒置就是約 385 mW）。詳見 `experiments/results/energy-raw/README.md`。

原始 CSV 在 `experiments/results/energy-raw/`；已整理進 `experiments/results/report.md` 第 5 節（透過 `simulator/lib/report.mjs` 生成，非手改該檔案——`matrix --check` 會位元比對，手改會被下次重跑蓋掉）。

**裝置相容性與三機 SCF——2026-09-05 已用 Sharp SH-M32 補齊**，見下方「通過與停止條件」。

## 通過與停止條件

**已達成（BLE GATT）**：兩台測試機重複完成 discovery、連線、KB 級傳輸與位元組級斷點續傳。

**裝置相容性——已轉正（2026-09-05）**：`system.md` §8 的停止條件「傳輸層只能在單一機型運作」已排除。原計畫用 Samsung SM-S731B 補測，實際依裝置持有狀況改用 **Sharp SH-M32（Android 15, API 35）**——品牌（SHARP vs Google）與 API 版本（35 vs 兩台 Pixel 的 37）都不同，滿足「至少兩個品牌、兩個 Android 版本」的排除標準。discovery/connect/transfer 與完整 HELLO→DIFF→REQUEST→TRANSFER→VERIFY/APPLY 序列（含中斷續傳）在 Sharp 上一次到位，細節見 `team-assignments.md`（已移除，最後版本 `git show b9bd906:team-assignments.md`）。

**三機 Store-Carry-Forward——已達成（2026-09-05）**：Pixel 8a（A/Origin）→ Pixel 7（B/Relay）→ Sharp SH-M32（C/Far），A 完全 force-stop（`pidof` 確認程序不在跑）情況下，C 仍透過 B 完整收到並驗證全部 4 個簽章事件（含一個中斷又續傳的 chunk），兩段都直接讀 Room `.db-wal` 確認而非只信 log。細節與已知簡化（B 對 C 廣播的摘要是寫死的 fixture，非動態讀自己的 Room）見 `team-assignments.md`（已移除，最後版本 `git show b9bd906:team-assignments.md`）。

**已補齊（見上方「回填」段落，2026-09-05）**：
- Connection success rate：亮屏 20 次（17/20，85%）與鎖屏 20 次（0%）皆已跑完（僅兩台 Pixel 之間；Sharp 沒有另外跑滿 20 次的正式統計，只有本次三機 SCF 過程中的 ad-hoc 連線數據）
- Energy：已重測（baseline 385 mW → Emergency Mode 439 mW，+54 mW／+14%，6 輪交錯）；同日稍早那組 22.35 → 26.78 mW 因插電滿電量到雜訊而作廢，見上方
- Background behavior：鎖屏 0% 連線成功率本身就是「一般 App 在背景/鎖屏下無法完成 GATT 連線」的直接證據，印證了 Emergency Mode foreground service 的必要性

**仍未涵蓋、需要後續驗證**：
- 換乙的正式 `EmergencyModeService` 骨架重跑鎖屏 connection rate 與背景存活——2026-09-05 曾嘗試但螢幕中途被喚醒，測到的是「螢幕亮著」而非「鎖屏」的存活結果，無效，需要重來
- Sharp SH-M32 上的正式 20 次 connection success rate 統計（目前只有 SCF 過程中的少量 ad-hoc 數據，不是系統性測試）

以上見 `docs/mvp-remaining-tasks.md` A 段。

## 後續

`BleGattTransport` 已可作為 `EventIngestor`／Peer Sync 的實際 transport 實作接入（`EventStore` 介面邊界已留好）。下一步是把 HELLO/DIFF/REQUEST 協定接到這個 transport 上，而不是繼續停留在 Stage 0 spike 階段。
