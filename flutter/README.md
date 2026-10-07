# resilientgeo_flutter

ResilientGeo 的 Flutter add-to-app 地圖模組；Android host 位於 `../android/`。

> 2026-10-05：底圖已恢復舊有 OSM／Protomaps。Web 與 Android 直接使用 App 內附的五個 PMTiles，不提供底圖下載或切換流程。`TaiwanEMap6.mbtiles` 只保留為 NLSC 試用來源檔；相關歷史變更、zoom 和地理範圍見根目錄 [Map_description.md](../Map_description.md)。

## 目前狀態

- OSM 向量底圖、樣式、glyph、sprite 和 PMTiles 隨 Flutter／Android App 提供；地圖 zoom、相機中心及經緯度限制記錄在 [Map_description.md](../Map_description.md)。
- 政府事件 feed、簽章避難所／醫療圖層與簽章縣市門牌包維持獨立資料流程。它們仍透過 Web／Android 的驗簽 client 與 Server/API 串接；底圖不走該下載服務。資料來源與目前驗證狀態見 [資料說明](../data_description.md)、[點位涵蓋報告](../docs/data-coverage-2026-10-04.md) 與 [Central Server runbook](../docs/central-server-runbook.md)。
- 道路名稱搜尋使用隨 App 提供的 OSM 搜尋索引；門牌搜尋依使用者已取得的縣市包；步行路線另用雙北路網，不從底圖推算道路幾何。道路索引與路網產生方式見 [地圖工具說明](../tools/maps/README.md) 和[雙北路線文件](../docs/taipei-offline-routing.md)。
- 搜尋在背景 isolate 執行，marker projection 與行政區聚合使用快取；跨機型效能和完整實機離線流程仍須依裝置驗收。

## 驗證指令

```bash
flutter analyze --no-pub
flutter test --no-pub --timeout 2m --concurrency 2
flutter build web --release --no-web-resources-cdn --no-pub
```

Android 建置與測試：

```bash
cd ../android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

五個內建 PMTiles 會隨安裝包提供；Web／Android 實機驗收應確認安裝容量、首次地圖載入、縮放範圍與離線重開。Chrome 可預覽地圖與資料，但不提供 Android 的可信路線／回報儲存能力。

## Getting Started

For help getting started with Flutter development, view the online
[documentation](https://flutter.dev/).

For instructions integrating Flutter modules to your existing applications,
see the [add-to-app documentation](https://flutter.dev/to/add-to-app).
