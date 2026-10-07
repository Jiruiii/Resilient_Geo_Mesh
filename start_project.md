# 本機啟動 ResilientGeo（Mac + Android 模擬器）

以下命令除特別說明外，均在專案根目錄執行。請先啟動 Docker Desktop，確認已安裝 Android SDK、模擬器與 Flutter。`.env` 和簽章金鑰留在本機，不要貼到終端輸出或提交到 Git。

## 1. 啟動本機 API

在第一個終端機執行：

```bash
docker info >/dev/null
docker compose --env-file .env -f deploy/docker-compose.yml config --quiet
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --no-deps api
docker compose --env-file .env -f deploy/docker-compose.yml ps api
curl -fsS http://127.0.0.1:8787/readyz
```

這是**已有發布資料**時最快的 Demo 啟動方式：只重建 API，沿用 Docker volumes 裡已簽章的告警與靜態圖層，不重新抓政府上游資料。`/readyz` 回傳 `"status":"ready"` 才表示目前 feed 可用；也可查三種資料路徑：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/feed.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/v1/layers/taiwan-medical/manifest.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/address-packs/catalog.json
```

三行都應是 `200`。第一次在**空的 Docker volumes** 啟動，才需要同時跑 collector：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build collector api
docker compose --env-file .env -f deploy/docker-compose.yml logs -f --tail=100 collector
```

Collector 啟動後會做首次收集與發布，可能花較久；`logs -f` 只是在追蹤日誌，按 `Ctrl+C` 不會停止容器。來源顯示 `partial` 代表部分資料可發布，例如尚未定位的院所不會上地圖；應以 `/readyz` 與圖層 manifest 是否可取得確認發布結果。API request 本身不會重新呼叫政府上游。查看容器狀態及最近日誌：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml ps
docker compose --env-file .env -f deploy/docker-compose.yml logs --tail=100 api collector
```

## 2. 開啟 Android 模擬器

在第二個終端機執行。此專案先前的 `Medium_Phone_API_36` 虛擬磁碟實際只有約 6 GB；`Pixel_9_Pro_2` 有較大的 `/data` 空間，較適合安裝約 755 MB 的 Debug APK。

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$PATH"
emulator -list-avds
emulator -avd Pixel_9_Pro_2
```

模擬器視窗開啟後，在第三個終端機確認已完成開機：

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb devices -l
adb shell getprop sys.boot_completed
adb shell df -h /data
```

`adb devices -l` 應列出狀態為 `device` 的模擬器，開機屬性應是 `1`。如果顯示 `no devices/emulators found`，先等模擬器開完機，再執行安裝；不要先清除 AVD 資料。

## 3. 建置、安裝並開啟 App

```bash
cd /Users/ray/Desktop/OSS/android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.resilientgeo.mesh 1
```

安裝指令要看到 `Success`。`compileSdk`／NDK 提示是建置警告；若安裝失敗，請看 `adb install` 的實際錯誤，並先用 `adb shell df -h /data` 確認空間。不要在只有建置成功、但安裝失敗時執行 `monkey` 並誤認為新版已啟動。

首次開啟可能需要較久時間載入地圖與已儲存資料。若 Android 顯示「App 沒有回應」，先確認是否最終進入主畫面；若反覆發生，可用 `adb logcat -d -t 500 | rg 'ANR|FATAL EXCEPTION|GeolocatorLocationService'` 查看原因。建置或安裝成功本身不代表主畫面已載入。

## 4. 讓 App 使用筆電上的 Server

Android 模擬器內的 `localhost` 是模擬器自己；筆電的 `127.0.0.1:8787` 在模擬器內應寫成 **`http://10.0.2.2:8787/`**。新安裝的 Debug App 預設使用這個網址。若 App 曾經安裝過，舊設定會保留；到「個人 → 政府資料更新」確認「更新服務網址」是這個網址，再按「儲存並立即更新」。

同一個已儲存網址提供告警 feed、醫療／避難所簽章圖層及門牌包。按鈕會立即同步告警；**首次下載或更新靜態圖層，請完整關閉再開啟 App**。底圖 PMTiles 隨 APK 提供，不向 Server 下載。成功下載的簽章資料保存在手機內，離線重開仍可使用；到期告警會依有效期限處理。切換網址不會直接刪除舊的離線告警。

本機 HTTP 只開放給 Android Debug 版的 loopback／模擬器位址。Release 版仍要求 HTTPS；實體手機也不能用 `10.0.2.2`，需要可從手機連到的服務網址。

## 5. 常用操作

```bash
# API 近期日誌
docker compose --env-file .env -f deploy/docker-compose.yml logs --tail=100 api

# 關閉本機服務；不刪除已發布的 Docker volumes
docker compose --env-file .env -f deploy/docker-compose.yml stop api collector
```

Web 版使用**同源** `/feed.json`、`/v1/layers/*` 與 `/address-packs/*`。單獨執行 `flutter run -d chrome` 時，Flutter 開發伺服器不會自動代理這些 API 路徑；Web Demo 應透過同源反向代理提供頁面與 API。這不影響上述 Android 模擬器流程。
