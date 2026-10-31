# 量測腳本

用 adb 操作 debug 版的量測畫面（`MeshMeasureActivity`），跑[決賽實測計畫](../../docs/finals-field-test-plan.md)的試驗。畫面的操作、CSV 欄位和限制見[量測模式文件](../../docs/superpowers/plans/2026-10-30-measurement-mode.md)。在 Git Bash 下執行。

## 設定

`common.sh` 的預設值，可以用環境變數覆蓋：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `ADB` | 專案內 `android/build/toolchains/android-sdk/platform-tools/adb(.exe)`，找不到就用 PATH 上的 `adb` | |
| `TX` | `41051JEKB12762`（Pixel 8a） | 發送端 |
| `RX` | `R5CT8024QLR`（Samsung SM-A5360） | 接收端 |

CSV 依手機日期和型號命名，腳本自己算，不用設定。

## 腳本

| 腳本 | 用途 | 例子 |
| --- | --- | --- |
| `run-rx.sh` | 只控制接收端：發送端不接電腦（距離、隔牆），在手機上切傳輸 | `tools/measure/run-rx.sh nearby 5 dist-wall-nearby wall-5m-concrete` |
| `run-tp.sh` | 兩台都接電腦：依序載入各級距、切傳輸、跑試驗 | `PLAN=all-fast COUNT=3 tools/measure/run-tp.sh 1 tp-desk-1m-offline-usb` |
| `set-env.sh` | 設定接收端的「環境」欄（沒有 adb 參數，用畫面點選），印出設定後的值 | `tools/measure/set-env.sh 室外空曠` |

- `run-rx.sh` 的參數：傳輸（`ble`／`nearby`／`wifi_direct`）、距離、test_id、備註、次數（5）、逾時秒數（180）、間隔（Nearby 35 秒，其他 10 秒）。跑完印出每次的 `trial, success, failure_reason, attempts, t_discover_ms, elapsed_ms, received_bytes, rssi_median`。
- `run-tp.sh` 的 `PLAN=full` 跑 ONE／KB50／MB1（三種傳輸）和 MB10／ALL（Nearby、Wi-Fi Direct）；`PLAN=all-fast` 只跑 ALL。test_id 為 `tp-<距離>m-<ble|nearby|wifi>-<級距>`。
- 備註不能有空白（`am start` 會切開）。

## 注意

- **跑之前**：先用 `set-env.sh` 設環境；兩台都解鎖、量測畫面在前景；一般 App 的緊急模式關掉。
- **畫面忙碌時送指令會被拒絕，但欄位照樣被改掉**（log 記「請先停止目前的工作」）。兩支腳本送出試驗後會檢查，遇到就停下來，不會繼續等。
- **中途停止腳本**：在 Claude Code 停掉背景工作，子程序 `bash run-*.sh` 可能還活著，之後會繼續送指令。停掉後用 `ps -ef | grep run-` 找出來 `kill`，再對接收端送 `--es cmd stop`。
- 2026-10-31 實際跑的結果見 `docs/adr/evidence/2026-10-31-throughput/` 和 `2026-10-31-distance/`。
