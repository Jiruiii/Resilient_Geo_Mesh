# ResilientGeo 資料說明

本文件整理目前 Server、資料管線與 Android/Flutter App 的資料來源、用途、串接狀態與實際資料範例。

## 0. 本文件的資料基準

以下是本機 Docker Compose 在醫療官方座標補足功能加入前擷取的歷史快照，擷取時間為 `2026-10-02T09:35:43.785Z`（UTC）。它用來說明資料格式與當時的真實前五筆，不是本次修改後的驗收結果；修改後請以 `npm run server:health` 與當下的 `feed.json`／`source-status.json` 為準：

**2026-10-03 範圍更新：**動態 `taiwan-shelter-status` 已從目前 collector、source registry 與部署排程移除。下方 `shelter-status` 的數量、endpoint 與事件範例都是 2026-10-02 歷史快照，不代表目前仍在收集；下一次完整成功發布後，current feed 會不再包含此 dataset。靜態避難所位置與預計容量維持收集。

| 項目 | 實際值 |
| --- | --- |
| Compose project | `deploy` |
| 自動收集容器 | `deploy-collector-1` |
| API 容器 | `deploy-api-1` |
| HTTPS Proxy | `deploy-proxy-1` |
| Feed revision | `15`（歷史快照） |
| Feed 建立時間 | `2026-10-02T09:35:43.785Z` |
| Feed schema | `government-feed-v1` |
| 動態公開資料集 | `cwa-warning`、`ncdr`、`shelter-status`（歷史快照） |

這是一次實際執行結果的快照。Server 會繼續依排程更新，因此資料筆數、版本與時間會改變；本文件不會自動跟著 Feed 更新。

**2026-10-04 本機點位重收集：**直接取得衛福部 24,138 筆醫療主檔，嚴格定位後 479 筆已定位、23,659 筆未定位、0 筆排除；避難處所來源 5,973 筆，行政區核對後 5,727 筆已定位、180 筆未定位、66 筆排除。逐縣市報告在 [docs/data-coverage-2026-10-04.md](docs/data-coverage-2026-10-04.md)。同一輪產出的點位 layer 與醫療名錄已在本機簽章，並由 Web 與 Android API 36 模擬器下載、驗簽；尚未發布到正式 Server。這不是 10-02 的 Server 快照。

## 1. 系統資料流

```text
官方資料來源
    ↓
deploy-collector-1
    ├─ 呼叫官方 API／下載檔案
    ├─ 寫入 private source cache
    ├─ 正規化、過期判斷、範圍判斷與簽章
    └─ 發布 current/feed.json 或 static layer
            ↓
deploy-api-1
            ↓
deploy-proxy-1（HTTPS）
            ↓
Android GovernmentSyncManager
            ↓
Android Room／EventChannel
            ↓
Flutter 地圖、事件通知、避難所狀態與路線判斷
```

重要邊界：

- App 不直接攜帶 TDX、CWA、NCDR 的 API key，也不直接呼叫這些官方 API。
- `collector` 先集中抓取資料，App 只下載 Server 已驗證、簽章的 Feed 或圖層。
- 動態災害事件放在 `government-feed-v1`；避難所位置、醫療院所等靜態資料是獨立 layer。
- App 目前仍未因本文件修改 Android；Android 是否連到這台本機 Server，仍由 App 的更新網址設定決定。

## 2. Server 排程

| 資料類型 | 排程 | 目前是否啟用 |
| --- | ---: | --- |
| CWA 地震、天氣特報、颱風 | 每 10 分鐘 | 是 |
| NCDR 災害事件 | 每 10 分鐘 | 是 |
| 避難所開設狀態 | 每 15 分鐘（歷史排程） | 否，2026-10-03 起從 collector 移除 |
| 避難所位置、醫療院所靜態資料 | 每 24 小時 | 是，但依快取判斷是否變更 |
| TDX 道路事件 | 每 15 分鐘 | 否，明確 opt-in |
| OSM 全台 POI | 每 24 小時 | 否，明確停用 |

Server 啟動時會先執行一次收集，成功後啟動排程。資料收集失敗、結果不完整或結果為空時，不會覆蓋上一版完整 Feed。

## 3. 目前接入的資料來源

`status` 是 `/v1/source-status` 對外狀態。`not_modified` 代表這次排程成功確認來源與快取相同，並不是錯誤；`disabled` 代表依目前專題決策停用，不是 API 故障。

| source_id | 實際資料 | Server 用途與範圍 | App 使用方式 | 目前狀態與實際數量 |
| --- | --- | --- | --- | --- |
| `ncdr-hazard-events` | NCDR 多機關災害示警／CAP，包含強降雨、淹水、土石流、崩塌、水庫、海洋污染等 | Server 以全台範圍收集；完整正規化資料留在 private cache，公開 Feed 排除 `BACKGROUND` | 下載後驗證並寫入 Room，供地圖災害圖層、事件通知與避難判斷 | `not_modified`；private normalized `100` 筆，公開 Feed `7` 筆；`TW` |
| `cwa-earthquake` | 氣象署有感地震、震央與各地震度 | 全台事件來源；以地震編號與發布時間保存事件 | 可進入地圖事件、通知與事件快照 | `not_modified`；private cache `16` 筆；本版沒有可發布的目前事件資料集；`TW` |
| `cwa-weather-warning` | 氣象署縣市天氣特報，例如大雨、強風 | 全台縣市／行政區警示；使用生效與結束時間判斷有效性 | 地圖警示、事件詳情與通知 | `not_modified`；private normalized `20` 筆，公開 Feed `29` 筆；`TW` |
| `cwa-typhoon-warning` | 氣象署颱風警報與颱風資訊 | 全台颱風警報事件；解除或過期事件不進入目前公開 Feed | 可進入地圖事件與通知 | `not_modified`；private cache `1` 筆且已過期；本版沒有公開資料集；`TW` |
| `taiwan-shelter-status` | 全台避難收容處所開設、開放、額滿、關閉狀態 | 歷史上的獨立狀態事件來源；目前已退出 collector | Web／Android 忽略舊 `SHELTER_STATUS / FIRE_AGENCY` 事件，並清除 Android 已存事件；目前 Server 不再更新 | 歷史快照 `ok`；公開 Feed `7,219` 筆；非目前狀態 |
| `taiwan-shelter` | 全台避難收容處所名稱、座標、容量、適用災害類型 | 獨立簽章 static layer；10-02 Server 數字 `5,907` 是未套用本次嚴格位置核對的歷史版本 | Web／Android 都透過已驗簽的 layer client 載入；目前本機部署目錄沒有新避難 layer，不能說 App 已顯示 | 10-04 本機重收集：來源 `5,973`，已定位 `5,727`、未定位 `180`、排除 `66`；未簽章／未發布 |
| `taiwan-medical` | 全台醫療院所名稱、地址、電話、科別等主檔 | MOHW 主檔經 NLSC 半徑查詢及已簽章門牌地址包補座標；不唯一或行政區／地址不一致就不產生地圖點 | Web／Android 都支援驗簽下載靜態 layer 及醫療名錄；同一輪 bundle 已本機簽章並由兩端下載驗證，舊快照不作發布 fallback；尚未部署正式 Server | 10-04 本機重收集：主檔 `24,138`，已定位 `479`、未定位 `23,659`、排除 `0`；狀態 `partial`，尚未發布正式服務 |
| `tdx-road-events` | TDX 道路事故、施工、壅塞、管制與道路異常 | Adapter 保留，但目前不放入核心災害 Feed，且預設停用；不能把舊快取當成目前全台即時資料 | 目前不進入核心 App 災害資料 | `disabled`；最後快取 `2,174` 筆，取得時間 `2026-10-02T06:47:02.446Z`；`TW` metadata，但目前未持續收集 |
| `osm-taiwan` | OSM 醫院、診所、避難所等 POI，可協助座標補足 | 目前停用；先前 layer 仍可能保留在 Server，但不是本次排程更新的資料 | 不是災害警報；目前 Android 不從 Server 動態下載 OSM layer | `disabled`；最後快取 `8,900` 筆，取得時間 `2026-10-02T06:03:46.104Z`；舊 layer 仍可能存在 |

### 3.1 全台範圍的正確解讀

- NCDR Server 端是全台收集，不再由 Server 預設限制雙北。
- CWA 三種來源的 source coverage 是 `TW`，但目前 Feed 只發布未過期且符合發布條件的事件；沒有公開資料集不代表 API 呼叫失敗。
- 避難所位置與避難所狀態是不同資料集；目前 Server 只收集靜態位置與預計容量，狀態來源已停用。10-04 本機資料有 5,727 個通過縣市／地址核對的點；舊的 5,907 feature 快照不再視為全部可信位置。
- 醫療主檔是全台下載。10-04 本機重收集已配到 479 筆、另有 23,659 筆未定位；未定位項目仍可留在搜尋名錄，但不畫成點。完整逐縣市數量見涵蓋報告；這不是已發布 Server 狀態。
- TDX、OSM 的 registry coverage 雖然標示 `TW`，目前來源本身是停用狀態，因此不能宣稱目前有持續取得全台即時 TDX／OSM 資料。

### 3.2 Server 實際使用的官方 endpoint

認證資訊只存在 `.env`／Server secret，不在本文件列出。

| source_id | endpoint 或資料入口 |
| --- | --- |
| `ncdr-hazard-events` | `https://alerts.ncdr.nat.gov.tw/api/datastore`；詳細 CAP 由 `https://alerts.ncdr.nat.gov.tw/api/dump/datastore` 取得 |
| `cwa-earthquake` | `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001` |
| `cwa-weather-warning` | `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-001` |
| `cwa-typhoon-warning` | `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-001` |
| `taiwan-shelter-status` | `https://portal2.emic.gov.tw/Pub/EEA2/OpenData/Shelter.xml`（歷史 endpoint；目前 collector 不呼叫） |
| `taiwan-shelter` | 內政部避難收容處所下載資源：`https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/ED6CF735-6C03-4573-A882-72C1BEC799CB/resource/54550E2F-4567-4C8F-BD2E-E54E9D0386B8/download` |
| `taiwan-medical` | 衛生福利部醫療機構主檔：`https://www.mohw.gov.tw/dl-96581-66dbb751-f83a-416a-a998-893222e20fef.html` |
| `taiwan-medical` 座標 | 國土測繪中心醫療設施 API：`https://api.nlsc.gov.tw/other/MarkBufferAnlys/med/{longitude}/{latitude}/{radiusMeters}`；必要時再加入已審核的官方衛生局來源 |
| `tdx-road-events` | 預設道路事件 endpoint：`https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/City/Taipei?$format=JSON`；目前來源停用 |
| `osm-taiwan` | Overpass API：`https://overpass-api.de/api/interpreter`；目前來源停用 |

## 4. 本次實際公開 Feed

2026-10-02 歷史快照中的 `current/feed.json` 動態資料集如下：

| dataset | 對應來源 | 事件數 | chunk 數 | 說明 |
| --- | --- | ---: | ---: | --- |
| `government-cwa-warning` | `cwa-warning` | `29` | `29` | 目前可發布的天氣特報事件 |
| `government-ncdr` | `ncdr` | `7` | `7` | 已排除公開不需要的 `BACKGROUND` 事件 |
| `government-shelter-status` | `shelter-status` | `7,219` | `3,708` | 全台避難所狀態事件 |

CWA 地震與颱風在本次 revision 沒有公開 dataset，是因為目前快取事件已過期或沒有符合發布條件的有效事件；source status 仍是成功的 `not_modified`。

靜態 layer 不放在 `feed.json` 的 `datasets` 裡；下表是 2026-10-02 Server 歷史快照，不代表目前本機工作樹或線上服務可下載：

| layer | 版本 | feature 數 | 建立時間 | 狀態 |
| --- | ---: | ---: | --- | --- |
| `taiwan-shelter` | `5` | `5,907` | `2026-10-02T09:20:09.599Z` | 歷史 layer；本次嚴格核對後 5,727 點，尚未簽章／發布 |
| `osm-taiwan` | `3` | `8,900` | `2026-10-02T06:27:42.447Z` | 來源已停用，這是保留的舊 layer |
| `taiwan-medical` | — | `0`（歷史快照；需重新收集驗證） | — | 新流程會在有非零座標 feature 且驗證通過時發布；失敗時保留上一版 |

## 5. App 目前如何使用資料

### 5.1 動態災害事件

Android 的 `GovernmentSyncManager` 會：

1. 從設定的 HTTPS Server base URL 讀取 `/feed.json`。
2. 驗證受信任的 feed public key、Feed signature、manifest、chunk 與 event signature；目前 Server 使用 `central-server-2026`，客戶端保留 `government-feed-2026` 相容性。
3. 只下載需要的 chunk，並寫入 Android Room。
4. Flutter 透過 `MapBridge`／`EventChannel` 讀取已驗證的事件。
5. `MapScreen` 顯示地圖事件；通知頁顯示事件詳情；路線判斷會使用有效的災害／避難所狀態事件。

App 的資料範圍選擇：

- `taipei`：下載臺北、新北相關行政區，加上全台範圍事件與全台警報。
- `all`：下載 Feed 中所有行政區 chunk，才是完整的 App 全台下載模式。
- Server 端仍然是全台收集；App 的 `taipei`／`all` 是手機下載量的選擇，不是 Server 收集範圍。

### 5.2 靜態地圖與設施

- 避難所：收到已驗證靜態 layer 後可顯示地圖 marker、名稱／地址／容量、適用災害類型、搜尋與避難路線目的地；目前本機部署目錄沒有新 layer 發布檔。
- 避難所狀態：本文件的歷史快照曾含 `SHELTER_STATUS` 事件；目前 Server 不再收集或更新，Web／Android 也不接收或顯示舊的 `SHELTER_STATUS / FIRE_AGENCY` 動態事件。靜態避難所 layer 只提供位置與預計容量，不代表開設狀態或即時收容人數。
- 醫療院所：收到已驗證靜態 layer 後顯示醫療 marker，並以簽章名錄搜尋未定位院所；未定位紀錄不顯示成地圖點。目前本機部署目錄尚無新的 `medical` verified static layer，舊 Flutter／Android 快照已不作為發布 fallback。
- OSM：不是災害警報；目前停用，不能當成目前 App 的即時資料來源。

### 5.3 App 與目前本機 Server 的連線狀態

App 的預設資產 `android/app/src/main/assets/trust/government-service.json` 目前設定為：

```text
https://resilientgeo-feed.pages.dev/
```

因此，App 有 Server Feed 同步能力，但不代表已經自動連到本機的 `https://localhost`。要使用本機或之後的 Azure VPS，必須在 App 的「個人設定 → 政府資料更新」設定可由手機存取的 HTTPS 網址；本文件沒有修改 Android 設定。

## 6. 真實收集資料前五筆摘要

以下資料是從 `deploy-collector-1` 的 private normalized cache 及 revision 15 的 public release 讀取。為避免文件過大，每筆只列識別、時間、範圍與可讀欄位；原始 geometry、signature 與完整 `source_record` 沒有放入文件。

### 6.1 動態事件

#### `cwa-earthquake`（private cache；16 筆，當下均已過期）

| # | event_id | event_type | area_id | issued_at | expires_at |
| ---: | --- | --- | --- | --- | --- |
| 1 | `cwa:earthquake:115067:report` | `EARTHQUAKE_INTENSITY` | `tw` | `2026-09-30T05:00:24Z` | `2026-09-30T13:06:03Z` |
| 2 | `cwa:earthquake:115066:report` | `EARTHQUAKE_INTENSITY` | `tw` | `2026-09-28T18:20:45Z` | `2026-09-29T02:24:56Z` |
| 3 | `cwa:earthquake:115065:report` | `EARTHQUAKE_INTENSITY` | `tw` | `2026-09-27T07:33:02Z` | `2026-09-27T15:36:29Z` |
| 4 | `cwa:earthquake:115064:report` | `EARTHQUAKE_INTENSITY` | `tw.67000240` | `2026-09-21T21:16:13Z` | `2026-09-22T05:19:16Z` |
| 5 | `cwa:earthquake:115063:report` | `EARTHQUAKE_INTENSITY` | `tw` | `2026-09-13T22:44:41Z` | `2026-09-14T06:49:45Z` |

#### `cwa-weather-warning`（private normalized cache；20 筆）

| # | event_id | area_id | affected_area | source_description | issued_at |
| ---: | --- | --- | --- | --- | --- |
| 1 | `cwa:warning:w-c0033-001:64:2026-10-02-17:21:00:0` | `tw.64000010` | 高雄市 | 大雨 | `2026-10-02T09:21:00Z` |
| 2 | `cwa:warning:w-c0033-001:67:2026-10-02-17:21:00:0` | `tw.67000010` | 臺南市 | 大雨 | `2026-10-02T09:21:00Z` |
| 3 | `cwa:warning:w-c0033-001:10015:2026-10-02-17:21:00:0` | `tw.10015010` | 花蓮縣 | 大雨 | `2026-10-02T09:21:00Z` |
| 4 | `cwa:warning:w-c0033-001:10018:2026-10-02-17:21:00:0` | `tw.10018010` | 新竹市 | 大雨 | `2026-10-02T09:21:00Z` |
| 5 | `cwa:warning:w-c0033-001:9007:2026-10-02-16:34:00:0` | `tw.09007010` | 連江縣 | 陸上強風 | `2026-10-02T08:34:00Z` |

#### `cwa-typhoon-warning`（private cache；只有 1 筆）

| # | event_id | event_type | affected_area | source_description | expires_at |
| ---: | --- | --- | --- | --- | --- |
| 1 | `cwa:warning:w-c0034-001:typhoon:2026-08-28t14:30:00-08:00:0` | `TYPHOON_WARNING` | 全台縣市與離島 | 解除颱風警報 | `2026-08-28T06:40:00Z` |

#### `ncdr-hazard-events`（private normalized cache；100 筆）

| # | event_id | event_type | affected_area 摘要 | operational_relevance | map_visible |
| ---: | --- | --- | --- | --- | --- |
| 1 | `ncdr:wra_reservoirwarn_20261002171840_0001` | `RESERVOIR_RELEASE_WARNING` | 雲林、嘉義多個鄉鎮 | `HIGH_IMPACT` | `true` |
| 2 | `ncdr:twc_water_202610021710` | `WATER_SUPPLY_ALERT` | 基隆市暖暖區碇安里 | `BACKGROUND` | `false` |
| 3 | `ncdr:twc_water_202610021710` | `WATER_SUPPLY_ALERT` | 基隆市暖暖區碇安里 | `BACKGROUND` | `false` |
| 4 | `ncdr:twc_water_202610021640` | `WATER_SUPPLY_ALERT` | 桃園市龜山區多個里 | `BACKGROUND` | `false` |
| 5 | `ncdr:cwa-weather_strong-wind_202610021636001` | `NCDR_HAZARD` | 桃園、苗栗、臺中、澎湖、連江 | `HIGH_IMPACT` | `true` |

`BACKGROUND` 事件仍保留在 private cache，供追溯與後續分析；不會進入目前對 App 發布的核心災害 Feed。

#### `taiwan-shelter-status`（公開 Feed；7,219 筆）

| # | event_id | event_type | area_id | status | issued_at |
| ---: | --- | --- | --- | --- | --- |
| 1 | `shelter:001:status` | `SHELTER_STATUS` | `tw.10014010` | `CLOSED` | `2026-10-02T09:35:43.785Z` |
| 2 | `shelter:011:status` | `SHELTER_STATUS` | `tw.10004020` | `CLOSED` | `2026-10-02T09:35:43.785Z` |
| 3 | `shelter:10:status` | `SHELTER_STATUS` | `tw.68000010` | `CLOSED` | `2026-10-02T09:35:43.785Z` |
| 4 | `shelter:111:status` | `SHELTER_STATUS` | `tw.67000130` | `CLOSED` | `2026-10-02T09:35:43.785Z` |
| 5 | `shelter:1120000001:status` | `SHELTER_STATUS` | `tw.68000010` | `CLOSED` | `2026-10-02T09:35:43.785Z` |

#### `tdx-road-events`（停用來源的舊 private cache；2,174 筆）

| # | event_id | event_type | area_id | issued_at | expires_at |
| ---: | --- | --- | --- | --- | --- |
| 1 | `tdx:379530000h_001-01-115002281` | `ROAD_CONSTRUCTION` | `tw.63000120` | `2026-10-02T00:00:00+08:00` | `2026-10-02T07:03:21Z` |
| 2 | `tdx:379530000h_001-01-11501977-1` | `ROAD_CONSTRUCTION` | `tw.63000120` | `2026-10-02T00:00:00+08:00` | `2026-10-02T07:03:21Z` |
| 3 | `tdx:379530000h_001-01-11405325-3` | `ROAD_CONSTRUCTION` | `tw.63000120` | `2026-10-02T00:00:00+08:00` | `2026-10-02T07:03:21Z` |
| 4 | `tdx:379530000h_001-01-11405325-3` | `ROAD_CONSTRUCTION` | `tw.63000120` | `2026-10-02T00:00:00+08:00` | `2026-10-02T07:03:21Z` |
| 5 | `tdx:379530000h_001-01-11405325-3` | `ROAD_CONSTRUCTION` | `tw.63000120` | `2026-10-02T00:00:00+08:00` | `2026-10-02T07:03:21Z` |

這組資料只是停用前留下的快取範例，不代表目前 Server 正在抓取 TDX，也不代表 TDX 目前已涵蓋所有縣市。

### 6.2 靜態資料與未解析資料

#### `taiwan-shelter`（5,907 個 feature 是 10-02 歷史輸出）

這一版尚未檢查來源縣市／鄉鎮文字與座標是否一致；其中至少有跨縣市或跨鄉鎮的座標，所以不再把舊 feature 範例列為已核實點位。10-04 重新檢查後的匿名逐縣市數量見 [點位涵蓋報告](docs/data-coverage-2026-10-04.md)。

#### `taiwan-medical`（歷史快照的 private cache；24,138 筆未解析）

這些是醫療官方座標補足功能加入前，Server 實際下載到、但當時沒有形成座標 feature 的資料；它們不是本次 NLSC 查詢後的結果：

| # | medical_id 對應名稱 | 地址 | geometry_status |
| ---: | --- | --- | --- |
| 1 | 頤鳴堂中醫診所 | 臺北市松山區長春路446號(1樓) | unresolved |
| 2 | 杏頤牙醫診所 | 臺北市松山區復興北路361巷2之1號(1樓) | unresolved |
| 3 | 禾玥醫學診所 | 臺北市松山區南京東路3段269巷6號1樓 | unresolved |
| 4 | 微醫未來美學診所 | 臺北市松山區南京東路5段166、168號11樓 | unresolved |
| 5 | 安悅美學牙醫診所 | 臺北市松山區南京東路4段77號1樓 | unresolved |

#### `osm-taiwan`（停用來源的舊 private cache；8,900 個 feature）

| # | feature_id | feature_type | 名稱 | area_id | 座標 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `osm:node:10004204545` | `SHELTER` | 未提供 | `tw.10010030` | `120.1693569, 23.3834358` |
| 2 | `osm:node:10004204546` | `SHELTER` | 未提供 | `tw.10010030` | `120.1693535, 23.3830917` |
| 3 | `osm:node:10007988857` | `CLINIC` | 安康診所 | `tw.10005070` | `120.8301567, 24.3074542` |
| 4 | `osm:node:10017475252` | `SHELTER` | 未提供 | `tw.10004120` | `121.1812467, 24.6932193` |
| 5 | `osm:node:10028829000` | `CLINIC` | 沛然診所 | `tw.66000280` | `120.6835075, 24.1150849` |

## 7. 歷史快照與目前下載資料的差異

Repository 保留部分舊資料供測試或追查，不代表目前 App 正在顯示它們：

| 資產 | 快照時間 | 筆數 | 實際用途 |
| --- | --- | ---: | --- |
| `flutter/test/fixtures/static-features-legacy.json` | `2026-09-26T03:22:07.959Z` | `7,887`（醫療 `1,980`、避難所 `5,907`） | 測試用歷史 marker fixture；不列入 Web 或 Android 發布資產 |
| `flutter/assets/data/taiwan/ncdr-hazard-events.json` | `2026-09-26` | `203` | 沒有原生 bridge 的開發預覽；不是正式 Server 告警 feed |
| `android/app/src/main/assets/static/taiwan/shelter` | 2026-10-04 移除 | `5,907` | 舊 Android 避難所包已退役，不再隨 APK 發布 |

因此：

- 避難所與醫療院所只從已驗簽的 Server layer 下載，並在 Web OPFS／Android App 私有空間快取；沒有有效下載或快取時不顯示點位。
- 告警使用 Server 簽章 feed；開發預覽 NCDR 快照不代表正式服務的最新告警。

## 8. 對外檢查方式

在專案根目錄執行：

```bash
docker compose --env-file /Users/ray/Desktop/OSS/.env \
  -f /Users/ray/Desktop/OSS/deploy/docker-compose.yml ps

curl -ksS https://localhost/readyz | jq

curl -ksS https://localhost/feed.json | jq \
  '{revision, created_at, expires_at, dataset_count:(.datasets|length), datasets:[.datasets[] | {source_id, dataset_id:.manifest.dataset_id, event_count:.manifest.total_event_count, chunk_count:(.manifest.chunks|length)}]}'

curl -ksS https://localhost/v1/source-status | jq \
  '.sources[] | {source_id,status,retrieved_at,last_success_at,coverage,revision,error_code}'

curl -ksS https://localhost/v1/metadata | jq

curl -ksS https://localhost/v1/layers/taiwan-shelter/manifest.json | jq \
  '{layer_id,dataset_version,total_feature_count,created_at,expires_at}'
```

判讀方式：

- `collector-1` 必須是 running；它負責自動抓資料。
- `/readyz` 顯示 `ready`，代表目前有可驗證的 Feed。
- `feed.json` 的 `revision`、`created_at` 與資料集筆數可確認是否有新發布。
- `source-status` 的 `ok`／`not_modified` 都代表該次收集鏈路正常；`disabled` 是刻意停用。
- 若來源失敗，應保留上一版 Feed，而不是出現 `dataset_count: 0` 的空 Feed。

## 9. 目前結論與後續優先順序

歷史快照中的 NCDR、CWA 天氣特報與避難所狀態曾在 Server 產生資料；目前 collector 保留 NCDR、CWA 與靜態避難所位置，不再更新避難所開設狀態。CWA 地震與颱風來源可呼叫，但歷史快照沒有尚未過期的公開事件。

本次修改後，醫療來源已具備官方座標查詢、唯一匹配、座標範圍驗證、覆蓋率報告與上一版保留機制；仍需在本機執行一次正式 collector，才能把下列歷史數字更新為新結果。其餘後續優先順序是：

1. 將 Android 的 Government Feed URL 指向部署後的 HTTPS Server，並在實機確認 Feed 驗證、Room 寫入與地圖／通知顯示。
2. 執行 `npm run server:health -- --base-url https://localhost`，確認醫療來源的 `matched`／`unresolved` 報告與非零 medical layer。
3. 若專題需要道路事故或 OSM POI，再個別啟用 TDX／OSM；目前不應把停用來源或舊 layer 當成核心災害資料。
4. Web／Android 的 `/v1/layers/...` 下載、驗證與快取程式已加入；仍需有已簽章的新靜態 layer、正式 HTTPS 部署，並完成兩端下載與離線驗收，才算實際同步。

## 門牌索引涵蓋

Web 與 Android 使用相同的 22 縣市簽章 catalog 與縣市門牌包。Web 將下載包驗證後寫入 OPFS；Android 驗簽後保存在 App 私有空間並建立 SQLite 搜尋索引。門牌點可用於地址搜尋和導航到來源提供的位置；它不是道路線形、道路路網或現場測量保證。部分來源頁面明示資料為人工建置或僅供參考，故位置精度仍受來源品質限制。

目前有 18 個縣市以官方開放來源產出 `partial` 地址包。2026-10-05 已用既有 secret-managed Ed25519 金鑰簽署基隆市 11509 門牌資料，更新本機 catalog；catalog 簽章、基隆 manifest 及資料檔雜湊均通過 App 信任金鑰驗證。資料來源是[基隆市政府每月更新的門牌 CSV](https://www.klcg.gov.tw/tw/civil/2209-292163.html)，欄位以縣市／行政區名稱及 TWD97 TM2 座標（EPSG:3826）明確映射。192,319 筆來源列中 192,269 筆通過座標轉換與縣界檢查，50 筆排除（15 筆座標在基隆市界外、35 筆重複門牌），沒有缺座標。原始 CSV SHA-256 為 `f2c1b00e6117209fd5134a2228af1bbbda73878773bee5d4bb3298feabc51526`；建置器計算的輸入檔名加內容 digest 為 `sha256:45e88f06eefd6f67de89501fb63dfd7e4fffa7b844d59d5cdfcef684f59e7a6a`。資料採[基隆市政府資料開放授權](https://www.klcg.gov.tw/tw/klcg1/3259-110276.html)。目前本機 catalog 有 18 個可用簽章包，連江、宜蘭、南投及嘉義市仍標示 `unavailable`；資料尚未部署到正式服務。

所有已發布輸出點座標均為 WGS84 `[longitude, latitude]`。manifest/header 的 `coordinate_system` 記錄來源資料 CRS；實際 record 的 `coordinate` 是 WGS84 經緯度。下表的「來源座標系統」也記錄來源 CRS；轉成 WGS84 並四捨五入後，才檢查輸出點是否仍落在對應縣界。小數點取整使點位越界時會列入排除，不發布該點。

| 縣市 | 官方資料集與來源版本 | 來源座標系統 | 來源列 | 可搜尋點位 | 缺座標 | 排除 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 新竹縣 | [門牌位置](https://data.gov.tw/dataset/172380)，1150305 | EPSG:3826 | 262,762 | 262,725 | 0 | 37 |
| 苗栗縣 | [門牌座標](https://data.gov.tw/dataset/178083)，115-06-30 | EPSG:3826 | 231,467 | 231,421 | 0 | 46 |
| 彰化縣 | [門牌點位](https://data.gov.tw/dataset/170727)，2025-06 | EPSG:3826 | 467,023 | 466,188 | 0 | 835 |
| 雲林縣 | [門牌座標](https://data.gov.tw/dataset/166201)，1140505 | EPSG:3826 | 283,980 | 283,318 | 0 | 662 |
| 嘉義縣 | [門牌位置](https://data.gov.tw/dataset/172873)，1150327 | EPSG:3826 | 198,697 | 198,395 | 0 | 302 |
| 屏東縣 | [全縣門牌檔](https://data.gov.tw/dataset/170847)，1150914 | EPSG:3826 | 335,205 | 335,020 | 0 | 185 |
| 臺東縣 | [門牌坐標](https://data.gov.tw/dataset/165619)，2026-06-04 | EPSG:3826 | 93,671 | 93,200 | 0 | 471 |
| 花蓮縣 | [門牌點位](https://data.gov.tw/dataset/175221)，2026-10-04 取得 | EPSG:3826 | 151,358 | 151,131 | 0 | 227 |
| 澎湖縣 | [門牌位置](https://data.gov.tw/dataset/170852)，2026-09-24 | EPSG:3825 | 40,736 | 40,693 | 0 | 43 |
| 基隆市 | [門牌位置資料](https://www.klcg.gov.tw/tw/civil/2209-292163.html)，11509 | EPSG:3826 | 192,319 | 192,269 | 0 | 50 |
| 新竹市 | [門牌位置](https://data.gov.tw/dataset/157547)，2026-06-23 | EPSG:3826 | 210,396 | 210,349 | 0 | 47 |
| 臺北市 | [門牌位置數值資料](https://data.gov.tw/dataset/155472)，2026-10-02 | EPSG:3826 | 1,157,763 | 1,156,804 | 0 | 959 |
| 高雄市 | [門牌坐標](https://data.gov.tw/dataset/177859)，115-06 | EPSG:3826 | 1,284,120 | 1,283,988 | 0 | 132 |
| 新北市 | [門牌位置數值資料](https://data.gov.tw/dataset/168887)，11509 | EPSG:3826 | 1,989,458 | 1,989,011 | 153 | 294 |
| 臺中市 | [GIS 門牌號碼](https://data.gov.tw/dataset/177460)，115-08 | EPSG:4326 | 1,334,719 | 1,334,396 | 0 | 323 |
| 臺南市 | [門牌資料](https://data.gov.tw/dataset/120044)，114 | EPSG:3826 | 847,103 | 847,053 | 0 | 50 |
| 桃園市 | [門牌座標](https://data.gov.tw/dataset/157689)，115-08 | EPSG:3826 | 1,108,174 | 1,108,038 | 0 | 136 |
| 金門縣 | [門牌資料](https://data.gov.tw/dataset/171571)，2024-12 | EPSG:3825 | 32,005 | 31,993 | 0 | 12 |
| **18 個來源合計** |  |  | **10,220,956** | **10,215,992** | **153** | **4,811** |

`deploy/public/address-packs/catalog.json`、22 縣市 coverage 報告、17 份 manifest 與 17 包壓縮 NDJSON 已產生於本機。它們由 App 信任的 `central-server-2026` 簽署。全量檢查通過：catalog 與 manifest 簽章、每包壓縮檔大小及 SHA-256；並逐筆驗證 10,023,723 筆輸出點的經緯度順序、縣界、地址縣市前綴、搜尋鍵及記錄 ID。總計與 `coverage.json` 相符。尚未部署到正式 HTTPS 網域，因此目前 App 尚不能透過正式服務下載這批地址包。

建置命令（輸入檔須先從各官方資料集取得）：

```bash
ADDRESS_SOURCE_DIR=/secure/official-address-files \
SIGNING_PRIVATE_KEY_PATH=/secure/central-server-private.pem \
SIGNING_KEY_ID=central-server-2026 \
npm run build:address-packs
```

名錄只接受同縣市唯一的正規化完整地址；比對不唯一或地址不吻合時維持未定位。沒有門牌來源的縣市仍可使用道路搜尋，但不會以道路代表點冒充精確門牌位置。
