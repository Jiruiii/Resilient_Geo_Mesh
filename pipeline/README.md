# Stage 2 trusted data pipeline

This directory implements the `system.md` phase-2 path with only Node.js built-ins.

## 第一階段：全台灣真實資料接入

目前的預設 scope 仍是 `neihu`，用來保留既有 fixture/replay 測試；真實資料收集請明確使用 `--scope taiwan`。正式流程是：官方來源 → Raw snapshot → AreaCatalog 空間歸屬 → 正規化事件／靜態 feature → Ed25519 簽章 feed/layer → 唯讀 API → Web／Android 驗證、快取及顯示。前端不直接呼叫上游資料 API；Server 部署網址仍需設定與外部驗證。門牌搜尋已接上 Web／Android；18 個縣市包由 `central-server-2026` 簽章並放入 `deploy/public/address-packs/`，但尚未部署到正式 HTTPS 服務。基隆市政府 11509 CSV 的 192,319 筆來源列已完成轉換與縣界檢查，192,269 點通過、50 筆排除；本機 catalog 已更新並驗證。連江、宜蘭、南投、嘉義市仍無可確認的完整公開來源，catalog 將這四縣市標為 `unavailable`；門牌列數不等於醫療院所定位數。

2026-10-04 同一輪 collector 的涵蓋核對：避難所來源 5,973 筆，5,727 通過行政區／地址檢查、180 未定位、66 排除；醫療主檔 24,138 筆，479 配到已核實座標、23,659 未定位、0 排除。兩者皆逐縣市列出 22 縣市／離島數量，報告見[全台點位涵蓋](../docs/data-coverage-2026-10-04.md)。本輪 source-status 記錄在本機 release；本機唯讀 API 曾於 loopback 提供狀態和簽章 layer/feed，Web 與 Android API 36 模擬器都下載並驗簽同一批產物。測試服務不是正式部署；正式 Server 尚未部署。

官方 7442／7441 下載檔是 TWD97 經緯度的 SHP／GML 資料；先以 GDAL／QGIS 轉成 EPSG:4326 GeoJSON，再交給 `area-catalog`。例如：

```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 /tmp/county.geojson /tmp/COUNTY_MOI_1140318_.gml
ogr2ogr -f GeoJSON -t_srs EPSG:4326 /tmp/town.geojson /tmp/TOWN_MOI_1140318.shp
```

檔名依資料發布版本調整；若環境沒有 GDAL，可用 QGIS 執行相同的「另存為 GeoJSON／EPSG:4326」。

| 資料 | 官方來源／程式 source id | 認證 | 輸出與注意事項 |
|---|---|---|---|
| 縣市、鄉鎮市區界線 | [data.gov.tw 7442](https://data.gov.tw/dataset/7442)、[7441](https://data.gov.tw/dataset/7441)／`area-catalog` | 不需要 | 下載後轉成 EPSG:4326 GeoJSON，再合併產生 `area-catalog-v0`；每筆資料可得到 `county_code`、`town_code`、`area_id`。 |
| NCDR 示警 | [NCDR Swagger](https://alerts.ncdr.nat.gov.tw/api_swagger/index.html)／`ncdr-hazard-events` | `NCDR_ALERT_API_KEY` | Server 全台採兩階段：`/api/datastore` 取得 `capid` 索引，再對每筆呼叫 `/api/dump/datastore` 取得完整 CAP；完整資料留在 private cache，公開 government feed 排除 `BACKGROUND`。 |
| CWA 地震、縣市警報、颱風 | `E-A0015-001`、`W-C0033-001`、`W-C0034-001`／`cwa-earthquake`、`cwa-weather-warning`、`cwa-typhoon-warning` | `CWA_API_KEY` | `Authorization` 僅在 collector request 使用，Raw 不保存。 |
| TDX 道路事件 | [TDX Swagger](https://tdx.transportdata.tw/api-service/swagger)／`tdx-road-events` | `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` | OAuth2 client credentials；保留 adapter 供手動收集，但目前不在 Central Server 預設排程，也不進核心災害 feed。 |
| 避難所位置 | [data.gov.tw 73242](https://data.gov.tw/dataset/73242)／`taiwan-shelter` | 不需要 | CSV 靜態 layer；沒有 Neihu filter。全台模式要求 AreaCatalog，核對來源縣市／鄉鎮、地址及點位界線；2026-10-04 單次來源 5,973 筆，5,727 已定位、180 未定位、66 排除。未通過檢查的座標不進地圖 layer；本機暫存 bundle 已簽章驗證，但尚未部署正式服務。 |
| 醫療機構主檔 | [data.gov.tw 15393](https://data.gov.tw/dataset/15393)／`taiwan-medical` | 不需要 | 目前官方資源是 ODS，pipeline 會解析 `content.xml`；主檔沒有座標，未定位資料保留在 `unresolved_medical`。 |
| 醫療座標補足 | [NLSC 139250](https://data.gov.tw/dataset/139250)／`nlsc-medical-coordinates` | 不需要 | 以台灣範圍半徑查詢與已審核官方 fallback 合併；院所配對檢查機構代碼、地址與縣市。2026-10-04 368 次查詢成功找到 3,686 個候選點；主檔 24,138 筆中 305 筆由 NLSC 定位，現有簽章門牌來源另配到 174 筆（10007 有 169 筆、65000 有 5 筆），合計 479 已定位、23,659 未定位。 |
| 門牌搜尋包 | [逐縣市來源與數字](../data_description.md#門牌索引涵蓋) | 不需要 | 18 個已簽章包共 10,220,956 筆來源列，10,215,992 筆通過座標與縣界檢查，153 筆缺座標，4,811 筆排除。基隆市 11509 CSV 已由 `central-server-2026` 簽章加入 catalog；目前四縣市標示 unavailable。資料位於 `deploy/public/address-packs/`，尚未部署正式服務。這些數字是門牌來源筆數，不是醫療院所定位數。 |
| OSM POI | [Overpass API](https://overpass-api.de/api/interpreter)／`osm-taiwan` | 不需要 | 保留 adapter 但 Central Server 預設 disabled；不作為醫療座標來源。地圖底圖使用隨 App 提供的 OSM／Protomaps PMTiles；道路名稱搜尋仍是獨立的 OSM 本機索引。 |

### API key 與簽章設定

```dotenv
NCDR_ALERT_API_KEY=               # 已有的 NCDR key
NCDR_ALERT_ENDPOINT=https://alerts.ncdr.nat.gov.tw/api/datastore
NCDR_ALERT_DETAIL_ENDPOINT=https://alerts.ncdr.nat.gov.tw/api/dump/datastore
NCDR_AUTH_MODE=query
NCDR_DETAIL_CONCURRENCY=4
CWA_API_KEY=                      # 另向中央氣象署申請
TDX_CLIENT_ID=                    # 另向 TDX 申請
TDX_CLIENT_SECRET=                # 另向 TDX 申請
TDX_API_ENDPOINTS=                # 可選；逗號分隔的全台端點
PIPELINE_SIGNING_PRIVATE_KEY=     # pipeline 伺服器私鑰的本機路徑
```

OSM、行政區、避難所、醫療主檔與 NLSC 座標資料不需要 API key。真實值只能放在 gitignored 的 `pipeline/.env` 或伺服器 secret store，不能放在 Flutter、Android assets、Raw snapshot 或 log。`CWA_API_KEY`、TDX credentials 與 NCDR key 都不會被寫入 Raw request metadata；App 只放簽章 public key。

簽章金鑰第一次建立在 pipeline 端：

```bash
node pipeline/cli.mjs keygen --out-dir /secure/resilientgeo-keys --key-id taiwan-static-2026
```

`key-metadata.json` 的 `public_key_spki_base64` 才是 Android `trust/trusted-keys.json` 使用的值；只把這個 public value 以相同 `key_id` 加入 App，`private-key.pem` 不得進 repo、Android 或 Flutter。

### 全台收集順序

先從兩個行政區資料集取得已轉為 EPSG:4326 的 GeoJSON，產生 AreaCatalog：

```bash
node pipeline/cli.mjs area-catalog \
  --input /path/to/county.geojson,/path/to/town.geojson \
  --out data/area-catalog.json
```

再執行動態來源與靜態來源。以下指令只會寫入指定的 `data/live` 快照目錄；若認證失敗，會寫 `collection-metadata.json` 並以非零狀態結束，不會用 fixture 冒充成功：

```bash
BOUNDARY=data/area-catalog.json
LIVE=data/live/taiwan/$(date +%Y%m%d)

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source cwa-earthquake --out-dir "$LIVE/cwa-earthquake"
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source cwa-weather-warning --out-dir "$LIVE/cwa-warning"
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source cwa-typhoon-warning --out-dir "$LIVE/cwa-typhoon"
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source ncdr-hazard-events --out-dir "$LIVE/ncdr"

node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source taiwan-shelter --out-dir "$LIVE/shelter"
node --env-file=pipeline/.env pipeline/cli.mjs collect \
  --scope taiwan --boundary "$BOUNDARY" \
  --source taiwan-medical --out-dir "$LIVE/medical"
```

Server collector 收集 `taiwan-medical` 時會先讀 MOHW 主檔，再用 NLSC `COM_010` 建立可重現的半徑查詢網格；可透過 `MEDICAL_COORDINATE_FALLBACK_ENDPOINTS` 加入已審核的官方衛生局座標來源，也會在目前 17 個已簽章門牌包的縣市以唯一、正規化後的完整地址與同縣市門牌點位精確配對。基隆官方 CSV 已完成實檔試跑但尚未簽章加入客戶端 catalog。一次性 `normalize` 若使用 `--coordinate-input`，輸入也必須是官方座標 snapshot；不可使用 OSM 代替。若某些醫療資料仍無法唯一匹配，會保留在 `unresolved_medical`，不會被估算成座標。地址來源有不完整或人工建置等精度限制，配對結果仍須符合機構代碼、完整地址與縣界檢查。

TDX 與 OSM 不是上述中央 Server 的預設收集步驟。它們的 adapter 與 legacy fixture 仍保留供相容性測試；若日後要 opt-in，必須另行確認端點、quota、全台覆蓋與發布用途，不能把舊快取當成即時資料。

目前 collector 只下載並發布靜態避難所位置、名稱、地址、預計容量與適用災害類別。會不定期更新的開設狀態 XML 不在目前收集範圍；靜態 layer 的容量是規劃容量，不代表即時收容人數或開設狀態。

靜態 layer 需要逐 layer 簽章與驗證，不能把未簽章的 `features.json` 直接交給 App：

```bash
node --env-file=pipeline/.env pipeline/cli.mjs build-layer \
  --input "$LIVE/shelter/taiwan-shelter.features.json" \
  --out-dir "$LIVE/shelter/signed" \
  --key-id taiwan-static-2026
node pipeline/cli.mjs verify-layer \
  --manifest "$LIVE/shelter/signed/manifest.json" \
  --chunks-dir "$LIVE/shelter/signed/chunks" \
  --public-key /path/to/public-key.pem
```

`build-layer` 和 `verify-layer` 仍可供人工檢查 layer bundle。正式 collector 則把 layer 發布到 signed release API；Android `LayerBundleVerifier` 與 Web verifier 會在顯示前驗證 manifest、chunk、feature hash 與 Ed25519 signature，並各自保存離線副本。缺少可信 release 時不得以未核實的醫療座標替代。舊的 `android/app/src/main/assets/static/taiwan/<layer-id>/` 手動放置指令只適用於舊版打包流程；目前 server 發布與同步限制見 [中央 Server 文件](../docs/government-online-sync.md)。

若要產生 Flutter 的 versioned display asset，將已正規化的 feature batches 合併輸出；實際加入 `pubspec.yaml` 前應先完成簽章 layer 與資料審查：

```bash
node pipeline/cli.mjs export-map \
  --input "$LIVE/shelter/taiwan-shelter.features.json,$LIVE/medical/taiwan-medical.features.json,$LIVE/osm/osm-taiwan.features.json" \
  --out flutter/assets/data/taiwan/static-features.json
```

舊版 fixture 與 replay 仍可包含 `SHELTER_STATUS`，供離線相容情境使用；目前 Web／Android App 會忽略 `SHELTER_STATUS / FIRE_AGENCY`，Central Server 也不再收集或發布即時避難所狀態。

認證失敗會標示 `blocked_by_auth`，多端點部分成功標示 `partial`，來源過期快照可標示 `stale`；`null`、`unknown`、`unresolved` 不會被轉成零或關閉。完整 source registry 在 [`sources/catalog.json`](sources/catalog.json)。

以下 Task 3–5 的 Neihu 指令與 fixture 仍保留作為相容性回歸測試；它們不是第一階段全台 production snapshot。

## Task 3: TDX road events（legacy Neihu compatibility）

`pipeline/sources/tdx.mjs` separates the complete TDX response from the curated
Neihu events:

1. `collect` obtains the Taipei City Road Events response with OAuth2 client credentials and writes a secret-free `raw-snapshot-v0`.
2. `normalize` adapts the TDX `Events` envelope into unsigned `event-v0` records, preserves the original source record in `attributes.source_record`, and keeps only records whose town and WGS84 geometry match the official Neihu boundary.
3. `build` signs the curated events and creates the existing Manifest v0 and Chunk v0 bundle.

The Raw snapshot keeps out-of-Neihu events for audit and later re-curation. The
collector does not calculate route cost, congestion indices, or district
statistics. TDX credentials are read only from `TDX_CLIENT_ID` and
`TDX_CLIENT_SECRET`; they are never written to Raw, fixtures, logs, or the
Android bundle.

Live collection:

```bash
# Fill TDX_CLIENT_ID and TDX_CLIENT_SECRET in the local, gitignored pipeline/.env first.
node --env-file=pipeline/.env pipeline/cli.mjs collect --source tdx-road-events --out-dir data/live/tdx/2026-09-04
```

This creates `tdx-road-events.raw.json`, `tdx-road-events.events.json`, and
`collection-metadata.json`. Without both credentials, the command exits with a
clear missing-credential error before making a network request.

Fixture mode does not require credentials:

```bash
node pipeline/cli.mjs normalize \
  --source tdx-road-events \
  --input data/fixtures/neihu/tdx-raw-batch-1.json \
  --out /tmp/tdx-events.json
```

`data/fixtures/neihu/tdx-raw-batch-1.json` is a sanitized response-shaped local
fixture, not a live TDX capture. It is explicitly marked `local_fixture` until
an authenticated response can be recorded.

## Task 4: CWA and NCDR dynamic hazards（全台）

The CWA source adapters cover significant earthquakes (`E-A0015-001`) and
county or city weather warnings (`W-C0033-001`). The NCDR adapter first reads
the official `/api/datastore` index and then retrieves each complete CAP document
from `/api/dump/datastore`; the legacy `NCDR_API_ENDPOINT` name is still accepted.
It converts CAP event categories such as fire, reservoir release, health,
heat, water supply, marine pollution and safety alerts into unsigned `event-v0`
records, preserves the complete source CAP, parses polygon or circle geometry,
and resolves each record against the nationwide `AreaCatalog`.

Live collection:

```bash
BOUNDARY=/absolute/path/to/data/area-catalog.json
node --env-file=pipeline/.env pipeline/cli.mjs collect --scope taiwan --boundary "$BOUNDARY" --source cwa-earthquake --out-dir data/live/taiwan/cwa-earthquake
node --env-file=pipeline/.env pipeline/cli.mjs collect --scope taiwan --boundary "$BOUNDARY" --source cwa-weather-warning --out-dir data/live/taiwan/cwa-warning
node --env-file=pipeline/.env pipeline/cli.mjs collect --scope taiwan --boundary "$BOUNDARY" --source ncdr-hazard-events --out-dir data/live/taiwan/ncdr
```

Set `CWA_API_KEY` for CWA. NCDR uses the two official routes above; the detail
route is derived automatically when `NCDR_ALERT_DETAIL_ENDPOINT` is omitted.
A missing key or unauthorized response writes
`collection-metadata.json` with `source_status=blocked_by_auth` and exits
non-zero. Raw snapshots never contain the CWA query key or NCDR token.

The old Neihu replay data is retained only as a deterministic regression fixture.
When testing the legacy demo without live sources, use it explicitly:

```bash
node --test pipeline/test/neihu-replay.test.mjs
```

The replay entry is `data/fixtures/neihu/manifest.json`; it uses
`data/fixtures/neihu/scenario.json` and `data/fixtures/neihu/update-sequence.json` to
exercise road closure, flood, warning expiry and shelter state transitions.
These are fictional disaster events on real Neihu feature geometry and must be
displayed as simulation data, not current NCDR alerts.

Fixture normalization does not require credentials:

```bash
node pipeline/cli.mjs normalize --source cwa-earthquake \
  --input data/fixtures/neihu/cwa-earthquake-raw.json --out /tmp/cwa-earthquake-events.json
node pipeline/cli.mjs normalize --source cwa-weather-warning \
  --input data/fixtures/neihu/cwa-warning-raw.json --out /tmp/cwa-warning-events.json
node pipeline/cli.mjs normalize --source ncdr-hazard-events \
  --input data/fixtures/neihu/ncdr-hazard-raw.json --out /tmp/ncdr-events.json
```

Expired alerts remain in the cached event batch with `expires_at`; downstream
verification decides whether they are current. The collector does not assign a
risk score.

## Task 5: OSM, shelters and medical static layers（全台）

Task 5 keeps three different products separate:

- OSM roads and selected POIs become `feature-v0` records in `osm-road` and
  `osm-poi` layers.
- Shelter location, address, capacity and supported disaster types remain
  static `feature-v0` properties. Opening status is not collected or generated
  by the current shelter collector; planned capacity is not current occupancy.
- Taipei medical institutions become `feature-v0` records in the `medical`
  layer. The original source row is retained in `properties.source_record`.

Every normalizer preserves the Raw snapshot, filters against the official
WGS84 Neihu boundary, validates `[longitude, latitude]`, and does not calculate
routes, nearest shelters, capacity pressure, coverage, slope or risk scores.

Static source replay:

```bash
node pipeline/cli.mjs normalize --source osm-neihu \
  --input data/fixtures/neihu/osm-raw.json --out /tmp/osm-features.json
node pipeline/cli.mjs normalize --source taipei-shelter \
  --input data/fixtures/neihu/shelter-raw.json --out /tmp/shelter-features.json
node pipeline/cli.mjs normalize --source taipei-medical \
  --input data/fixtures/neihu/medical-raw.json --out /tmp/medical-features.json
```

Live public-source collection writes both `<source>.raw.json` and
`<source>.features.json`:

```bash
node --env-file=pipeline/.env pipeline/cli.mjs collect --source osm-neihu --out-dir data/live/osm/2026-09-04
node --env-file=pipeline/.env pipeline/cli.mjs collect --source taipei-shelter --out-dir data/live/shelter/2026-09-04
node --env-file=pipeline/.env pipeline/cli.mjs collect --source taipei-medical --out-dir data/live/medical/2026-09-04
```

Sign one static layer at a time. The resulting layer package has a separate
`layer-manifest-v0`, `layer-chunk-v0`, `features.json`, and `chunks/` directory;
it does not use the dynamic event `build` command:

```bash
node pipeline/cli.mjs build-layer \
  --input /tmp/shelter-features.json --out-dir .stage5-shelter-bundle \
  --private-key .stage2-keys/private-key.pem --key-id neihu-static-2026
node pipeline/cli.mjs verify-layer \
  --manifest .stage5-shelter-bundle/manifest.json \
  --chunks-dir .stage5-shelter-bundle/chunks \
  --public-key .stage2-keys/public-key.pem
```

`SHELTER_DATA_ENDPOINT`, `MEDICAL_DATA_ENDPOINT` and `OSM_API_ENDPOINT` are
optional public endpoint overrides in `pipeline/.env`. API credentials and private keys
remain local and are never included in Raw snapshots or bundles.

## Task 7: Neihu replay fixture

`data/fixtures/neihu/manifest.json` loads the deterministic replay scenario through
`pipeline/lib/neihu-replay.mjs`. The loader combines the fixed transition
records in `update-sequence.json` with fixed-ID road records until the event
arrival count reaches 100. It never uses random IDs or the current clock.

The replay harness keeps Raw snapshots, event records and static feature
snapshots separate:

- Event identity is `(namespace, event_id)`. A newer `event_version` replaces
  the stored event; an older version is rejected. `crowd.road` is an
  unverified namespace and cannot overwrite `official.tdx`.
- Expired events remain in the cached state projection with `state=expired`.
  Crowd events are marked `unverified` while they are not expired.
- Static features use `(layer_id, feature_id)` plus `snapshot_version`.
  Repeated hospital content is reported as unchanged rather than mixed into
  the event stream.
- Raw records marked outside the Neihu filter remain available for audit; the
  replay harness does not silently discard them.

The fixture uses stable structural signatures for replay tests. Production
event and feature bundles still require the existing Ed25519 verification
path.

Run the replay checks directly:

```bash
node --test pipeline/test/neihu-replay.test.mjs
```

## Crowd reports, attestation and routing assets（2026-09-26）

- `lib/device-key.mjs`、`lib/crowd-report.mjs`：device-signed `crowd.reports` events and their
  one-report-per-chunk envelope; `verifyEvent` accepts a `device:` key only for `crowd.*`
  (see `docs/data-contract-v0.md`「群眾回報簽章」and `docs/peer-sync-v0.md`「群眾回報分片」).
- `node pipeline/cli.mjs attest --report <reports.json> [--event-id <id>] --verdict CONFIRMED|REFUTED
  --private-key <pem> --key-id <official id> [--previous <attestation.json>] [--out <file>]`
  verifies the report's device signature and writes an event batch with one `official.verified`
  ATTESTATION; package it for phones with the normal `build` command.
- `node pipeline/tools/generate-crowd-fixture.mjs` → `fixtures/crowd-reports-v0.json` (and the
  byte-identical Android test copy). Fixed-seed, fixture-only keys.
- `node pipeline/tools/generate-walk-graph.mjs` → `android/app/src/main/assets/routing/walk-roads.json`,
  the walkable Neihu OSM network the Android route engine loads.
- Android downloads signed nationwide shelter and medical layers from the Server, then retains
  verified bundles in app-private storage for offline use. It does not fall back to the legacy APK
  shelter snapshot. The private signing key stays with the trusted release operator; client builds
  contain public trust keys only.
- `lib/geo.mjs` caches each boundary's validated geometry and envelope, so `collect --scope taiwan`
  no longer re-validates the whole 390-area catalog per record (the shelter collection went from
  not finishing in 5 minutes to about 6 seconds).
- `node pipeline/tools/generate-evacuation-scenario.mjs` → `data/fixtures/neihu/evacuation-scenario.json`
  plus two signed demo chunks, adding the `evacuation-scenario-demo-2026` key to both
  `trusted-keys.json` copies. Events are synthetic and say so.

## Existing signed bundle flow

1. `sources/tdx-fixture.json` is a TDX-shaped input record (a real 內湖區 road).
   `data/fixtures/neihu/demo-v136.json` and `scale-v136.json` are larger multi-source
   inputs in the same shape.
2. `normalizeSource()` converts a batch to unsigned Event v0, accepting an
   allowed-source list and requiring every record to declare `area_id` / `theme`.
   `normalizeTdx()` is the TDX-only wrapper kept for existing callers.
3. `signEvent()` calculates the canonical SHA-256 payload hash and signs it with Ed25519.
4. `buildBundle()` buckets events by `(area_id, theme)`, then splits each bucket by
   size, into signed Chunk v0 records + a signed Manifest v0. Each chunk and each
   manifest entry carries `area_id`, `theme` and a derived `bbox`.
5. `verifyBundle()` verifies the manifest, chunk binding/hash/bbox/signature, and
   every event before APPLY.

The private key is a server-side input. It is never stored in this repository or shipped to an Android client.

## Run

```powershell
npm test

node pipeline/cli.mjs keygen --out-dir .stage2-keys --key-id neihu-demo-2026

# Curated demo dataset: 5 areas x 6 themes -> ~22 chunks named by area/theme.
node pipeline/cli.mjs build `
  --input data/fixtures/neihu/demo-v136.json `
  --out-dir .neihu-bundle `
  --private-key .stage2-keys/private-key.pem `
  --key-id neihu-demo-2026
node pipeline/cli.mjs verify `
  --manifest .neihu-bundle/manifest.json `
  --chunks-dir .neihu-bundle/chunks `
  --public-key .stage2-keys/public-key.pem `
  --now 2026-09-01T08:00:00Z

# Scale dataset (~500 events) -> many more chunks; bump target size to taste.
node pipeline/cli.mjs build `
  --input data/fixtures/neihu/scale-v136.json `
  --out-dir .neihu-scale `
  --private-key .stage2-keys/private-key.pem `
  --key-id neihu-demo-2026 `
  --target-size-bytes 8192
```

The generated key and bundle directories (`.stage2-*`, `.neihu-*`) are local
development artifacts and are gitignored.
