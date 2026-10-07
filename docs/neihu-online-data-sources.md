# Task 1：內湖區線上資料來源盤點

盤點日期：2026-09-04

本文件是 Task 1 的「上網找來源」成果。它確認來源、內湖適用方式、授權門檻與資料粒度。共用資料契約已由 Task 1 完成，Raw／Geo 共用模組與官方內湖 boundary 已由 Task 2 完成；TDX、CWA 與 NCDR 的動態來源介面已在 Task 3/4 建立；OSM、避難所與醫療 Static Feature 已由 Task 5 建立。

## 結論

- GNSS / GPS 不用上網找。它是 Android 裝置執行時取得的使用者位置，由 B 處理，A 不建立外部 Collector，也不把個人軌跡放進共享資料。
- A 需要找並登錄其餘九類外部資料，另外需要一份官方內湖行政區邊界，作為跨來源的空間過濾基準。
- 能直接得到內湖欄位或座標的來源：OSM、TDX 回應欄位、NCDR 部分資料、避難所、醫療、NCC。
- 只能先取得臺北市範圍再套用到內湖的來源：CWA 縣市級警特報，以及部分 NCDR CAP 示警。
- DEM / DSM、SAR / 光學影像是全臺或衛星景幅資料，必須用內湖 polygon 選圖磚、裁切；它們不是即時事件 API。

完整機器可讀註冊表位於 `pipeline/sources/catalog.json`。

## 內湖範圍基準

優先使用臺北市政府的[臺北市區界圖](https://data.taipei/dataset/detail?id=1601ef3a-c253-4988-b047-943d9e786143)。來源是 SHP、座標系統為 TWD97；先選出 `TNAME=內湖區`，再轉成 EPSG:4326 GeoJSON。

OSM 內湖區 relation 已實測為 `2905065`、`admin_level=7`，邊界 bbox 為：

```text
[121.5519933, 25.0518603, 121.6286149, 25.1151519]
```

OSM relation 可用於 Overpass 擷取，但最終是否屬於內湖，仍以官方臺北市區界圖做驗證。

## 資料來源與內湖適用方式

| 類別 | 找到的來源 | 內湖處理 | 存取與限制 | 建議階段 |
| --- | --- | --- | --- | --- |
| GNSS / GPS | Android 裝置 Location | B 在手機本機判斷是否位於內湖 | 非外部資料；不得進 A 的共享 Raw | B |
| OpenStreetMap | [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) | 用 relation `2905065` 擷取道路與 POI，再以官方 polygon 驗證 | 無 API key；ODbL，必須標示 OpenStreetMap attribution | P1 |
| TDX | [道路事件 v1 Swagger](https://tdx.transportdata.tw/api-service/swagger/basic/60abfa19-ffe3-4eef-a4b1-0539435dfca9) | 呼叫 `City/Taipei`，以 `Town=內湖區` 與 geometry 雙重篩選 | 程式介接要 OAuth2 Client ID / Secret；無金鑰實測為 401 | P1 |
| CWA 地震 | [E-A0015-001 顯著有感地震](https://opendata.cwa.gov.tw/dataset/earthquake/E-A0015-001) | 保留臺北市震度區或內湖測站；只有市級時標 `coverage_level=city` | 需 CWA 授權碼；事件型、不定期 | P1 |
| CWA 天氣 | [W-C0033-001 警特報](https://opendata.cwa.gov.tw/dataset/warning/W-C0033-001) | 篩選臺北市；不可宣稱是內湖區專屬警報 | 需 CWA 授權碼；以縣市為主要粒度 | P1 |
| NCDR | [API 介接文件](https://datahub.ncdr.nat.gov.tw/paradigm)、[示警 API 入口](https://alerts.ncdr.nat.gov.tw/alertMessageAPI.aspx) | 優先用 CAP polygon／行政區碼交集；只有臺北市時保留市級標記 | 正式 live 需 API key；具體 datastore 路徑與可用資料集依帳號開通；期限內 Demo 使用 Neihu simulation/replay fallback | P1 |
| 避難所 | [消防署避難收容處所點位檔](https://data.gov.tw/dataset/73242) | 靜態點位依 `臺北市內湖區` 篩選，保留預計收容容量；目前不收集開設狀態 | 點位 CSV 無金鑰；開設狀態資料更新不定期，暫不納入 collector | P1 |
| 醫療 | [臺北市公私立醫療院所](https://data.taipei/dataset/detail?id=ffdd5753-30db-4c38-b65f-b77892773d60) | 醫院地址含內湖區，再用座標與 polygon 驗證 | 無金鑰；年度更新；先收醫院，不先收全部診所 | P1 |
| DEM / DSM | [2025 年 20m DTM](https://data.gov.tw/dataset/176927)、[100m DEM / DSM](https://data.gov.tw/dataset/7507) | 找出與內湖 polygon 相交的圖磚，轉座標後裁切 | 靜態檔案、不定期；20m 來源是 DTM，DSM 可用 100m 備援 | P2 |
| 網路資料 | [NCC 鄉鎮區基地臺統計](https://data.gov.tw/dataset/41256) | 直接篩選 `臺北市內湖區` | 只有 4G/5G 執照數量，不是訊號覆蓋圖或災時中斷資料 | P2 |
| SAR / 光學影像 | [Copernicus STAC](https://documentation.dataspace.copernicus.eu/APIs/STAC.html) | 用內湖 bbox、日期、`sentinel-1-grd`／`sentinel-2-l2a` 搜尋，下載後再裁切 | STAC 是影像目錄；影像判釋與淹水辨識不是 A 的 Collector 工作 | P3 |

## 已做的線上驗證

這些數字只是 2026-09-04 的來源可用性證據，不能當成固定業務數字：

- OSM：內湖 relation 存在；Overpass `highway` count 查到 5,775 個 ways。
- TDX：官方 OAS 確認 endpoint 為 `/v1/Traffic/RoadEvent/LiveEvent/City/{City}`，`Taipei` 是合法 city code；回應 schema 具有 `Town`、`Positions`、`Geometry`。無金鑰最小請求回傳 HTTP 401。
- 臺北市年度避難所名冊：API 全部 399 筆中，依 `鄉鎮=內湖區` 在本次來源版本篩到 38 筆；這份資料沒有座標，因此地圖點位應以消防署點位檔為主。
- 消防署避難所點位檔：直接確認有多筆 `臺北市內湖區` 資料，包含經緯度、容量與適用災害類別。
- 臺北市醫院清冊：本次 API 版本依地址篩到 4 筆內湖區醫院。
- NCC：最新驗證統計期 `1150831` 有內湖區 4G 與 5G 紀錄；只能當基礎設施密度 proxy。
- Copernicus：用內湖 bbox 與 2026-08-01～2026-09-04 查詢，Sentinel-1 GRD 與 Sentinel-2 L2A 都有相交景幅。

## 來源信任與合併規則

1. 官方資料、OSM、群眾回報使用不同 namespace，不互相覆寫。
2. Collector 只保存 Raw、篩選內湖、正規化欄位／時間／座標及做品質驗證；不在 A 計算坡度、孤立風險、訊號脆弱度或影像災損判釋。
3. 靜態名冊與災時狀態分開，例如「可供避難」不等於「目前已開設」。
4. CWA／NCDR 只有臺北市粒度時，保留 `coverage_level=city`，不可補造內湖區精度。
5. 同名避難所若容量或災種不同，不直接覆蓋；保留各來源版本，再依名稱、地址、座標建立對照與衝突紀錄。

## Task 1 現況

- 已完成：線上來源發現、官方入口確認、內湖適用性判定、授權門檻、來源註冊表、`feature-v0`、layer manifest/chunk schemas、schema tests 與 `docs/data-contract-v0.md` 更新。
- Task 2 已完成：`pipeline/lib/source.mjs`、`pipeline/lib/geo.mjs`、官方 `pipeline/sources/boundaries/taipei-neihu.geojson` 與共用層測試。
- 已完成：Task 3 TDX、Task 4 CWA／NCDR 動態事件 Collector、Raw snapshot 契約、Neihu normalized fixture、CLI 與缺少授權時的 source status。
- 已完成：Task 5 OSM、避難所與醫療 Static Feature Collector、Raw fixture、正規化與靜態 layer bundle CLI。公開 smoke check 取得 OSM 5,939 筆、避難所 26 筆、醫療 4 筆內湖 features；這些是 2026-09-04 的一次抓取結果，不是固定數量。
- 尚未完成：DEM／DSM、網路與 SAR／光學資料準備；避難所點位檔本身不含即時開設狀態，狀態需另接開設情形來源。
- NCDR live：帳號驗證完成後才填入帳號核發的 `NCDR_API_KEY` 與完整 `NCDR_API_ENDPOINT`；在此之前標記為 `blocked_by_access`，不阻塞 Demo。
- Demo fallback：使用 `data/fixtures/neihu/manifest.json`、`scenario.json`、`update-sequence.json` 與 `pipeline/lib/neihu-replay.mjs`；災情事件是模擬資料，不是即時官方 NCDR 資料。
