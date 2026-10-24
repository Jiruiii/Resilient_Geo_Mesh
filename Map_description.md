# Map Description

## 2026-10-11 全台 OSM 顯示修復

Web 與 Android 共用同一組離線 OSM 樣式、圖磚與字形，不需要申請地圖 API key。

- 修正 z13 以上概覽與區域圖層重疊、道路過粗，以及後畫的地表蓋住文字；道路依種類與縮放級別呈現。水域依幾何類型分成面與線，避免溪流線段被封閉填色成大片假水面。
- 四個高細節包移除內容完全相同的重複圖磚，236,650 個唯一圖磚的原始內容全部保留。五包總容量從 478,624,646 降至 303,924,719 bytes（減少 36.5%）。區域名稱代表載入分組，實際圖磚歸屬經去重後不再等同行政區；東部資料多數已由其他包持有，不是刪除東部地圖。
- 補齊原先只有空標頭的中文字形。字形來自固定版本的 MapLibre demotiles Noto Sans Regular，授權與逐檔雜湊保存在 `flutter/assets/map/fonts/NotoSansRegular/`。BMP 範圍內的參考地名逐字驗證有 bitmap；資料中「下石𥕢／石𥕢／𩻸魚堀」的兩個增補平面罕字不在這套字形範圍內，仍可能缺字。
- Web 先用小範圍 Range 請求判斷伺服器能力，支援 206 時只讀需要的圖磚。只回傳 200 的開發伺服器保留整包快取相容模式；正式展示宜用支援 HTTP Range 的靜態伺服器。
- Android 安裝圖資失敗後可重試，避免串流安裝失敗時改將整包大型圖資讀入 Dart 記憶體。
- 概覽縣市標籤啟用避讓與多方向擺放，避免雙北、基隆、新竹等密集地名互相重疊。

驗收位置定義於 `tools/maps/taiwan-map-checkpoints.json`：22 縣市代表點、綠島、蘭嶼、小琉球、東引、三處區域交界及恆春。這是代表點與圖磚完整性驗收，不代表逐條 OSM 道路人工校對；z16–17 仍由 z15 向量圖磚放大。

Windows 中文專案路徑與 Android Studio 啟動方式見 [Android README](android/README.md)。模擬器請用 **Hardware / Automatic GPU**；本機 SwiftShader 軟體 GPU 測試曾漏畫文字，硬體 GPU 已能正常呈現繁體地名。

### 本次驗收結果與限制

| 項目 | 結果 |
| --- | --- |
| 圖磚完整性 | 195 個縣市／行政區／離島參考點於 z8、12、13、14、15 均有圖磚；去重前後唯一圖磚內容一致 |
| Web | 30 點 × 4 種縮放 × 桌面淺色／手機深色，共 240 組檢查；最終樣式另重驗台北、高雄、馬祖、蘭嶼，無地圖載入錯誤 |
| Flutter／Android | Flutter 全套 285 項、Android JVM 187 項通過；最後樣式修改另跑針對性回歸測試；靜態分析無問題 |
| Android 顯示 | API 36 硬體 GPU 模擬器，30 點 × z13、15、17，共 90 組均有地表資料；實際確認繁體字、街道與離島 |
| Android 離線 | 最終 Debug 與 Profile APK 飛航模式冷啟動、地圖縮放及拖曳成功；Profile 另驗證台北模擬定位；重開沿用圖資，未出現 App 崩潰 |
| Web 拖曳 | 本機測試畫面間隔 p95 約 18 ms，測試期間未出現大於 50 ms 的間隔 |
| Android 拖曳 | 本機 1080 × 2400 模擬器，台北街道連續 16 次拖曳：Debug p95 29 ms／p99 57 ms；Profile p95 28 ms／p99 40 ms |

Android `gfxinfo` 仍記錄掉幀（Profile FrameTimeline janky 31.63%，legacy 4.46%），因此不能宣稱所有裝置穩定 60 FPS 或完全零卡頓。這些是模擬器量測，尚未以實體手機驗收；Profile 比 Debug 更適合展示效能。底圖離線驗收不等於事件 feed、地址下載或救災資料服務可斷網更新，這些流程維持既有行為。原始本機紀錄與截圖位於忽略版控的 `output/osm-*`。

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

## 線上國土測繪圖資（NLSC EMAP）

2026-10-24 起，Web 與 Android 可在有網路時以 NLSC「臺灣通用電子地圖」WMTS 作為底圖：

- 圖磚：`https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}`（JPEG、256 px、`Access-Control-Allow-Origin: *`），source bounds 為經度 118.0–122.2、緯度 21.5–26.5，source maxzoom 19。
- 程式：`flutter/lib/data/map_basemap.dart` 在載入樣式時把 raster source／layer 加在所有 OSM 圖層之上，預設隱藏；`MapCanvas` 只以 `setLayerVisibility` 切換，不重新載入樣式，因此事件、警報、路線圖層與 Flutter 標記不會重建。
- 模式：自動（預設）／國土測繪圖資／離線 OSM，存於 SharedPreferences `map.basemap_mode`。自動模式每 60 秒與 App 回到前景時探測一張約 2.4 KB 的海面圖磚（`12/1791/3436`，Web 以 `cache: no-store`），可連線才顯示 EMAP。
- 深色模式：同一圖層以 raster 濾鏡反轉亮度（`raster-brightness-min` 0.86／`-max` 0.08）、色相轉 180°、降低飽和度。
- 備援：OSM PMTiles 一律在下方渲染，單張 EMAP 圖磚失敗時顯示 OSM。
- 圖層順序：CWA 縣市警報面原本放在 OSM `taiwan-roads` 之下，現改為放在 NCDR 警報面之下、所有底圖（含 EMAP）之上，兩種底圖都看得到。OSM 模式下道路線會在 16% 透明的警報面下方。
- 不變：道路搜尋索引、門牌包與步行路網仍為離線 OSM 資料；路線在 EMAP 上可能與 EMAP 道路有數公尺差異。政府公告選點地圖維持離線 OSM。
- 授權標示：`© 內政部國土測繪中心`（MapLibre attribution）。

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
