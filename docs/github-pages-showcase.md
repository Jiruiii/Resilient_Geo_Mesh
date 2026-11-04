# GitHub Pages 手機展示

展示入口為 `https://jiruiii.github.io/Resilient_Geo_Mesh/`。網站由 [pages-showcase.yml](../.github/workflows/pages-showcase.yml) 在 `main` 推送或手動觸發時建置；儲存庫的 Pages 發布來源須設為 **GitHub Actions**。工作流程會以 `/Resilient_Geo_Mesh/` 為 base href 建置 Flutter Web、裁出雙北高解析圖磚、刪除正式版才需要的大型資料，然後部署靜態成品。

固定情境資料在 [scenario.json](../flutter/assets/data/showcase/scenario.json)，時間固定為 2026-11-04 10:00（臺灣時間）。道路路線存於 [routes.json](../flutter/assets/data/showcase/routes.json)，由 [build_routes.py](../tools/showcase/build_routes.py) 從內湖步行路網預先產生。路網未涵蓋或不連通的設施不會以直線假裝可達。

頁面開啟 10 秒後，固定道路封閉告警會出現並播放地圖動畫。若逃生路線已開啟，路線會自動避開告警重新規劃；告警詳情會收起路線面板以完整顯示。「個人」頁籤的重設入口會清除當次操作並重新倒數。求救、回報和通知狀態只存在當次頁面記憶體。網站不會連接政府或專案 API，也不會送出真實求救。

## 本機開啟

在專案根目錄執行：

```sh
npm run dev
```

在這台電腦的瀏覽器開啟 `http://localhost:8767/`。需要停止時，在執行中的終端機按 `Ctrl+C`。這個指令會以 `SHOWCASE_MODE=true` 啟動 Flutter Web 展示模式。

若要用同一個 Wi-Fi 網路的手機直接預覽，先停止上述伺服器，改用以下指令讓開發伺服器接受區域網路連線：

```sh
cd flutter
flutter run -d web-server --web-hostname 0.0.0.0 --no-web-resources-cdn --web-port 8767 --dart-define=SHOWCASE_MODE=true
```

在 Mac 另一個終端機執行 `ipconfig getifaddr en0` 查詢區域網路 IP，接著在手機瀏覽器開啟 `http://<Mac 的 IP>:8767/`。手機和 Mac 必須連在同一個 Wi-Fi。

## 發布到 GitHub Pages

1. 在 GitHub 開啟 `Jiruiii/Resilient_Geo_Mesh` 儲存庫，進入 **Settings → Pages**，將 **Build and deployment → Source** 設為 **GitHub Actions**。GitHub 的自訂工作流程發布方式也是使用這個 Pages 來源設定。[GitHub Pages 設定文件](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
2. 將要發布的變更提交並推送到 `main`。目前工作樹中的未提交變更不會被 GitHub Actions 讀取；推送後，[pages-showcase.yml](../.github/workflows/pages-showcase.yml) 會自動建置、測試並部署。
3. 在儲存庫的 **Actions → Publish mobile showcase** 檢查工作流程，等 `build-and-deploy` 成功後開啟 `https://jiruiii.github.io/Resilient_Geo_Mesh/`。也可以在 Actions 頁面手動執行此 workflow；手動執行會部署所選分支已提交的內容。

## 發布前本機驗收

需要重現 GitHub Actions 的正式建置時，執行：

```sh
cd flutter
flutter pub get
flutter test --no-pub test/showcase_fixture_test.dart test/showcase_simulation_test.dart test/showcase_app_test.dart
flutter build web --release --no-pub --no-web-resources-cdn --pwa-strategy=none --base-href /Resilient_Geo_Mesh/ --dart-define=SHOWCASE_MODE=true
cd ..
python3 -m pip install -r tools/maps/requirements-pmtiles.txt
python3 tools/showcase/clip_north_pmtiles.py flutter/assets/map/pmtiles/taiwan-north.pmtiles flutter/build/web/assets/assets/map/pmtiles/taiwan-north-clipped.pmtiles
mv flutter/build/web/assets/assets/map/pmtiles/taiwan-north-clipped.pmtiles flutter/build/web/assets/assets/map/pmtiles/taiwan-north.pmtiles
python3 tools/showcase/prepare_pages.py flutter/build/web
mkdir -p /tmp/oss-pages-preview/Resilient_Geo_Mesh
cp -R flutter/build/web/. /tmp/oss-pages-preview/Resilient_Geo_Mesh/
python3 -m http.server 8765 --directory /tmp/oss-pages-preview
```

接著在同一台電腦的手機尺寸瀏覽器開啟 `http://127.0.0.1:8765/Resilient_Geo_Mesh/`。這是已建置的 Pages 成品預覽；日常開發使用上面的 `npm run dev` 即可。地圖圖磚服務需要支援 HTTP Range；手機實際下載量應在部署後以瀏覽器網路面板確認。
