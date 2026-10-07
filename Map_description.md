# Map Description

## 目前使用的離線 OSM 底圖

Web 與 Android 目前沿用原有的 OpenStreetMap／Protomaps 向量底圖。五個 PMTiles 資產隨 App 提供：`taiwan.pmtiles`、`taiwan-north.pmtiles`、`taiwan-central.pmtiles`、`taiwan-south.pmtiles`、`taiwan-east.pmtiles`。地圖載入時直接使用內建樣式和資產，不會向 Server 下載底圖；OSM attribution 為 `© OpenStreetMap contributors`。

相機與互動限制由 `flutter/lib/data/maplibre_map_config.dart` 設定：

| 設定 | 數值 | 說明 |
| --- | --- | --- |
| 最小縮放 | z5 | 地圖縮放滑桿 0% 的概覽級距 |
| 最大縮放 | z17 | 允許向量圖磚 overzoom；套件本身最高提供至 z15 |
| 初始縮放 | 10%／約 z6.2 | 未取得目前位置時的初始視野；百分比由 z5 線性換算至 z17 |
| 回到概覽 | 0%／z5 起 | 按「回到預設」後使用台灣概覽相機，實際 fit 會依畫布與控制項留白計算 |
| 預設中心 | 經度 121.05、緯度 23.65 | WGS84，台灣概覽中心 |
| 相機目標範圍 | 經度 118.0–122.2、緯度 21.5–26.5 | WGS84；縮放高於 z8.5 時，視窗會一起限制在這個範圍內 |

z8.5 以下的概覽視野會依裝置畫布大小動態放寬相機邊界，確保概覽完整顯示台灣；尚未取得畫布尺寸時，MapLibre 使用 `[105, 5, 137, 42]` 的暫用邊界。若低縮放時畫布大於概覽範圍，中心點另限制在 `[120.0, 23.5, 122.1, 24.1]`。搜尋或定位可依功能將相機移到較高縮放級距。

五個 PMTiles header 中的資料 zoom 與 bounds 如下（bounds 順序為 `[west, south, east, north]`，WGS84）：

| PMTiles | 資料 zoom | bounds |
| --- | --- | --- |
| `taiwan.pmtiles` | z0–z12 | `[118.0, 21.8, 122.2, 26.5]` |
| `taiwan-north.pmtiles` | z13–z15 | `[118.0, 24.0, 122.2, 26.5]` |
| `taiwan-central.pmtiles` | z13–z15 | `[118.0, 23.0, 121.6, 24.1]` |
| `taiwan-south.pmtiles` | z13–z15 | `[118.0, 21.8, 121.6, 23.8]` |
| `taiwan-east.pmtiles` | z13–z15 | `[120.8, 21.8, 122.2, 25.5]` |

因此 z16–z17 是套件資料之上的 MapLibre overzoom。相機可視邊界和各 PMTiles 的資料 bounds 不同；不能只用相機邊界推定每一處都有同樣的圖磚細節。

## NLSC 底圖試用紀錄（歷史，非目前底圖）

保留在根目錄的 `TaiwanEMap6.mbtiles` 是 NLSC「臺灣通用電子地圖」原始 MBTiles。這份資料只供追溯先前的底圖試用；NLSC 轉出的 PMTiles、manifest、Web／Android 下載器、底圖選擇介面及 Server `/maps/*` 發布路徑已移除。NLSC 圖磚不會由目前 App 載入或下載。

原始檔大小為 663,729,152 bytes。MBTiles metadata 記錄如下：

| 欄位 | 值 |
| --- | --- |
| `format` | `jpg` |
| metadata bounds（W,S,E,N） | `[117.9, 21.8, 124.8, 26.4]` |
| metadata `minzoom` / `maxzoom` | `7` / `15` |
| tiles table 實際 zoom | `z6–z15`（z6 有 6 張圖磚） |

因此 metadata 的最小 zoom 和圖磚表實際內容不同。按 z6 圖磚索引換算，最低層圖磚的外框約為經度 112.5–129.375、緯度 21.9430–31.9522；這是完整 tile 的矩形外框，不代表範圍內每個位置都含有效影像。`bounds` metadata 是來源宣告的資料範圍；圖磚外框較大是低 zoom 圖磚以整張 tile 覆蓋所造成。

先前試用以 z6–z15 作為 NLSC 相機縮放範圍。這不是目前 OSM 地圖的縮放設定。先前轉製的 PMTiles 僅為歷史產物，現行目錄不再發布該產物；目前留下的 NLSC 底圖原始檔只有 `TaiwanEMap6.mbtiles`。

## 座標與範圍解讀

- 經緯度以 WGS84 十進位度數表示；範圍陣列順序為 `[west, south, east, north]`，不是 `[latitude, longitude]`。
- MBTiles 的 `bounds` 是來源 metadata 範圍；實際 `tiles` 表是否有相應圖磚，仍需依 zoom 和 tile index 判斷。
- 地圖相機可移動範圍、MBTiles 宣告範圍、PMTiles package bounds 是三種不同限制，不應互相代替。
- NLSC 試用數值用來辨識舊資料；目前底圖樣式、zoom、相機限制與 attribution 以內建 OSM／Protomaps 資產及程式設定為準。
