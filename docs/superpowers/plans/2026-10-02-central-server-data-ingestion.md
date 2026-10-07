# ResilientGeo 中央 Server 與資料接入 Implementation Plan

> **2026-10-03 scope adjustment**

The current approved shelter scope is static shelter locations and planned capacity only. Do not implement or schedule `taiwan-shelter-status` or a shelter crosswalk; any original status-source steps below are superseded by this adjustment. Legacy fixture/replay events and client-side handling remain outside this server change.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立不會因手機數量增加而重複呼叫官方 API 的 VPS Server，集中收集、快取、正規化、簽章並提供 ResilientGeo 資料。

**Architecture:** 以現有 `pipeline/` 為資料核心，新增 Fastify read API、單一 Collector scheduler、檔案型 source cache 與 atomic signed release。Collector 擁有 secrets 和 private key；API 只讀公開 release volume；Android/Flutter 在本計畫中完全不修改。

**Tech Stack:** Node.js 22 ESM、Fastify 5.x、Node `node:test`、Docker Compose、Caddy、Ed25519、現有 pipeline normalizers and bundle contracts。

**Spec:** [2026-10-02-central-server-data-ingestion-design.md](../specs/2026-10-02-central-server-data-ingestion-design.md)

## Global Constraints

- 不修改 `android/`、`flutter/`、Room、BLE、Android bridge 或手機端同步。
- 手機 request 不得直接觸發 upstream collection；upstream 只能由 Collector 排程呼叫。
- Raw snapshot 只能存在 private persistent volume，不得由 API route 提供。
- credentials 與 signing private key 只能存在 Collector 的 environment 或 secret mount。
- 動態 feed 維持 `government-feed-v1` 與 `government-feed-2026` key contract。
- 缺資料保留 `null`、`UNKNOWN`、`unresolved`、`partial`、`stale` 語意，不轉成零或 `CLOSED`。
- source failure 保留 last-known-good release，不用空資料覆蓋有效資料。
- 不將 fixture/replay 宣稱為 live official data。
- 本次只建立 Server/data ingestion；crowd moderation、admin UI 與手機端整合另立 Spec。

## Review Focus

- **重複 upstream 呼叫：** 多個 API client 同時讀取同一份資料時，只能看到已發布 snapshot；由 Task 3 與 Task 5 的 request-count integration test 固定。
- **條件式請求：** upstream 回傳 304 時不能重建 raw payload 或版本；由 Task 2 的 ETag/Last-Modified test 固定。
- **部分失敗：** TDX 單一端點或任一來源失敗時，必須保留成功資料與上一份有效 release；由 Task 3/4 的 partial and last-known-good tests 固定。
- **簽章與 trust boundary：** API 不得依賴 Android asset，也不得暴露 private key 或 credential-bearing provenance；由 Task 4/5 的 signed-release and redaction tests 固定。
- **檔案安全：** release route 不可透過 `..`、slash 或非 registry layer 讀取任意檔案；由 Task 5 的 path traversal tests 固定。

---

### Task 1: 建立 Server contract、source registry 與設定

**Files:**
- Modify: `package.json`
- Create: `server/src/config.mjs`
- Create: `server/src/source-registry.mjs`
- Create: `server/.env.example`
- Test: `server/test/config.test.mjs`
- Test: `server/test/source-registry.test.mjs`

**Interfaces:**
- `loadServerConfig(env: Record<string, string | undefined>) -> ServerConfig`
- `SOURCE_REGISTRY: ReadonlyArray<SourceDefinition>`
- `getSourceDefinition(sourceId: string) -> SourceDefinition`
- `SourceDefinition` 至少包含 `sourceId`、`feedId`、`kind`、`scheduleMs`、`coverage`、`output` 與 `enabledByDefault`。

- [ ] **Step 1: Write the failing tests**

- `loadServerConfig` 讀取 `PRIVATE_DATA_ROOT`、`PUBLIC_RELEASE_ROOT`、`AREA_CATALOG_PATH`、`SIGNING_PRIVATE_KEY_PATH`、`SIGNING_PUBLIC_KEY_PATH`、`SIGNING_KEY_ID`、`PORT` 與 schedule override。
- 缺少 signing private key path、invalid port、negative schedule、或非絕對 private/public root 時拒絕啟動設定。
  - registry 會正確映射 `tdx-road-events → tdx-road`、`cwa-weather-warning → cwa-warning` 與 `ncdr-hazard-events → ncdr`。
  - `taiwan-shelter`、`taiwan-medical`、`osm-taiwan` 只能產生 static layer，不得進 dynamic government feed。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/config.test.mjs server/test/source-registry.test.mjs`

Expected: FAIL because the new Server modules do not exist.

- [ ] **Step 3: Implement the configuration and registry**

  - `loadServerConfig` 將 environment 轉成 immutable config，預設 schedule 為 TDX 15 分鐘、CWA/NCDR 10 分鐘與 static sources 24 小時。
  - `SOURCE_REGISTRY` 是唯一 source mapping；scheduler、collector 與 route 不自行建立 source ID mapping。
  - 在 `package.json` 增加 `server:start`、`collector:start`、`test:server` scripts 與 Fastify runtime dependency；不加入資料庫 dependency。
  - `.env.example` 只放變數名稱與假值，不放任何實際 credential。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/config.test.mjs server/test/source-registry.test.mjs`

Expected: PASS，且測試輸出不包含任何 secret。

- [ ] **Step 5: Commit**

```bash
git add package.json server/src server/test server/.env.example
git commit -m "feat: define central server source contracts"
```

### Task 2: 實作 persistent source cache 與 conditional request

**Files:**
- Modify: `pipeline/lib/source.mjs`
- Modify: `pipeline/test/source.test.mjs`
- Create: `server/src/storage/source-cache.mjs`
- Create: `server/src/storage/atomic-file.mjs`
- Test: `server/test/source-cache.test.mjs`

**Interfaces:**
- `readSourceState(dataRoot: string, sourceId: string) -> Promise<SourceState | null>`
- `readSourceSnapshot(dataRoot: string, sourceId: string) -> Promise<RawSnapshot | null>`
- `writeSourceResult(dataRoot: string, sourceId: string, result: SourceCacheWrite) -> Promise<void>`
- `requestJsonConditional(url: string, options: RequestOptions & { validators?: Validators }) -> Promise<ModifiedResponse | NotModifiedResponse>`
- `SourceCacheWrite = { snapshot, normalized, state }`
- `NotModifiedResponse = { notModified: true, status: 304, headers }`

- [ ] **Step 1: Write the failing tests**

  - first request 沒有 validators；成功 response 的 ETag 與 Last-Modified 會寫入 `state.json`。
  - second request 會送出 `If-None-Match` 與 `If-Modified-Since`。
  - 304 response 只更新 `checked_at` 與 status=`not_modified`，不改變 raw payload、normalized snapshot 或 content hash。
  - write 中途失敗時，原有 `current` 與 source state 保持可讀，不留下 half-written JSON。
  - snapshot request metadata 仍通過現有 secret redaction，不保存 API key、Authorization 或 client secret。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/test/source.test.mjs server/test/source-cache.test.mjs`

Expected: FAIL because conditional response and source cache APIs do not exist.

- [ ] **Step 3: Implement conditional request and atomic source storage**

  - 在 `pipeline/lib/source.mjs` 保留現有 `requestJson`、`requestText` 行為，新增明確 opt-in 的 304 result，避免破壞既有 source adapter。
  - `source-cache.mjs` 以 source-specific directory 儲存 raw、normalized、state；所有寫入先寫 `.tmp` 再使用同一 filesystem 的 `rename` 原子切換。
  - source state 寫入 `ok`、`not_modified`、`partial`、`stale`、`blocked_by_auth` 或 `unavailable`，並保留 last-known-good path/hash。
  - 只保存 safe response headers；錯誤只保存 typed error code，不保存 exception message、request URL query 或 stack trace。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/test/source.test.mjs server/test/source-cache.test.mjs`

Expected: PASS，包含 304、atomic write、secret redaction 與 last-known-good regression。

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/source.mjs pipeline/test/source.test.mjs server/src/storage server/test/source-cache.test.mjs
git commit -m "feat: add conditional source cache"
```

### Task 3: 建立 reusable collector runner、NCDR 去重與排程 lock

**Files:**
- Create: `pipeline/lib/source-collector.mjs`
- Modify: `pipeline/cli.mjs`
- Modify: `pipeline/government-publisher.mjs`
- Modify: `pipeline/government-collector-worker.mjs`
- Create: `server/src/collector/collector-runner.mjs`
- Create: `server/src/collector/scheduler.mjs`
- Create: `server/src/collector/collector-lock.mjs`
- Test: `pipeline/test/source-collector.test.mjs`
- Test: `server/test/collector-runner.test.mjs`
- Test: `server/test/scheduler.test.mjs`

**Interfaces:**
- `collectSource({ definition, scope, config, cacheStore, now }) -> Promise<CollectionResult>`
- `collectSources({ sourceIds, scope, config, cacheStore, now }) -> Promise<CollectionResult[]>`
- `runScheduledCollection({ sourceIds, config, cacheStore, publisher, now }) -> Promise<RunReport>`
- `createScheduler({ registry, run, clock }) -> { start(), stop(), runNow(sourceId) }`
- `acquireCollectorLock(lockPath) -> Promise<() => Promise<void>>`

- [ ] **Step 1: Write the failing tests**

  - source collector 可以使用既有 TDX/CWA/NCDR/shelter/static adapters，輸出統一的 `CollectionResult`，不把 fixture 當成 live result。
  - TDX 多 endpoint 一個失敗時回傳 `partial`，保留成功 endpoint 的事件。
  - NCDR 第二次執行對相同 CAPID 不呼叫 detail endpoint；新 CAPID 才取得 detail。
  - 上游失敗時 `CollectionResult` 帶 source status，但 runner 不刪除舊 snapshot。
  - production collector 需要 global lock；同一 source 不可重疊執行，第二個 collector 無法取得 lock。
  - fake clock 驗證 schedule：TDX 15 分鐘、CWA/NCDR 10 分鐘與 static 24 小時。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/test/source-collector.test.mjs server/test/collector-runner.test.mjs server/test/scheduler.test.mjs`

Expected: FAIL because the reusable runner, scheduler and lock do not exist.

- [ ] **Step 3: Extract the reusable collector path**

  - 將現有 `pipeline/cli.mjs` 的 dynamic/static collection branching 抽成 `collectSource`，CLI 改為呼叫同一個 implementation。
  - `government-publisher.mjs` 與 worker 改為接收 `scope`、`areaCatalogPath`、source definition 與 config，不再 hard-code repository boundary path。
  - collector 以完整 internal source ID 工作，再交給 Task 1 registry 取得 feed ID 或 layer ID。
  - global collector lock 與 source-level schedule state 分開保存，避免多個 production writer 同時切換 current release。
  - NCDR 以 cache state 保存 CAPID index、detail fingerprint 與 retrieved timestamp；取消／更新仍交給既有 normalizer 和 event version ledger。
  - scheduler 只負責觸發 source job；source adapter、cache、publisher 各自維持單一責任。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/test/source-collector.test.mjs server/test/collector-runner.test.mjs server/test/scheduler.test.mjs pipeline/test/cwa-ncdr.test.mjs pipeline/test/tdx.test.mjs`

Expected: PASS，且 fake upstream call count 證明重複執行會命中 cache。

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/source-collector.mjs pipeline/cli.mjs pipeline/government-publisher.mjs pipeline/government-collector-worker.mjs server/src/collector pipeline/test/source-collector.test.mjs server/test/collector-runner.test.mjs server/test/scheduler.test.mjs
git commit -m "feat: schedule cached official source collection"
```

### Task 4: 將 government feed 與 static layers 接到 atomic release publisher

**Files:**
- Modify: `pipeline/lib/government-feed.mjs`
- Modify: `pipeline/test/government-feed.test.mjs`
- Create: `pipeline/lib/layer-publisher.mjs`
- Create: `server/src/publisher/release-publisher.mjs`
- Create: `server/src/storage/release-store.mjs`
- Create: `server/test/release-publisher.test.mjs`
- Create: `server/test/release-store.test.mjs`

**Interfaces:**
- `buildGovernmentFeed({ previous, previousEvents, results, privateKey, publicKey, signingKeyId, now }) -> { feed, files }`
- `publishGovernmentRelease({ releaseRoot, previousRoot, results, signingKey, now }) -> Promise<ReleaseMetadata>`
- `publishStaticLayer({ layerId, features, releaseRoot, signingKey, now }) -> Promise<LayerMetadata>`
- `readCurrentFeed(releaseRoot) -> Promise<GovernmentFeed>`
- `readCurrentLayer(releaseRoot, layerId) -> Promise<LayerMetadata>`

- [ ] **Step 1: Write the failing tests**

  - publisher 可使用 server-provided public key 與 signing key id，不讀取 `android/app/src/main/assets/trust/trusted-keys.json`。
  - `government-feed-v1` 的 signature、event version ledger、last-known-good、unchanged chunk reuse 與 24 小時 feed expiry 維持現有測試語意。
  - signed release 寫入暫存目錄後才切換 `current/feed.json`；publisher 失敗時 current feed hash 不變。
  - static layer 產生 manifest/chunks，並可用現有 `verify-layer` contract 驗證。
  - release store 拒絕不存在的 layer、無效 revision、超過大小限制或不符合 allowlist 的 chunk path。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/test/government-feed.test.mjs server/test/release-publisher.test.mjs server/test/release-store.test.mjs`

Expected: FAIL because server release publisher and layer publisher do not exist.

- [ ] **Step 3: Implement configurable signing and atomic release publication**

  - 將 `FEED_KEY_ID` 保留為 default，新增 explicit `signingKeyId` option；既有 CLI/test 呼叫不需改變結果。
  - 將 trust public key、private key path、release root 從 Android asset path 分離成 server config。
  - release publisher 先在 revision-specific staging directory 建立全部 files，執行 schema/hash/signature/size checks，再 atomic rename 到 immutable revision 與 current pointer。
  - dynamic results 使用 Task 1 mapping；static outputs 分別以 `taiwan-shelter`、`taiwan-medical`、`osm-taiwan` layer ID 發布，不混入 government feed。
  - release store 只回傳公開 feed、manifest、signed chunks；raw 與 normalized files 不加入 public index。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/test/government-feed.test.mjs server/test/release-publisher.test.mjs server/test/release-store.test.mjs pipeline/test/static-sources.test.mjs`

Expected: PASS，並驗證 signed release 與失敗 rollback。

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/government-feed.mjs pipeline/test/government-feed.test.mjs pipeline/lib/layer-publisher.mjs server/src/publisher server/src/storage/release-store.mjs server/test/release-publisher.test.mjs server/test/release-store.test.mjs
git commit -m "feat: publish atomic signed server releases"
```

### Task 5: 建立唯讀 Fastify API

**Files:**
- Create: `server/src/app.mjs`
- Create: `server/src/routes/health.mjs`
- Create: `server/src/routes/feed.mjs`
- Create: `server/src/routes/layers.mjs`
- Create: `server/src/routes/metadata.mjs`
- Create: `server/src/routes/source-status.mjs`
- Create: `server/src/api-entrypoint.mjs`
- Test: `server/test/api.test.mjs`

**Interfaces:**
- `buildApp({ config, releaseStore, sourceStateStore, logger }) -> FastifyInstance`
- `GET /healthz -> 200 { status: "ok" }`
- `GET /readyz -> 200 | 503 { status, feed_revision, checked_at }`
- `GET /feed.json -> signed government feed`
- `GET /releases/:revision/:source/:chunk -> signed feed chunk`
- `GET /v1/layers/:layerId/manifest.json -> signed layer manifest`
- `GET /v1/layers/:layerId/chunks/:chunkName -> signed layer chunk`
- `GET /v1/source-status -> sanitized source status list`
- `GET /v1/metadata -> public revision, layer, coverage and generated-at metadata`

- [ ] **Step 1: Write the failing tests**

  - `buildApp` 可用 in-memory release store 注入，讓 route tests 不需要 VPS 或外部 API。
  - `/healthz` 在 feed 不存在時仍回 200；`/readyz` 在 feed 不存在或 signature invalid 時回 503。
  - `/feed.json` 與 allowlisted chunk 回傳正確 content type、ETag、Last-Modified、X-Content-Type-Options 與 cache headers。
  - layer route 只允許 registry layer 與數字 chunk；`../`, encoded traversal、slash chunk name、未知 layer 都回 404。
  - source status 只包含 status、timestamps、coverage、revision 與 error code，不包含 raw path、credential、URL query 或 stack trace。
  - 任一 route 不會呼叫 upstream adapter。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/api.test.mjs`

Expected: FAIL because the Fastify application and routes do not exist.

- [ ] **Step 3: Implement the read-only API**

  - 使用 Fastify route schema 驗證 params，所有檔案存取透過 `releaseStore`，不直接拼接 request URL 到 filesystem。
  - `feed.json` 與現有 `releases/<revision>/<source>/<index>.json` 保持相容；layer 使用 registry-backed path resolver。
  - API 只掛載 release/current volume；source state 先經 sanitizer 再回應。
  - 加入 response size limit、request timeout、compression/cache headers 與統一 error response；不回傳內部 exception message。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/api.test.mjs`

Expected: PASS，包含 readiness、header、path traversal、sanitization 與 no-upstream-call tests。

- [ ] **Step 5: Commit**

```bash
git add server/src/app.mjs server/src/api-entrypoint.mjs server/src/routes server/test/api.test.mjs
git commit -m "feat: expose signed releases through fastify"
```

### Task 6: 建立 Docker Compose、反向代理與 secrets boundary

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/.dockerignore`
- Create: `docs/central-server-runbook.md`
- Modify: `package.json`
- Test: `server/test/deployment-config.test.mjs`

**Interfaces:**
- `collector` container executes `npm run collector:start` and writes private cache plus public releases.
- `api` container executes `npm run server:start` and mounts only the public releases volume read-only.
- `proxy` container exposes HTTPS and forwards only public API paths to `api`.
- `GET /healthz` and `GET /readyz` are the container healthcheck contracts.

- [ ] **Step 1: Write the failing tests**

  - Compose contains exactly `collector`, `api`, `proxy` services, a persistent data volume and a read-only API release mount.
  - API service has no upstream API key or signing private key environment variable.
  - collector service has no public port and is the only service with write access to the data volume.
  - Caddy forwards HTTPS traffic to API and does not expose raw/cache directories.
  - `.dockerignore` excludes `.env`, private keys, `data/live`, raw snapshots and generated local bundles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/deployment-config.test.mjs`

Expected: FAIL because deployment files do not exist.

- [ ] **Step 3: Implement the deployment files and runbook**

  - Dockerfile uses a production Node 22 base, installs only runtime dependencies, and starts no shell-based multi-process supervisor.
  - Compose uses separate named persistent volumes for private cache and public releases; collector writes both, while API mounts only public releases read-only。
  - secrets use Docker secrets or VPS environment injection; real values never enter image layers, compose committed values, logs or public assets。
  - Caddy handles TLS and proxy headers; only `/healthz`, `/readyz`, `/feed.json`, `/releases/*`, `/v1/*` are documented public paths。
  - runbook documents initial key setup, area catalog preparation, initial release bootstrap, restart, backup, stale source diagnosis and rollback without modifying Android。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/deployment-config.test.mjs`

Then, on a Docker-enabled host, run: `docker compose -f deploy/docker-compose.yml config`

Expected: tests PASS and Compose config validates without unresolved required variables other than explicitly documented secrets/domain values。

- [ ] **Step 5: Commit**

```bash
git add deploy docs/central-server-runbook.md package.json server/test/deployment-config.test.mjs
git commit -m "ops: add central server compose deployment"
```

### Task 7: 完成 server-only end-to-end verification

**Files:**
- Create: `server/test/server-ingestion.integration.test.mjs`
- Modify: `pipeline/test/collection.test.mjs`
- Modify: `docs/central-server-runbook.md`
- Modify: `docs/frontend-real-data-integration.md`
- Modify: `docs/government-online-sync.md`

**Interfaces:**
- Integration harness starts fake TDX/CWA/NCDR/shelter upstreams, one collector, and the Fastify app with a temporary `DATA_ROOT`。
- `runScheduledCollection` produces a signed feed and static layer release that the API can serve without any upstream call during reads。

- [ ] **Step 1: Write the failing integration tests**

  - Run initial collection, fetch the same feed from three simulated clients, and assert upstream call counts equal one scheduled collection rather than three client requests。
  - Run a second collection with unchanged ETag/CAPID and assert no new detail/payload request。
  - Make one source return 503 and assert previous signed feed remains downloadable with source status `unavailable` or `stale`。
  - Assert feed and layers verify with generated Ed25519 public key。
  - Assert git diff for `android/` and `flutter/` is empty after the server work。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/server-ingestion.integration.test.mjs`

Expected: FAIL because the complete Server pipeline is not yet wired together.

- [ ] **Step 3: Wire the production entrypoints and document operations**

  - `collector:start` loads config, creates cache/registry/scheduler/publisher and starts only one scheduler。
  - `server:start` loads the release store and starts Fastify without source credentials。
  - runbook records which results are live, stale, partial, blocked by auth or fixture/replay；不宣稱 Android 已整合。
  - update existing data-flow docs to state that repository now has a planned/implemented Server boundary only after the integration evidence passes；不把未驗證的 VPS/public HTTPS 狀態寫成已部署。

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
node --test pipeline/test/*.test.mjs server/test/*.test.mjs
git diff --check
git diff -- android flutter
```

Expected:

- all pipeline and server tests PASS;
- `git diff --check` has no whitespace errors;
- the Android/Flutter diff is empty;
- integration output proves repeated client reads do not repeat upstream API calls。

- [ ] **Step 5: Commit**

```bash
git add server pipeline docs deploy package.json
git commit -m "test: verify central server ingestion flow"
```

## Completion boundary

本計畫完成只代表：VPS-ready Server 可以集中取得官方資料、快取、產生 signed releases 並提供唯讀 API。它不代表 Android 已連線、不代表手機端同步已完成，也不代表 crowd moderation 或管理員頁面已完成。
