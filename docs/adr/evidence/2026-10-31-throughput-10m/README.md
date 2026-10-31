# 資料量與速度實測：10 公尺、室外、離開 Wi-Fi（決賽計畫第 2 項）

- 1 公尺的結果見 [`../2026-10-31-throughput/`](../2026-10-31-throughput/README.md)，桌面基準見 [`../2026-10-31-desk-baseline/`](../2026-10-31-desk-baseline/summary.md)。
- **這次發送端和接收端對調**：Samsung 發送、Pixel 接收（1 公尺那組是 Pixel 發送、Samsung 接收）。原因見下方〈條件〉。

## 條件

| 欄位 | 內容 |
| --- | --- |
| 日期時間 | 2026-10-31 22:49–23:22 |
| 發送端 | Samsung SM-A5360，人拿著，約 1 公尺高，不插 USB |
| 接收端 | Pixel 8a（Android 17），約 1 公尺高，螢幕朝上，插筆電 USB |
| 環境 | 室外空曠，兩台之間沒有遮擋，測試期間沒有人經過 |
| 距離 | 10 公尺，用捲尺量 |
| 電量 | Pixel 85% → 75%（插 USB 但沒在充電）；Samsung 開始時 100% |
| Wi-Fi | 兩台都沒連 Wi-Fi（Wi-Fi 開關開著，給 Wi-Fi Direct 用） |
| 行動數據 | **Pixel 開著**，用「USB 網路共用」讓筆電上網；Samsung 沒有 SIM |
| 螢幕 | 兩台都亮著，量測畫面在前景 |
| `notes` | `SamsungTX-PixelRX-USBtether` |

- **為什麼對調**：室外沒有網路，筆電要靠 Pixel 上網，Claude Code 才能下指令。Wi-Fi 熱點會佔用 Pixel 的 Wi-Fi 晶片，可能影響 Wi-Fi Direct 和 Nearby，所以改用 USB 網路共用。Pixel 因此必須插著筆電，腳本又只能控制插線的那台，所以 Pixel 當接收端，Samsung 當發送端、由人手動切換。
- **跟 1 公尺那組不能直接比**：方向相反，而且 Pixel 開著行動數據。Nearby 和 Wi-Fi Direct 傳資料時都不走行動網路。
- 「環境」欄以接收端 Pixel 為準（室外空曠）。Samsung 的環境欄這次沒改，它的 CSV 不採用這個欄位。

## 結果

速度 = `received_bytes` ÷「REQUEST 到最後一片」，KB = 1024 bytes。時間從接收端按下開始算。每組 3 次，**15 次全部成功**。

| 傳輸 | 資料量 | 成功 | 發現（秒） | 連上（秒） | 完成（秒） | 中位數 | 速度中位數 | 連線次數 | test_id |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BLE | 約 50 KB（20 片） | 3/3 | 0.2／0.4／3.4 | 0.6／0.8／12.1 | 23.5／28.4／34.8 | 28.4 秒 | 2.9 KB/s | 各 1 次 | `tp-10m-ble-kb50` |
| Nearby | 約 1.7 MB（157 片） | 3/3 | 1.4／1.1／1.8 | 3.0／3.7／4.4 | 11.8／11.4／13.4 | 11.8 秒 | 224 KB/s | 各 1 次 | `tp-10m-nearby-mb1` |
| Wi-Fi Direct | 約 1.7 MB（157 片） | 3/3 | 5.3／12.1／11.5 | 187.4／15.0／48.2 | 190.9／18.1／51.3 | 51.3 秒 | 613 KB/s | 2／1／1 | `tp-10m-wifi-mb1` |
| Wi-Fi Direct | 全部（203 片，約 39 MB） | 3/3 | 5.4／7.9／11.6 | 7.2／23.4／12.3 | 67.1／88.1／77.4 | 77.4 秒 | 695 KB/s | 各 1 次 | `tp-10m-wifi-all` |
| Nearby | 全部（203 片，約 39 MB） | 3/3 | 1.7／1.7／0.9 | 2.7／4.0／2.9 | 72.4／74.3／74.9 | 74.3 秒 | 632 KB/s | 各 1 次 | `tp-10m-nearby-all` |

- BLE 的 RSSI 中位數 −90／−90／−86（背包 5 公尺約 −80，桌面約 −38）。
- 每次都收齊所有片：50 KB 為 65,271 bytes，1.7 MB 為 1,752,787／1,752,473 bytes，39 MB 為 38,837,960／38,837,554 bytes（Nearby／Wi-Fi Direct 重簽結果略有不同）。

**對照 1 公尺、離開 Wi-Fi**（方向相反，見上方）：

| 傳輸 | 1 公尺（Pixel → Samsung） | 10 公尺（Samsung → Pixel） |
| --- | --- | --- |
| Nearby 39 MB | 3/3，中位數 78 秒，548 KB/s | 3/3，中位數 74 秒，632 KB/s |
| Wi-Fi Direct 39 MB | 3/3，中位數 115 秒，383 KB/s | 3/3，中位數 77 秒，695 KB/s |

結論：10 公尺室外空曠沒有讓任何傳輸變差。Wi-Fi Direct 10 公尺反而比較快，但方向和設備角色不同，不能歸因到距離。

**個別說明**：

- **Wi-Fi Direct 1.7 MB 第 1 次 191 秒**：真正傳資料只花 3 秒，時間都卡在連線。Pixel 的系統 log 在 23:00:49–23:01:14 記了 12 次 `WifiP2pService: Dropping connect request`（`authorizeConnectionFromPeerEnabled: false`），也就是擋掉 Samsung 送來的連線請求。23:01:14 Pixel 記 `Wi-Fi Direct connection timed out`（開始後約 90 秒），第 2 次連線在 187 秒接上，3 秒傳完。Samsung 沒有跳邀請框。原因未查，沒有改程式。
- **Wi-Fi Direct 1.7 MB 第 3 次 51 秒**：發現 11.5 秒，連上 48 秒，也是慢在連線。跟之前「每 5 次約 1 次特別慢」是同一類現象，這次 6 次 Wi-Fi Direct 裡有 2 次。
- 39 MB 的「連上」到 REQUEST 約 10 秒，是交換 203 片的摘要；1.7 MB 約 1 秒。
- Nearby 這 6 次沒有 `[radio-restarts]`，也都沒有斷線重連。

## 排除的列

無。Pixel CSV 裡其他 278 列是今天稍早 Pixel 當發送端時寫的（`trial` 為 0、`test_id` 空白），不屬於這次試驗。

## 原始資料

- `raw/measure-2026-10-31-Pixel_8a.csv`：接收端，23:23 拉回，md5 `28f26bb053b1de644dc8e4bf9b7464a6`。用 `test_id` 開頭為 `tp-10m-` 的 15 列。
- 發送端 Samsung 的 CSV 還沒拉，下次 Samsung 接電腦時補到 `raw/`。

## 怎麼跑的

Pixel 接收端插筆電，由 `tools/measure/run-rx.sh` 送 `cmd trials`（用環境變數 `RX=41051JEKB12762 TX=R5CT8024QLR` 把接收端改成 Pixel）；環境欄用 `tools/measure/set-env.sh 室外空曠 41051JEKB12762` 設定。Samsung 先插筆電用 adb 開量測畫面、載入 50 KB、開始提供 BLE，之後拔線，換傳輸和資料量都在 Samsung 上手動按。順序是 BLE 50 KB → Nearby 1.7 MB → Wi-Fi Direct 1.7 MB → Wi-Fi Direct 39 MB → Nearby 39 MB。逾時：50 KB 180 秒、1.7 MB 300 秒、39 MB 900 秒；間隔 Nearby 35 秒、其他 10 秒。
