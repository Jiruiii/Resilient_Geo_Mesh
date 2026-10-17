# 委員建議：兩機可執行的第一版

2026-10-06。這份文件描述新增功能、操作方式與驗證邊界。一般 App 資料庫、正式信任金鑰及演練資料互相隔離。

## 已實作

| 建議 | 功能 | 目前限制 |
| --- | --- | --- |
| 定義資訊來源與孤島傳播情境 | 本機演練工作台簽署避難所、道路與物資事件；A 載入，B 用 Wi-Fi Direct 接收 | Debug 專用入口，需事先安裝 App、權限與演練公鑰；非政府發布系統 |
| 著重避難路線 | 接收事件後沿用正式離線路線重算流程；演練 A／B 避難所與固定起點；記錄連線、分片及重算時間 | 2026-10-16 已通過一次兩機離線驗收（見下方）；不代表完整救援導航 |
| 增加物資資訊 | 獨立物資圖層、名稱、種類、數量、發放狀態、時間、來源；未知與過期數量不顯示為零 | 尚未接上真實政府物資資料來源；演練站點不能用於真實避難 |
| 耗電與長時間背景運作 | 可選自適應搜尋、立即搜尋、唯讀電池採樣工具 | 節電幅度及 Doze 成功率未驗收，預設仍為持續搜尋 |
| 模擬校準 | Wi-Fi Direct 建連等待時間 profile；扣除 setup 後計算雙向共用傳輸預算 | 只有兩次配對相遇的四個裝置觀測；吞吐量、社交接觸與失敗率是明示假設 |

## 本機演練工作台

在 repo 根目錄執行：

```powershell
npm run drill:serve
```

瀏覽器開啟 `http://127.0.0.1:8788/`。工作台只綁定本機，支援發布、更新、區域篩選、版本及到期狀態。每次發布都要由手機 A 重新載入；工作台上的成功訊息不是手機收件證明。

發布固定示範情境的捷徑：

```powershell
node tools/validation/seed_drill.mjs OPEN
# 之後把同一避難所改成額滿：
node tools/validation/seed_drill.mjs FULL
```

這會更新演練避難所 B（121.592, 25.060）及物資站，演練位置是內湖固定座標，不是手機 GPS。手動發布時沿用識別碼才是版本更新。道路事件必須使用 `road:w<OSM way ID>`，且該 way 要存在於離線路網；單純把一個點標成封路不會讓任意附近道路封閉。無法對應時路線會顯示警告。

`.drill-state/` 保存本機私鑰與發布帳本，已排除版本控制。私鑰不進手機，也不經 API 提供。手機僅在明確按下準備按鈕時，透過固定本機入口接收演練公鑰；公鑰更換須重設演練。不應將這個 debug 信任初始化流程當成正式政府金鑰配發機制。

## 雙機演練操作

先安裝相同 debug APK。Samsung 可用 USB；Pixel 的無線偵錯須在兩台離開路由器前完成準備。以下 `<序號>` 換成 `adb devices -l` 顯示的實際裝置：

```powershell
adb -s <序號> reverse tcp:8788 tcp:8788
adb -s <序號> shell am start -n com.resilientgeo.mesh/.debug.MeshDrillActivity
```

1. 解鎖兩台。一般 App 先授予 Wi-Fi Direct 所需權限，再關閉一般緊急模式。演練與一般同步不可同時運作。
2. 工作台先發布 `OPEN`。兩台進入演練畫面並「重設演練」。A 按「A：載入發布資料」，B 按「B：只準備接收」。B 的本機事件應為 0；它只載入公鑰。
3. B 按「推薦最近避難所」，基準應指向演練避難所 B。工作台再發布 `FULL`，A 再次載入新版。
4. 兩台手動離開原路由器、關閉行動數據，但保留 Wi-Fi 及定位服務；不要關閉 App。此時 Pixel 無線偵錯離線是預期行為。`adb reverse` 只用於準備，不負責兩機傳輸。
5. 兩台按「開始演練同步」，若 Android 出現邀請需接受。觀察 B 的事件／分片數增加、物資站出現、原路線重新計算並改推薦 A。A 本輪接收 0 片、B 收到多片是正常的一向發布情境；不要把兩側接收片數不同當作失敗。
6. 開啟「查看時間紀錄」或保存截圖。計時相對各自手機本輪同步啟動，不能把兩台的數字直接相減當端到端延遲；以 B 的 connected、applied TRANSFER、路線重算紀錄比較同機階段。
7. 停止後重啟同步，若沒有更新應顯示 already in sync，新增分片為 0。再次發布 `OPEN`、A 載入後同步，可驗證 B 恢復原推薦；也可用 1 分鐘 TTL 檢查到期重算。
8. 結束按停止、離開演練。Activity 銷毀時清除專用記憶體資料庫及暫存；切到背景不等於離開，仍應按停止。重設演練只清演練資料。連回 Wi-Fi 後可取回 Pixel 紀錄，無線偵錯可能需重新開啟。

```powershell
adb -s <序號> logcat -d -s MeshDrill ResilientGeoWifi
adb -s <序號> reverse --remove tcp:8788
```

目前是兩節點接力驗證，不是多人同群組或任意多跳網路。Wi-Fi Direct 的 PBC 邀請、低電量與鎖定畫面可能阻擋無人操作驗收。

## 搜尋與電量對照

一般 App → 同步狀態 → Wi-Fi Direct，關閉緊急模式後才可改搜尋模式。

- 持續搜尋：維持原有隨機重試排程；3 秒是連線失敗冷卻，不是固定每 3 秒掃描。
- 自適應：60 秒沒有看到對方後，搜尋約 12 秒、休息約 30～45 秒；持續無對方超過 180 秒後，休息約 60～90 秒。剛看見節點會恢復活躍判斷。
- 立即搜尋：要求排程恢復搜尋；既有建群／連線協商仍優先，不會為重掃拆掉正在建立的連線。

間歇搜尋可能錯過短暫擦身而過的對方，不能保證較快或一定省電。建議同一台裝置、同樣亮度／螢幕狀態／電量區間，分別測 baseline、balanced、adaptive 至少 30 分鐘，多輪交換順序。另做鎖屏 15／30／60 分鐘後的重新相遇；亮屏成果不能代表 Doze 成果。

```powershell
python tools/validation/sample_battery.py --serial <序號> --mode adaptive --seconds 1800 --interval 30 --output android/build/battery-adaptive.csv
```

`--mode` 是記錄標籤，不會替你切換 App 模式。工具唯讀、輸出 CSV 與 JSON、拒絕覆寫既有檔案。ADB 取樣本身影響休眠；USB 充電、電量計未知或倒增時不會給出放電消耗。不得用 `dumpsys battery unplug` 的模擬狀態假裝實際拔線。本次 Samsung USB 20 秒煙霧測試只驗證了採樣器正確辨識充電，沒有節電結論。

## 模擬器使用及解讀

```powershell
node simulator/cli.mjs run --nodes 50 --strategy rarest-first --seed 20261006 --transport-profile simulator/fixtures/wifi-direct-profile.json --out android/build/committee-sim
```

沒有傳入 profile 時保持既有 BLE 基準及已提交矩陣結果。Wi-Fi profile 將每台每輪最多一個對方、整對手機共用資料預算，且接觸時間小於建立連線時間時傳輸量為零。延遲統計仍是回合解析度，不是毫秒精度的封包模擬。

四個 setup 觀測值（毫秒）：14345、9637、12927、13034。來源是 2026-10-04/05 的兩次配對交換：transport 建立至 socket ready，包含服務搜尋與建群；並不是四次獨立樣本。原始檔位於本機 `android/build/wifi-{pixel,samsung}-offline-final-logcat.log`，公開背景見 [Wi-Fi Direct 實測說明](wifi-direct.md)。

32000 B/s 明確是情境假設，沒有把兩個小分片交換外推為純 Wi-Fi 吞吐量。可複製 profile 改為不同速率做敏感度比較；另以 `--config` 指定一份情境設定檔，更改接觸機率、gateway 比例或區域密度。保留各參數來源。大規模輸出代表模型假設下的推演，不是 50／100 台實機驗證或災區保證覆蓋率。

## 驗證紀錄與尚待項目

本輪 Node pipeline／simulator 198 項、Android JVM 176 項、Flutter 264 項及 Python 採樣解析 2 項測試通過，Flutter 分析無問題，APK 建置成功。結果記錄於 `android/build/committee-*.log`。新增 Node→Android 合約測試已在 Samsung USB 與 Pixel 無線各通過一次：公鑰隔離、簽章有效、竄改拒絕、重複匯入穩定、分片可再次提供。

最終 debug APK SHA-256：`de9f9a6e286948d7f666c640d8de87c097a42ef85a415a1536953976d8d54bf6`。

重跑合約測試：啟動工作台、執行 seed 腳本、安裝 app 及 androidTest APK、設定 `adb reverse`，然後：

```powershell
adb -s <序號> shell am instrument -w -e class com.resilientgeo.mesh.data.DrillBundleInstrumentedTest -e drill_contract true com.resilientgeo.mesh.test/androidx.test.runner.AndroidJUnitRunner
```

工作台瀏覽器實測已驗證更新、版本增加、區域篩選，並檢視桌面及手機寬度截圖。

### 2026-10-16 重新驗證（Windows 11，提交拆分前後內容相同）

| 項目 | 結果 |
| --- | --- |
| Flutter `analyze` | 無問題 |
| Flutter `test` | 320 項通過 |
| Flutter Web `build web --release` | 成功（Web 端只做建置與 widget 測試，沒有瀏覽器實測） |
| Android `:app:testDebugUnitTest` | 226 項，0 失敗 |
| `npm test`（pipeline＋simulator） | 322 項，321 通過；失敗 1 項：`medical-unresolved-audit` 的 CLI 退出碼預期 2、實際 1 |
| `npm run test:server` | 121 項，103 通過；失敗 18 項，訊息為 Windows 路徑分隔符、`E:E:OSS...` 路徑與 symlink，集中在 config／deployment／release-store／release-cleanup。未改動 server 目錄，也未在乾淨 main 上比對，暫列為既有 Windows 環境問題，尚待在 Linux 或 CI 重跑確認 |
| `npm run sim:check` | 通過 |

這輪不含 instrumented 測試（除下方實機流程），也沒重跑 Python 測試。

### 雙機離線驗收（2026-10-16）

Samsung SM-A536（Android 16）為 A，Pixel 8a（Android 17）為 B；兩台以 USB 供 adb 控制，Wi-Fi 未連任何路由器、行動數據關閉，兩台對外網路均不可達。debug APK 為 `com.resilientgeo.mesh`，SHA-256 `0967ecad523c697e0fe652c3cde22344663047875f9791097bf96d35a6d565f4`。

| 階段 | B 的結果 |
| --- | --- |
| 基準線（避難所 B：OPEN） | 推薦演練避難所 B，218 公尺 |
| FULL（A 載入第 7 版）→ 離線同步 | 約 36.5 秒建連；收 2 片並套用；B 的路線 `NO_ROUTE`，改推薦演練避難所 A，950 公尺，顯示「避難所狀態更新，已自動重新規劃」 |
| 同版再次相遇 | `already in sync`，不重傳 |
| OPEN（A 載入第 11 版）→ 同步 | 建連後約 0.5 秒收 2 片；推薦恢復演練避難所 B，218 公尺，「無官方開設狀態」警示消失 |

物資站事件隨同一次同步抵達 B。上表時間為各自手機計時，不可跨機相減。這是單次執行、兩節點接力，不是統計樣本。

操作注意：

- 同步進行中，「A：載入發布資料」與「B：只準備接收」為停用狀態。重新發布後，A 須先「停止演練同步」，再載入新版，最後重新開始同步；同步中點載入不會有任何作用，B 會一直回報 `already in sync`。畫面現在會在同步中顯示這個提示（單元測試通過，尚未重新在手機上確認）。
- Android 17（API 37）需額外授予 `ACCESS_LOCAL_NETWORK`（詳見 `wifi-direct.md`）。舊版此時只顯示籠統的「請授予 Wi-Fi 權限」；現在會逐項指出缺少哪一項，例如「無法開始：缺少權限：區域網路（Android 17）」（單元測試通過，尚未重新在手機上確認）。權限可用 `adb shell pm grant com.resilientgeo.mesh android.permission.ACCESS_LOCAL_NETWORK`。
- 已簽章的 debug APK 與裝置上既有安裝簽章不同時（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）須先解除安裝，會清除該機 App 本機資料。
- 本次未驗收：1 分鐘 TTL 到期重算、鎖屏與 Doze、實際放電對照、距離與牆面、三節點以上。先前版本的離線 Wi-Fi Direct 證據仍保留於 `wifi-direct.md`。

後續優先順序：鎖屏與實際放電對照、TTL 到期重算、不同距離／牆面實測、更多機型及節點。正式政府合作、授權發布、真實避難所負載及物資資料來源仍需外部單位確認。
