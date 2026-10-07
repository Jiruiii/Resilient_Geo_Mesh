# ResilientGeo 中央 Server 與資料接入 Spec

> **2026-10-03 scope adjustment**

The current approved shelter scope is static shelter locations and planned capacity only. The `taiwan-shelter-status` dynamic collector and shelter crosswalk are excluded; any original status-source requirements below are superseded by this adjustment. Legacy fixture/replay events and client-side handling remain outside this server change.

## 目標

建立一台可部署在 VPS 的中央 Server，集中呼叫 TDX、CWA、NCDR、避難所、醫療院所與 OSM 等資料來源，將結果快取、正規化、簽章並發布給未來的手機端使用。

本階段的核心規則是：手機請求不直接觸發官方 API。官方 API 只由 Server 的排程 Collector 呼叫，手機只讀取 Server 已發布的 snapshot 或 signed release。

## 現況與問題邊界

目前 repository 已有：

- `pipeline/` 的 Node.js ESM collector、normalizer、簽章與 feed builder。
- TDX、CWA、NCDR 的動態來源 adapter。
- 醫療院所、避難所、OSM 的靜態來源 adapter。
- `government-feed-v1`、manifest、chunk 與 Ed25519 驗證流程。
- `pipeline/serve-government.mjs`，但它只是綁定 `127.0.0.1` 的本機 USB 驗證 server，不是正式 API。
- repository 目前沒有正式部署的公開 REST API server。

本 Spec 將現有 pipeline 包裝成 Server-side data service，不重新建立第二套資料 schema，也不把 fixture/replay 當成 live data。

## 範圍

### 本階段包含

1. VPS 上的 Fastify API service。
2. 單一 Collector scheduler 與 source lock。
3. 官方資料來源的排程收集：
   - TDX 道路事件。
   - CWA 地震、天氣警特報、颱風。
   - NCDR 災害警戒。
   - 避難所位置與開設狀態。
   - 醫療院所主檔與可驗證座標補足。
   - OSM 必要 POI。
   - 行政區與邊界 catalog。
4. raw snapshot、normalized snapshot、source state 與 signed release 的本機檔案快取。
5. ETag / Last-Modified conditional request。
6. NCDR index/detail 的 CAPID 去重。
7. 現有 `government-feed-v1` 的相容發布。
8. 靜態 layer 的簽章發布與唯讀下載路徑。
9. Docker Compose、反向代理、HTTPS、persistent volume 與 secrets 邊界。
10. Server、pipeline 與部署層的自動化測試。

### 明確不包含

- 不修改 `android/` 或 `flutter/`。
- 不修改 Room、BLE、Android bridge、手機端同步或路線邏輯。
- 不在手機端加入 Server URL、登入、上傳或同步程式碼。
- 不在本 Spec 實作 crowd report 審核頁面、管理員登入或官方管理警告；這些保留為下一份 server-only Spec。
- 不建立全台道路 routing graph。
- 不把 API key、Raw snapshot 或 private key 發布給公開 API。

## 架構

```text
官方資料來源
  │
  ▼
Collector Scheduler ── Source Cache Store
  │                         │
  ▼                         ▼
Normalizer / Area Filter   raw + state
  │
  ▼
Signed Release Publisher ── Atomic Current Pointer
  │
  ▼
Fastify Read API ── Caddy / HTTPS ── 未來手機端
```

部署時拆成三個 container：

- `collector`：可讀 secrets、可寫 private cache 與 public release volumes，執行排程與簽章發布。
- `api`：只讀公開 release volume，不掛載 private cache，也不持有 upstream credentials 或 signing private key。
- `proxy`：Caddy，負責 HTTPS、公開入口與基本 request limit。

Collector 必須只有一個 production writer。若服務重啟或發生重複啟動，使用檔案 lock 拒絕第二個 collector 執行同一個 source。

## 資料流程

```text
source adapter
  → request with credentials
  → safe raw snapshot
  → AreaCatalog / geometry validation
  → normalized event 或 feature
  → source state
  → government-feed-v1 或 signed layer
  → atomic release publish
```

### Source ID 對應

內部 adapter 使用完整 source ID；現有 government feed 使用相容的短 ID：

| 內部 source ID | government feed source ID | 產物 |
|---|---|---|
| `tdx-road-events` | `tdx-road` | dynamic event feed |
| `cwa-earthquake` | `cwa-earthquake` | dynamic event feed |
| `cwa-weather-warning` | `cwa-warning` | dynamic event feed |
| `cwa-typhoon-warning` | `cwa-typhoon` | dynamic event feed |
| `ncdr-hazard-events` | `ncdr` | dynamic event feed |
| `taiwan-shelter` | — | signed static layer |
| `taiwan-medical` | — | signed static layer |
| `osm-taiwan` | — | signed static layer |

此 mapping 只能集中定義在 source registry，不可散落在 route 或 collector worker 中。

## 快取與儲存

Server 使用分離的 persistent volumes：

```text
/var/lib/resilientgeo-private/
  source-cache/<source-id>/raw.json
  source-cache/<source-id>/normalized.json
  source-cache/<source-id>/state.json

/var/lib/resilientgeo-public/
  releases/government/feed.json
  releases/government/releases/<revision>/<source>/<chunk>.json
  releases/layers/<layer-id>/manifest.json
  releases/layers/<layer-id>/chunks/<chunk>.json
  current/feed.json
  current/layers/<layer-id>/...
```

Raw snapshot 只存在 private volume，API container 不掛載該 volume，也不由 API route 直接提供。公開 release 只包含已正規化、已驗證、已簽章的資料。

每個 source state 至少包含：

```json
{
  "schema_version": "source-state-v1",
  "source_id": "tdx-road-events",
  "status": "ok",
  "checked_at": "RFC3339",
  "retrieved_at": "RFC3339 or null",
  "last_success_at": "RFC3339 or null",
  "etag": "safe response value or null",
  "last_modified": "safe response value or null",
  "content_sha256": "hex or null",
  "partial": false,
  "error_code": null
}
```

允許的 `status` 至少包含 `ok`、`not_modified`、`partial`、`stale`、`blocked_by_auth`、`unavailable`。來源失敗時保留上一份 last-known-good snapshot，不發布空資料覆蓋它。

## 更新策略

預設排程由環境設定覆寫：

| 類型 | 預設頻率 |
|---|---:|
| TDX 道路事件 | 15 分鐘 |
| CWA 與 NCDR | 10 分鐘 |
| 醫療、避難所位置、OSM | 每日一次 |
| 行政區 catalog | 手動版本更新 |

API request 不會觸發 upstream refresh。所有 upstream request 都必須帶有 source-level timeout、有限次數 retry、最大 payload 大小與安全錯誤分類。

`304 Not Modified` 只更新 `checked_at` 與 response metadata，不產生新的 raw payload 或 normalized release。內容 hash 未變更時，publisher 重用 immutable chunks。

NCDR 必須保存 index 的 CAPID 狀態；只有新 CAPID 或來源版本改變時才取得 detail。取消或更新事件仍依現有 normalizer 與 event version ledger 處理。

## 發布契約

### Dynamic feed

第一階段維持現有：

- `schema_version: government-feed-v1`
- `signing_key_id: government-feed-2026`
- Ed25519 feed signature
- dataset manifest 與 signed chunks
- event `namespace`、`event_version`、`expires_at`

Server runtime 不得依賴 Android asset 讀取信任設定。Publisher 改由 Server config 提供 signing key metadata；Android 既有 `trusted-keys.json` 不修改，仍可在未來用相同 key contract 驗證。

### Static layers

醫療、避難所、OSM 與行政區資料使用既有 `build-layer` / `verify-layer` contract，逐 layer 發布 manifest 與 chunks。靜態 layer 不直接混入 `government-feed-v1`。

每次 release 在公開前必須完成：

1. schema validation。
2. hash 驗證。
3. Ed25519 signature 驗證。
4. size 與 chunk count limit 驗證。
5. atomic rename 更新 current pointer。

發布失敗時，保留舊的 current release；不可留下半份可被 API 讀到的 release。

## API 契約

### `GET /healthz`

只表示 process 存活，不檢查資料 freshness。成功回傳 200。

### `GET /readyz`

檢查公開 current feed 存在、可解析且通過簽章驗證。沒有有效初始 release 時回傳 503。

### `GET /feed.json`

提供目前 signed `government-feed-v1`，並保留現有 feed/chunk path compatibility。

### `GET /releases/<allowlisted-path>`

只提供符合固定 path pattern 的 signed release 與 chunk。不得由 URL 讀取任意 filesystem path。

### `GET /v1/layers/:layerId/manifest.json`

提供指定 layer 的 signed manifest。`layerId` 必須來自 server registry。

### `GET /v1/layers/:layerId/chunks/:chunkName`

提供指定 layer 的已簽章 chunk；拒絕 `..`、slash、非數字 chunk name 與 registry 外的 layer。

### `GET /v1/source-status`

只提供 sanitized source status、最後成功時間、coverage、資料版本與錯誤分類，不提供 raw URL query、credential、stack trace 或內部路徑。

### `GET /v1/metadata`

提供 feed revision、layer versions、server build version、資料 coverage 與產生時間。

所有資料 route 支援 `ETag`、`Last-Modified`、`Cache-Control` 與壓縮回應；API 不直接暴露 raw 或 normalized private snapshot。

## 失敗與資料語意

- 認證失敗：`blocked_by_auth`，保留上一份有效資料。
- 單一端點失敗：`partial`，保留成功部分與明確 metadata。
- 全部 upstream 不可用：`unavailable` 或 `stale`，不得清空 current release。
- 缺少座標：保留 `null` / `unresolved`，不猜測座標。
- 避難所缺狀態：保留 `UNKNOWN`，不轉成 `CLOSED`。
- 過期事件：依 `expires_at` 與既有 feed ledger 處理，不延長官方事件有效期。
- fixture/replay：只能用於測試，不得標示為 live official data。

## 安全需求

- TDX、CWA、NCDR credentials 只存在 collector container 的 environment 或 secret mount。
- signing private key 只存在 collector container，API 與 proxy 不可讀取。
- raw snapshot 不可公開、不可寫入 log、不可包含 credential-bearing URL。
- 對外只發布 normalized、signed、allowlisted assets。
- API 只讀，不提供第一階段的資料寫入 endpoint。
- Caddy 與 Fastify 都設定 request body、response size、timeout 與 rate limit。

## 部署需求

Docker Compose 至少包含：

- `collector`：排程、資料收集、簽章、寫入 private cache 與 public release volumes。
- `api`：Fastify，唯讀掛載 public release volume，不掛載 private cache。
- `proxy`：Caddy，HTTPS 對外入口。

VPS 必須提供：

- private cache 與 public release 分離的 persistent volumes。
- secrets 不進 image 與 Git。
- container restart policy。
- collector 與 API log rotation。
- `/healthz` 與 `/readyz` 監控。
- 單一 collector writer lock。

## 驗收條件

1. 多支手機同時請求同一份 feed，不會增加 upstream API 呼叫次數。
2. 每個 source 只依排程執行一次 collection。
3. ETag / Last-Modified 命中時不重建 raw payload。
4. NCDR 未變更 CAPID 不重新取得 detail。
5. upstream 失敗時 last-known-good release 仍可下載。
6. feed、manifest、chunk 可以通過現有簽章驗證。
7. 公開 API 不會回傳 credentials、raw snapshot 或任意檔案。
8. VPS 重啟後，persistent snapshot 與 current release 可恢復。
9. Android 與 Flutter working tree 不產生任何修改。
10. 驗收報告清楚標示「Server data ingestion 已完成」與「Android integration 尚未開始」的差異。

## 後續 Spec 邊界

Server-only 的 crowd report、管理員帳號、審核頁面與官方警告事件另立 Spec。Android/Flutter 只有在 Server contract 穩定並獲得明確批准後，才另立手機端整合 Spec。
