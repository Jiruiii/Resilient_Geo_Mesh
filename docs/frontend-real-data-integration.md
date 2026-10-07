# 全台真實資料提供與 Flutter Demo 整合指南

> **更新 2026-10-05：**本文件下方「Flutter Demo JSON asset 匯出」是舊的預覽／一次性流程，不是目前 Web／Android 的靜態資料下載路徑。底圖目前使用隨 App 提供的 OSM／Protomaps PMTiles；相機範圍與歷史 NLSC 試用見 [Map_description.md](../Map_description.md)。簽章 layer、告警 TTL、門牌涵蓋及資料狀態見[資料說明](../data_description.md)與[點位涵蓋報告](data-coverage-2026-10-04.md)。Web／Android client 程式已加入，但新 Server 網域尚未部署驗證。

本文件後半保留舊版 Flutter Demo JSON 匯出流程，作為歷史操作參考；現行 Web／Android 的資料契約與運作狀態以本頁更新說明及[資料說明](../data_description.md)為準。

## 先看結論

現行流程由 `pipeline/` 收集官方來源，Server 發布簽章告警 feed 與靜態圖層，Web／Android client 驗證並保存本機副本。程式與部署範本已在 repository；正式 Server 網域尚未部署驗證，因此目前不能說兩端已取得最新發布資料。

舊版 Demo JSON asset 已不再作為 Web 驗證失敗時的醫療／避難所點位替代來源。NCDR、CWA、TDX 的 API key 與 client secret 只能放在 pipeline 伺服器，不能放進 Flutter Web、Android asset、Raw snapshot 或瀏覽器 JavaScript。

中央 Server 的資料流是：官方來源 → 單一排程 collector → private raw/normalized cache → signed government feed 或 static layer → read-only Fastify API。API request 只讀已發布內容，不會觸發官方 API。Web／Android client 程式已加入，但仍須部署正式 HTTPS 網域並做兩端下載驗收。

目前 Server 的預設範圍是：NCDR 全台災害事件（公開 feed 排除 `BACKGROUND`）、CWA 地震／天氣特報／颱風，以及獨立的靜態避難所位置與醫療資源。App 的官方動態告警只保留 NCDR；CWA、TDX 與舊避難所狀態 feed 不會進入 Web／Android 的事件快取、地圖或通知。OSM／Protomaps 底圖隨 App 內附，不由資料 Server 提供；避難所位置與醫療資源走簽章 layer。避難所開設狀態 XML 不在目前收集範圍。TDX 與 OSM POI adapter 保留但不在預設排程。Web 與 Android 都已接入簽章 layer、告警 feed 與門牌包資料路徑；正式網域及兩端外部下載驗收仍待完成。

## Web 與 Android 同步開發規則

會影響地圖、搜尋、離線資料、簽章資料或告警行為的功能，Web 與 Android 必須在同一批變更中完成。共用資料契約或來源改動時，要同時更新兩端的讀取、驗證、錯誤處理與測試；不可只因其中一端已可用就標記功能完成。若平台能力確實不同，須在文件列明差異、使用者可見行為及尚未支援的平台，不能宣稱兩端功能一致。

每批跨平台變更至少要核對以下項目，再更新本文件及相關模組文件。`.github/workflows/platform-parity.yml` 會在每個 Pull Request 執行 Node／Server、Flutter Web 與 Android 工作，並彙整成 `platform-parity` 狀態檢查；Android 工作會在 API 36 模擬器跑 instrumentation。GitHub `main` 目前已有 `Protect Main Branch` ruleset，要求透過 Pull Request，但尚未要求 CI 狀態。先將 workflow 合併到預設分支並讓它成功執行；若既有 PR 尚未產生此狀態檢查，先更新或重開該 PR 觸發檢查，再把 `platform-parity` 加進 ruleset 的 required status checks。在那之前，workflow 會執行檢查，但 GitHub 尚不會用它阻擋合併。Azure 部署仍由獨立的手動 workflow 觸發。

- `npm test` 與 `npm run test:server`（資料契約或 Server 有變更時）。
- `flutter analyze --no-pub`、`flutter test --no-pub` 及 `flutter build web --release --no-web-resources-cdn --no-pub`。
- `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest`，再於 API 36 模擬器執行 `:app:connectedDebugAndroidTest`。
- Web 與 Android 對相同資料版本的驗簽、離線保存、更新失敗處理及過期／撤銷行為；裝置或瀏覽器實測狀態要與單元測試分開記錄。

上述條件未全部通過時，該批功能維持「部分完成」或「待驗收」。

## 舊版 Flutter Demo asset 流程（2026-09-27 歷史記錄）

以下資料流圖、asset 清單與匯出步驟記錄舊版 Demo，不能當作現行 Web／Android 更新路徑；現行路徑見上方摘要與[資料說明](../data_description.md)。

```text
官方資料來源
  │  NCDR / CWA / TDX / 避難所 / 醫療 / OSM
  ▼
pipeline/cli.mjs collect
  │
  ├─ Raw snapshot                 內部稽核，不直接公開
  ├─ 正規化 event / feature       統一資料格式
  ├─ collection-metadata.json     成功、部分成功或認證失敗狀態
  └─ 簽章 bundle                  Android 驗證使用
        │
        ├─ export-map
        │    └─ flutter/assets/data/taiwan/static-features.json
        │
        └─ export-flutter-ncdr-demo
             └─ flutter/assets/data/taiwan/ncdr-hazard-events.json
                                      │
                                      ▼
                         Flutter Web Demo / Chrome
```

當時 Flutter Demo 使用的兩個資料檔如下：

| 檔案 | schema | 內容 | 現況 |
|---|---|---|---|
| `flutter/assets/data/taiwan/static-features.json` | `offline-map-display-v1` | 舊版全台避難所、醫療機構及其他地圖地物投影 | Legacy preview 資產；不作為現行點位、搜尋或驗證失敗時的 fallback |
| `flutter/assets/data/taiwan/ncdr-hazard-events.json` | `event-batch-v0` | 舊版 NCDR 正規化事件 | Legacy Chrome Demo 資產；現行告警使用簽章 feed |

Android host 以 native bridge 驗證並快取的資料為準；Web 使用同源 API 與 OPFS 驗證／快取。API 或簽章資料不可用且沒有有效快取時，保留底圖並顯示點位資料不可用，不讀取舊預覽快照作為已核實點位。

### Android 路線與搜尋進度（2026-09-27 歷史記錄）

截至 2026-09-27，Android native bridge 不可用時曾保留 Flutter preview fallback；2026-10-04 已改為沒有有效簽章點位資料時不顯示舊 preview。全台設施、全台道路搜尋和可規劃路線的範圍不同：目前路線引擎使用獨立打包的雙北 OSM 預建圖，沒有線上路線 API，也不因分享 Web Demo 而變成全台路線服務。

Pixel 8a 已完成路線、背景搜尋、街道標記與底圖重用實測；一般搜尋運算 p95 約 31.7 ms，另有 180 ms 輸入 debounce，冷啟動道路索引約 6.8 秒。簽章驗證、事件有效期限與 snapshot 資料的界線不變。詳見 [目前進度](mvp-remaining-tasks.md) 與 [雙北效能紀錄](taipei-offline-routing.md)。

## 1. 準備環境與秘密設定

在 repository 根目錄執行：

```bash
cd /Users/ray/Desktop/OSS
if [ ! -f pipeline/.env ]; then cp pipeline/.env.example pipeline/.env; fi
```

`pipeline/.env` 只放在本機或伺服器，不能 commit：

```dotenv
# NCDR：已有 key 時填入
NCDR_ALERT_API_KEY=
NCDR_ALERT_ENDPOINT=https://alerts.ncdr.nat.gov.tw/api/datastore
NCDR_ALERT_DETAIL_ENDPOINT=https://alerts.ncdr.nat.gov.tw/api/dump/datastore
NCDR_AUTH_MODE=query

# CWA：若要收集 CWA 資料才需要
CWA_API_KEY=

# TDX：若要收集道路事件才需要
TDX_CLIENT_ID=
TDX_CLIENT_SECRET=
TDX_API_ENDPOINTS=
TDX_EVENT_FRESHNESS_SECONDS=900
TDX_ENDPOINT_DELAY_MS=1000

# 全台行政區索引
DATA_SCOPE=taiwan
TAIWAN_BOUNDARY_PATH=/Users/ray/Desktop/OSS/data/area-catalog.json
```

需要注意：

- `TDX_API_ENDPOINTS=` 留白代表使用 pipeline 內建的全台縣市端點清單；不是代表停用全台收集。
- 目前 TDX 道路事件 City API 回應接受的內建代碼為 `Taipei`、`NewTaipei`、`Taoyuan`、`Taichung`、`Tainan`、`Kaohsiung`、`Keelung`、`MiaoliCounty`、`ChiayiCounty`、`PingtungCounty`、`YilanCounty`、`KinmenCounty`；這是來源端目前提供的涵蓋範圍，不應自行補上 API 回傳 400 的縣市代碼。
- `TDX_ENDPOINT_DELAY_MS=1000` 會在 sequential endpoint request 之間加入 1 秒間隔；若 TDX 回傳 `Retry-After`，collector 會依該值退避後再重試。
- `NCDR_DETAIL_CONCURRENCY=1` 可以降低一次取得大量 CAP 詳細內容時觸發限制的機率。
- 正式服務應使用 secret manager 或伺服器環境變數，不要把 `.env` 上傳給前端或放入 Docker image 的公開層。

## 2. 建立全台行政區索引

先把官方縣市界線與鄉鎮市區界線轉成 EPSG:4326 GeoJSON，再建立 `AreaCatalog`：

`data/area-catalog.json` 是由界線資料產生的本機衍生檔，已加入 `.gitignore`，不應提交到 Git。每位開發者第一次使用全台 pipeline 時，都要在自己的環境執行下面指令產生；只要 `data/boundaries/geojson/` 的兩個輸入檔存在，就不需要從其他人複製這個 137 MB 的檔案。

```bash
node pipeline/cli.mjs area-catalog \
  --input data/boundaries/geojson/county.geojson,data/boundaries/geojson/town.geojson \
  --out data/area-catalog.json
```

若檔名或路徑不同，替換 `--input` 的兩個檔案即可。確認輸出：

```bash
node -e '
const fs = require("node:fs");
const x = JSON.parse(fs.readFileSync("data/area-catalog.json", "utf8"));
console.log({ schema: x.schema_version, coverage: x.coverage, area_count: x.area_count });
'
```

預期 `coverage` 為 `TW`，且 `area_count` 大於 0。

確認 Git 沒有追蹤這個衍生檔：

```bash
git check-ignore -v data/area-catalog.json
```

應該會顯示 `.gitignore` 中的 `/data/area-catalog.json` 規則。不要執行 `git add data/area-catalog.json`；需要提交的是界線來源或產生指令，不是產生後的完整 catalog。

## 3. 收集全台真實資料

建立一次資料快照目錄：

```bash
BOUNDARY="$PWD/data/area-catalog.json"
RUN_ROOT="$PWD/data/live/taiwan/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_ROOT"
```

### 3.1 NCDR 即時示警

這是目前 Flutter Web Demo 會使用的動態資料來源：

```bash
NCDR_DETAIL_CONCURRENCY=1 \
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source ncdr-hazard-events \
  --out-dir "$RUN_ROOT/ncdr-hazard-events"
```

成功時會產生：

```text
$RUN_ROOT/ncdr-hazard-events/ncdr-hazard-events.raw.json
$RUN_ROOT/ncdr-hazard-events/ncdr-hazard-events.events.json
$RUN_ROOT/ncdr-hazard-events/collection-metadata.json
```

發布前先確認來源狀態：

```bash
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const x = JSON.parse(fs.readFileSync(`${p}/collection-metadata.json`, "utf8"));
console.log({ source_id: x.source_id, source_status: x.source_status, retrieved_at: x.retrieved_at });
if (x.source_status !== "ok") process.exit(2);
' "$RUN_ROOT/ncdr-hazard-events"
```

`blocked_by_auth`、`partial` 或 `stale` 不應該被當成完整動態災害資料發布。`partial` 可以留作內部診斷，但對外應明確標示資料不完整；醫療 static layer 例外地允許以非零 matched features 發布，並且必須同時保留 matched／unresolved 報告。

### 3.2 避難所與醫療機構

目前只收集靜態避難所位置與預計容量，不收集更新不定期的開設狀態。醫療院所的主檔由 MOHW 提供，座標由中央 Server 透過官方國土測繪中心查詢與已審核的官方衛生局補充來源取得；不使用 OSM 座標補醫療資料：

```bash
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source taiwan-shelter \
  --out-dir "$RUN_ROOT/taiwan-shelter"

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source taiwan-medical \
  --out-dir "$RUN_ROOT/taiwan-medical"
```

Server 會依台灣範圍建立可重現的 NLSC 半徑查詢網格，依機構代碼優先、名稱＋地址其次進行唯一匹配。官方座標服務失敗、回傳空結果或無法唯一匹配時，保留上一版 medical layer 或 `unresolved_medical`，不可把缺口猜成座標。一次性 `normalize` 若要使用 `--coordinate-input`，輸入也必須是經審核的官方座標 snapshot；目前不應使用停用的 OSM layer 取代官方座標來源。

### 3.3 CWA 與 TDX（目前 pipeline 可收集，尚未直接接入 Chrome Demo）

```bash
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source cwa-earthquake \
  --out-dir "$RUN_ROOT/cwa-earthquake"

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source cwa-weather-warning \
  --out-dir "$RUN_ROOT/cwa-warning"

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source cwa-typhoon-warning \
  --out-dir "$RUN_ROOT/cwa-typhoon"

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan \
  --boundary "$BOUNDARY" \
  --source tdx-road-events \
  --out-dir "$RUN_ROOT/tdx-road-events"
```

TDX 全台端點可能因帳戶配額或服務限流回傳 `429`。請查看 `collection-metadata.json` 的 `source_status` 與 Raw snapshot 的端點結果；不要只看總 `event_count` 就宣稱全台成功。

## 4. 匯出 Flutter Demo 資料

### 4.1 匯出全台地圖地物

`export-map` 會移除 pipeline 內部欄位，只輸出前端需要的地圖欄位：

```bash
node pipeline/cli.mjs export-map \
  --input "$RUN_ROOT/taiwan-shelter/taiwan-shelter.features.json,$RUN_ROOT/taiwan-medical/taiwan-medical.features.json,$RUN_ROOT/osm-taiwan/osm-taiwan.features.json" \
  --out flutter/assets/data/taiwan/static-features.json \
  --dataset-id resilientgeo-taiwan \
  --coverage TW
```

輸出格式為：

```json
{
  "schema_version": "offline-map-display-v1",
  "dataset_id": "resilientgeo-taiwan",
  "coverage": "TW",
  "snapshot_at": "...",
  "bounds": [121.0, 21.0, 122.5, 25.5],
  "features": [
    {
      "id": "...",
      "kind": "shelter|medical|poi",
      "geometry": { "type": "Point", "coordinates": [121.5, 25.0] },
      "name": "...",
      "address": "..."
    }
  ]
}
```

### 4.2 匯出 NCDR Demo 示警

這個步驟會把正規化事件投影成 Flutter Demo 可以讀取的代表點，並保留 `operational_relevance` 與 `map_visible`：

```bash
node pipeline/tools/export-flutter-ncdr-demo.mjs \
  --input "$RUN_ROOT/ncdr-hazard-events/ncdr-hazard-events.events.json" \
  --metadata "$RUN_ROOT/ncdr-hazard-events/collection-metadata.json" \
  --out flutter/assets/data/taiwan/ncdr-hazard-events.json
```

NCDR 示警在 Demo 中會依下列條件處理：

- 過期事件不顯示在地圖上。
- `EVACUATION`、`ROUTE_CHANGE`、`HIGH_IMPACT` 類型才是地圖主要操作資訊。
- `BACKGROUND` 類型會保留在資料中，但不直接顯示成地圖 marker。
- 缺少可靠分類時採 fail-closed，不把一般行政通知誤當成緊急事件。

這個匯出檔不是官方 Raw snapshot，也不是 Android 的簽章 bundle；它是給 Flutter Web Demo 使用的顯示投影。

## 5. 在 Flutter Demo 顯示

兩個檔案已在 `flutter/pubspec.yaml` 註冊：

```yaml
assets:
  - assets/data/taiwan/static-features.json
  - assets/data/taiwan/ncdr-hazard-events.json
```

更新檔案後重新啟動 Flutter：

```bash
cd /Users/ray/Desktop/OSS/flutter
/Users/ray/Development/flutter/bin/flutter pub get
/Users/ray/Development/flutter/bin/flutter run -d chrome \
  --no-web-resources-cdn \
  --web-port 8787
```

如果之前已經開著 Demo，建議完整停止後重新執行，不要只依賴 hot restart，避免瀏覽器仍使用舊的 asset bundle。

## 6. 讓其他人透過 HTTP 取得 Demo 資料

### 6.1 本機或同網路 Demo 分享

先建立 release Web build：

```bash
cd /Users/ray/Desktop/OSS/flutter
/Users/ray/Development/flutter/bin/flutter build web --release \
  --no-web-resources-cdn
```

再以靜態 HTTP server 提供：

```bash
python3 -m http.server 8788 \
  --bind 0.0.0.0 \
  --directory build/web
```

瀏覽器 Demo：

```text
http://<這台電腦的 IP>:8788
```

其他程式可以讀取 Flutter build 內的 asset：

```bash
curl -fsS \
  http://127.0.0.1:8788/assets/assets/data/taiwan/static-features.json \
  | jq '{schema_version, dataset_id, coverage, feature_count: (.features | length)}'

curl -fsS \
  http://127.0.0.1:8788/assets/assets/data/taiwan/ncdr-hazard-events.json \
  | jq '{schema_version, source_id, source_status, event_count: (.events | length)}'
```

Flutter asset 的 URL 會是 `/assets/assets/...`，因為 Flutter asset 在 Web build 中還有一層 `assets/` 根目錄。這是目前 Demo 可用的分享方式；它不是長期穩定的公開 API contract。

### 6.2 其他前端呼叫範例

```javascript
const baseUrl = 'https://demo.example.com/assets/assets/data/taiwan';

const [featureResponse, eventResponse] = await Promise.all([
  fetch(`${baseUrl}/static-features.json`),
  fetch(`${baseUrl}/ncdr-hazard-events.json`),
]);

if (!featureResponse.ok || !eventResponse.ok) {
  throw new Error('Taiwan demo data is unavailable');
}

const featureBatch = await featureResponse.json();
const eventBatch = await eventResponse.json();
const now = Date.now();

const currentEvents = eventBatch.events.filter((event) => {
  const expiresAt = event.expires_at ? Date.parse(event.expires_at) : Infinity;
  return expiresAt > now && event.attributes?.map_visible !== false;
});

const shelters = featureBatch.features.filter(
  (feature) => feature.kind === 'shelter',
);
const medicalFacilities = featureBatch.features.filter(
  (feature) => feature.kind === 'medical',
);

console.log({ currentEvents, shelters, medicalFacilities });
```

公開 Demo 建議至少啟用 HTTPS、gzip／Brotli、`ETag` 與適當的 `Cache-Control`。資料檔不應包含 API key、client secret、私鑰或完整未審查的 Raw source record。

## 7. 正式 API 的建議介面

如果需求是讓其他系統長期以穩定 URL 取得資料，建議新增一個後端資料服務或 object storage 靜態發布層。它應該發布 pipeline 已驗證的輸出，而不是讓瀏覽器直接呼叫官方資料源。

建議介面：

| Method | URL | 回應 |
|---|---|---|
| `GET` | `/v1/taiwan/map-features` | `offline-map-display-v1`，全台避難所與醫療等地物 |
| `GET` | `/v1/taiwan/events?source=ncdr&status=current` | `event-batch-v0` 或事件陣列 |
| `GET` | `/v1/taiwan/metadata` | snapshot 時間、來源狀態、資料版本、coverage |
| `GET` | `/v1/taiwan/manifest` | Android 使用的簽章 manifest，不包含私鑰 |

正式服務必須做到：

1. pipeline 先確認 `source_status`，再發布 snapshot。
2. API 回傳 `coverage=TW`、`retrieved_at`、資料版本與來源狀態。
3. `blocked_by_auth`、`partial`、`stale` 要讓呼叫端看得到，不能靜默轉成成功。
4. 動態事件依 `expires_at` 或 Android 的 `apply_state` 過濾，不能把過期事件標成目前事件。
5. Raw snapshot 與認證 header 不直接公開。
6. 後端保存 private signing key；App 和第三方只需要 public key 或已簽章資料。
7. 加上 HTTPS、CORS allowlist、ETag、Cache-Control、速率限制與健康檢查。

目前 Flutter Web 仍是 asset loader，因此若正式 API 上線，還需要新增一個可注入的 remote loader，例如：

```dart
typedef RemoteJsonLoader = Future<String> Function(Uri uri);
```

Web 可以使用 remote loader；Android 仍應以已驗證的 Room／bridge 為權威資料來源。不要讓 Android 或 Web client 直接攜帶 NCDR、CWA、TDX 的認證資訊。

## 8. 發布前檢查清單

- [ ] `area-catalog.json` 的 `coverage` 是 `TW`。
- [ ] `data/area-catalog.json` 只存在於本機，不被 Git 追蹤；每位開發者已自行執行 `area-catalog` 指令產生。
- [ ] NCDR `collection-metadata.json` 是 `source_status=ok`。
- [ ] TDX 若宣稱全台成功，所有內建端點都沒有 `429` 或其他失敗。
- [ ] static features 中沒有只屬於 Neihu 的過濾邏輯。
- [ ] `static-features.json` 至少包含 `shelter` 與 `medical` kind。
- [ ] NCDR Demo asset 的 `source_id` 是 `ncdr-hazard-events`。
- [ ] 瀏覽器能取得 `/assets/assets/data/taiwan/*.json`，沒有 404。
- [ ] Flutter 地圖能顯示台北、花蓮、高雄等不同區域資料。
- [ ] 沒有 API key、client secret、private key 出現在 `flutter/assets`、`build/web`、Raw、log 或 git diff。
- [ ] 對外文件清楚標示資料的 `retrieved_at`，讓使用者知道它不是每次畫面開啟都即時查詢官方 API。

## 9. 常見錯誤

### `404 assets/assets/data/taiwan/static-features.json`

通常是以下其中一項：

- 沒有從 `flutter/` 目錄執行 Flutter 指令。
- 新檔案沒有加入 `flutter/pubspec.yaml` 的 `assets`。
- 修改 asset 後只做 hot restart，沒有完整重新 build。
- HTTP server 的根目錄不是 `flutter/build/web`。

### Demo 有地圖但沒有全台醫療或避難所

檢查 `static-features.json` 的 `features` 是否包含 `kind=shelter` 與 `kind=medical`，以及 `export-map --input` 是否真的包含對應的兩個 normalized feature files。

### NCDR 有資料但地圖只出現少數事件

這是預期行為：Flutter Demo 只顯示未過期且 `map_visible=true` 的 NCDR 事件；一般行政通知、消防檢查等 `BACKGROUND` 資料仍可能保留在 JSON，但不會畫成逃生／改道路線用 marker。

### TDX 收集結果是 `partial`

這通常表示某些縣市端點回傳 `429` 限流或 `400` 不接受的 City 代碼。查看 Raw snapshot 的 `payload.sources`：`429` 會依 `Retry-After` 重試並保留成功端點資料；`400` 則應修正 endpoint 清單，不應靠新增 API key 解決。在未確認所有來源端點成功前，不要宣稱取得完整全台道路事件。
