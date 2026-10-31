# Nearby 收件佇列修正與鎖屏實機驗證（2026-10-31 11:02–11:49）

- 這次安裝的版本包含全部四個傳輸修正，也就是在 [傳輸修正實機驗證](summary-wifi-fix.md) 之外加上 `NearbyReceiveQueue`（收件佇列改用 64 MB 位元組上限）。條件與 [夜間桌面基準](summary.md) 相同：Pixel 8a 發送、Samsung SM-A5360 接收，桌上約 1 公尺。Pixel 仍然沒有充電，電量從 36% 用到 27%。
- 量測列的 `notes` 是 `desk-1m-nearby-queue`。先跑 Nearby 39 MB ×3、Wi-Fi Direct 39 MB ×2、Nearby 10.5 MB ×3，再補跑 Wi-Fi Direct 39 MB ×3。
- 時間都從接收端按下開始算起。

| 資料量 | 傳輸 | 成功 | 發現 p50／p95（秒） | 完成 p50／p95（秒） | 中位數速度 | 重啟 | 失敗原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 約 10.5 MB | Nearby | 3/3 | 0.4／0.5 | 25.4／26.1 | 481.6 KB/s | 0 | — |
| 全部約 39 MB | Nearby | 3/3 | 0.3／0.5 | 77.0／77.0 | 557.7 KB/s | 0 | — |
| 全部約 39 MB | Wi-Fi Direct | 4/5 | 7.8／15.9 | 106.1／126.3 | 404.3 KB/s | 0 | timeout ×1 |


- **Wi-Fi Direct 那一列的 timeout ×1 不是傳輸失敗**：第 2 次（11:22）開始時，Pixel 前景被切到 Chrome，量測畫面退到背景，約 2 分鐘後 Pixel 的 Wi-Fi Direct 被系統以閒置關閉。之後畫面拉回前景，但每次搜尋都記 `Wi-Fi Direct action failed: 3`，一直到 900 秒逾時（見下方「新發現」）。排除這一次後 Wi-Fi Direct 39 MB 是 4/4。
- 10:45 第一次開跑時兩台都在鎖屏，Pixel 螢幕熄滅進入 Doze，載入 39 MB 卡住 15 分鐘，沒有任何試驗列。之後量測腳本開跑前會先確認兩台都已解鎖。

原始資料：同資料夾的 CSV。

**對照**：

| 條件 | 夜間 | 佇列修正前（08:06–08:47） | 這次 |
| --- | --- | --- | --- |
| Nearby 39 MB | 0/3 | 1/1，146 秒，中途斷線 2 次 | **3/3，各約 77 秒，一次連線完成** |
| Nearby 10.5 MB | 2/3 | 3/3，約 28 秒 | 3/3，約 25 秒 |
| Wi-Fi Direct 39 MB | 5/5，約 78 秒 | 3/3，約 111 秒 | 4/4（排除中斷那次），91–126 秒 |

**log 看到的過程**：
- Nearby：兩台的 log 都沒有 `Nearby receive queue full`，每次試驗只有一次 session，沒有斷線、重啟或 `started a new session`。
- Wi-Fi Direct 39 MB 比夜間慢的部分在傳輸階段（第一片到最後一片）：夜間 5 次都是 64–65 秒，修正後 7 次是 67–98 秒，多數約 97 秒；發現和連線時間差不多。Samsung `dumpsys wifip2p` 的連線紀錄只保留到 07:50，夜間那幾次看不到；能看到的每一次都是 Samsung 當群組擁有者、在 5745 MHz（第 149 頻道），11:43 那次同樣條件就是 67 秒。這幾次 `WifiDirectStaleGroup` 都沒有觸發（沒有退出群組），傳輸用的 TCP 路徑也沒有改。目前沒有證據指向修正本身，比較可能是無線環境變動，但沒有確認。

**新發現：Wi-Fi Direct 系統閒置關閉後不會自己恢復**（`WifiDirectTransport`，同日已修正）
- 本地服務（`addLocalService`）和搜尋請求（`addServiceRequest`）只在傳輸啟動時註冊一次。系統的 Wi-Fi Direct 閒置關閉（`IdleShutDown`）後，這兩項被清掉，之後 `discoverServices` 一直回 `NO_SERVICE_REQUESTS`（3），自己也不再被看到，要重建傳輸才會恢復。
- 這次是量測畫面退到背景造成的。正式服務是前景服務，會不會遇到還不確定。
- 修正後重現（12:07–12:12，`notes` 為 `desk-1m-idle-recover`，1 片）：先傳 1 次成功（8.0 秒）；Pixel 量測畫面切到背景 220 秒後系統記 `IdleShutDown`；畫面拉回後第一次搜尋回 3，9 毫秒內記 `service registration restored`，第二次傳輸 18.0 秒成功。

## 鎖屏下的雙機正式測試（11:02–11:05）

兩台都鎖屏、螢幕熄滅（`mWakefulness=Dozing`）時，同時跑 `RealPeerSyncInstrumentedTest`（正式傳輸和同步引擎，第一輪互補缺片，重建傳輸後第二輪不能再有 TRANSFER）：

| 傳輸 | Pixel | Samsung | 耗時 |
| --- | --- | --- | --- |
| Nearby | 通過 | 通過 | 30 秒 |
| Wi-Fi Direct | 通過 | 通過 | 33 秒 |
| BLE | 通過 | 通過 | 30 秒 |

- Wi-Fi Direct：兩輪都由 Pixel 發邀請，帶 IPv4 設定（`provisioning mode: 0`），鎖屏的 Samsung 沒有人按也加入群組，當群組擁有者。兩台之前已經連過很多次，第一次相遇的手機會不會跳邀請框沒有驗證。
- 限制：這是測試程序裡的傳輸，不是緊急模式的前景服務；鎖屏 5／15／30／60 分鐘後再靠近的 Doze 測試仍要在現場做。
