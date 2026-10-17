# 03 Server 與 Azure

> 總覽與 Global Constraints：[README.md](README.md)。Server 只做「驗證、儲存、原樣轉發」：收發單位是原裝置簽章的 crowd-rescue chunk；不重新簽章、不把求救包裝成官方資料、不在 log 與回應中輸出描述或座標。驗證完全重用 01 的 `verifyCrowdChunk`（內含 `verifyEvent` 與 contract 階段）與 `rescueTransitionErrors`。

模組切分：

| 檔案 | 責任 |
|---|---|
| `server/src/rate-limit.mjs`（新） | 固定時間窗計數器，可注入時鐘 |
| `server/src/storage/crowd-rescue-store.mjs`（新） | 求救儲存介面，檔案與 Azure Blob 兩種實作 |
| `server/src/storage/azure-blob-rest.mjs`（改） | 新增 `listBlobNames` |
| `server/src/routes/crowd-rescue.mjs`（新） | `POST`／`GET /v1/crowd/rescue-events` |
| `server/src/app.mjs`、`config.mjs`、`api-entrypoint.mjs`（改） | 組裝、設定、錯誤處理 |
| `deploy/azure/main.bicep`、`deploy/docker-compose.yml`、`deploy/Dockerfile`（改） | 私有 container、權限、清除政策、本機 volume |

---

### Task 10: 速率限制

**Files:**
- Create: `server/src/rate-limit.mjs`
- Test: `server/test/rate-limit.test.mjs`

**Interfaces:**
- Produces: `createRateLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) → { hit(key: string, limit: number, windowMs: number): { allowed: boolean, retryAfterMs: number } }`

- [ ] **Step 1: 寫失敗的測試**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRateLimiter } from '../src/rate-limit.mjs';

test('allows up to the limit inside one window, then reports when to retry', () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });
  for (let index = 0; index < 3; index += 1) assert.equal(limiter.hit('key:a', 3, 60_000).allowed, true);
  const blocked = limiter.hit('key:a', 3, 60_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
  clock = 30_000;
  assert.equal(limiter.hit('key:a', 3, 60_000).retryAfterMs, 30_000);
  clock = 60_000;
  assert.equal(limiter.hit('key:a', 3, 60_000).allowed, true);
});

test('keys are independent', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  assert.equal(limiter.hit('ip:1', 1, 1000).allowed, true);
  assert.equal(limiter.hit('ip:1', 1, 1000).allowed, false);
  assert.equal(limiter.hit('ip:2', 1, 1000).allowed, true);
});

test('stale windows are pruned so memory stays bounded', () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
  limiter.hit('a', 1, 1000);
  limiter.hit('b', 1, 1000);
  clock = 5000;
  limiter.hit('c', 1, 1000);
  assert.equal(limiter.size(), 1);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test server/test/rate-limit.test.mjs`
Expected: FAIL，模組不存在

- [ ] **Step 3: 實作**

```js
/**
 * Fixed-window counters kept in this process only. With Azure Container Apps
 * maxReplicas = 2 the effective limit is at most twice the configured value;
 * docs/central-server-runbook.md records that trade-off.
 */
export function createRateLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const windows = new Map();

  function prune(at) {
    for (const [key, window] of windows) {
      if (at - window.start >= window.windowMs) windows.delete(key);
    }
  }

  return Object.freeze({
    hit(key, limit, windowMs) {
      const at = now();
      let window = windows.get(key);
      if (!window || at - window.start >= windowMs) {
        window = { start: at, count: 0, windowMs };
        windows.set(key, window);
        if (windows.size > maxKeys) prune(at);
      }
      if (window.count >= limit) return { allowed: false, retryAfterMs: window.start + windowMs - at };
      window.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    size() {
      return windows.size;
    },
  });
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test server/test/rate-limit.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/rate-limit.mjs server/test/rate-limit.test.mjs
git commit -m "feat(server): add in-process rate limiter"
```

---

### Task 11: 求救儲存（檔案與 Azure Blob）

**Files:**
- Create: `server/src/storage/crowd-rescue-store.mjs`
- Modify: `server/src/storage/azure-blob-rest.mjs`（新增 `listBlobNames`）
- Test: `server/test/crowd-rescue-store.test.mjs`

**Interfaces:**
- Produces:
  - `rescueBlobName(eventId: string): string` → `rescue/<sha256 hex of event_id>.json`
  - 儲存記錄格式：`{ event: <signed event>, chunk: <原裝置簽章的 crowd-rescue chunk>, stored_at: ISO string }`（`event` 就是 `chunk.events[0]`，另存一份方便查詢；store 本身不解讀 chunk）
  - 介面 `RescueStore`：`get(eventId) → Promise<{ record, etag } | null>`；`put(record, { ifMatch?: string, ifNoneMatch?: '*' }) → Promise<string /* etag */>`，條件不符時 reject 一個 `error.status === 412` 的錯誤；`list() → Promise<record[]>`
  - `createFileRescueStore({ root: string }) → RescueStore`（etag 為 `record.event.payload_hash`）
  - `createAzureRescueStore({ blobClient, container }) → RescueStore`
  - `blobClient.listBlobNames(container, prefix) → Promise<string[]>`

- [ ] **Step 1: 寫失敗的測試**

```js
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createAzureRescueStore, createFileRescueStore, rescueBlobName } from '../src/storage/crowd-rescue-store.mjs';

const record = (version, hash = `sha256:${String(version).repeat(64).slice(0, 64)}`) => ({
  event: { event_id: 'rescue:abc:1', event_version: version, payload_hash: hash },
  stored_at: '2026-10-12T03:00:00Z',
});

test('blob names hide the event id', () => {
  assert.match(rescueBlobName('rescue:abc:1'), /^rescue\/[0-9a-f]{64}\.json$/);
});

test('file store enforces conditional writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rescue-store-'));
  try {
    const store = createFileRescueStore({ root });
    assert.equal(await store.get('rescue:abc:1'), null);
    const etag = await store.put(record(1), { ifNoneMatch: '*' });
    await assert.rejects(store.put(record(1), { ifNoneMatch: '*' }), (error) => error.status === 412);
    await assert.rejects(store.put(record(2), { ifMatch: 'stale' }), (error) => error.status === 412);
    await store.put(record(2), { ifMatch: etag });
    assert.equal((await store.get('rescue:abc:1')).record.event.event_version, 2);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('azure store maps to blob client calls', async () => {
  const blobs = new Map();
  const blobClient = {
    async getJson(container, name) {
      const entry = blobs.get(`${container}/${name}`);
      return entry ? { value: structuredClone(entry.value), etag: entry.etag } : null;
    },
    async putJson(container, name, value, conditions = {}) {
      const key = `${container}/${name}`;
      const current = blobs.get(key);
      if ((conditions.ifNoneMatch === '*' && current) || (conditions.ifMatch && current?.etag !== conditions.ifMatch)) {
        throw Object.assign(new Error('precondition'), { status: 412 });
      }
      const etag = `"${blobs.size}-${value.event.event_version}"`;
      blobs.set(key, { value: structuredClone(value), etag });
      return etag;
    },
    async listBlobNames(container, prefix) {
      return [...blobs.keys()].filter((key) => key.startsWith(`${container}/${prefix}`)).map((key) => key.slice(container.length + 1));
    },
  };
  const store = createAzureRescueStore({ blobClient, container: 'resilientgeo-crowd' });
  const etag = await store.put(record(1), { ifNoneMatch: '*' });
  assert.equal((await store.get('rescue:abc:1')).etag, etag);
  assert.deepEqual((await store.list()).map((entry) => entry.event.event_version), [1]);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test server/test/crowd-rescue-store.test.mjs`
Expected: FAIL，模組不存在

- [ ] **Step 3: 實作 `crowd-rescue-store.mjs`**

```js
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson } from './atomic-file.mjs';

const PREFIX = 'rescue/';

export function rescueBlobName(eventId) {
  return `${PREFIX}${createHash('sha256').update(eventId, 'utf8').digest('hex')}.json`;
}

function preconditionFailed() {
  return Object.assign(new Error('rescue store precondition failed'), { status: 412 });
}

/** Local and docker-compose storage. One process writes, so a promise chain serializes conditional writes. */
export function createFileRescueStore({ root }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path');
  let queue = Promise.resolve();
  const serialize = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const fileFor = (eventId) => path.join(root, rescueBlobName(eventId));

  async function read(filePath) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return Object.freeze({
    async get(eventId) {
      const record = await read(fileFor(eventId));
      return record ? { record, etag: record.event.payload_hash } : null;
    },
    put(record, { ifMatch, ifNoneMatch } = {}) {
      return serialize(async () => {
        const filePath = fileFor(record.event.event_id);
        const current = await read(filePath);
        if (ifNoneMatch === '*' && current) throw preconditionFailed();
        if (ifMatch && current?.event.payload_hash !== ifMatch) throw preconditionFailed();
        await atomicWriteJson(filePath, record);
        return record.event.payload_hash;
      });
    },
    async list() {
      let names;
      try {
        names = await readdir(path.join(root, PREFIX));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const records = await Promise.all(
        names.filter((name) => name.endsWith('.json')).map((name) => read(path.join(root, PREFIX, name))),
      );
      return records.filter(Boolean);
    },
  });
}

export function createAzureRescueStore({ blobClient, container }) {
  if (!blobClient || typeof container !== 'string') throw new TypeError('blobClient and container are required');
  return Object.freeze({
    async get(eventId) {
      const result = await blobClient.getJson(container, rescueBlobName(eventId));
      return result ? { record: result.value, etag: result.etag } : null;
    },
    async put(record, conditions = {}) {
      try {
        return await blobClient.putJson(container, rescueBlobName(record.event.event_id), record, conditions);
      } catch (error) {
        if (error.status === 409 || error.status === 412) throw preconditionFailed();
        throw error;
      }
    },
    async list() {
      const names = await blobClient.listBlobNames(container, PREFIX);
      const results = await Promise.all(names.map((name) => blobClient.getJson(container, name)));
      return results.filter(Boolean).map((result) => result.value);
    },
  });
}
```

- [ ] **Step 4: `azure-blob-rest.mjs` 新增 `listBlobNames`**

在 `createAzureBlobClient` 的回傳物件內加入（`blobUrl` 只處理 blob，因此另寫 container URL）：

```js
    async listBlobNames(container, prefix) {
      if (typeof container !== 'string' || !/^[a-z0-9-]{3,63}$/u.test(container)) {
        throw new TypeError('container name is invalid');
      }
      const names = [];
      let marker = '';
      do {
        const url = new URL(`${container}`, `${baseUrl.toString().replace(/\/$/u, '')}/`);
        url.searchParams.set('restype', 'container');
        url.searchParams.set('comp', 'list');
        url.searchParams.set('prefix', prefix);
        if (marker) url.searchParams.set('marker', marker);
        const token = await tokenProvider(STORAGE_SCOPE);
        const response = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-ms-date': now().toUTCString(),
            'x-ms-version': STORAGE_API_VERSION,
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw makeHttpError(response);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Name>([^<]+)<\/Name>/gu)) names.push(match[1]);
        marker = /<NextMarker>([^<]*)<\/NextMarker>/u.exec(xml)?.[1] ?? '';
      } while (marker);
      return names;
    },
```

在 `server/test/azure-storage.test.mjs` 追加一個測試：用假的 `fetchImpl` 回兩頁 XML（第一頁含 `<NextMarker>m1</NextMarker>`），斷言回傳兩頁所有 `<Name>`，且第二次請求帶 `marker=m1`：

```js
test('listBlobNames follows NextMarker pages', async () => {
  const requests = [];
  const pages = [
    '<EnumerationResults><Blobs><Blob><Name>rescue/a.json</Name></Blob></Blobs><NextMarker>m1</NextMarker></EnumerationResults>',
    '<EnumerationResults><Blobs><Blob><Name>rescue/b.json</Name></Blob></Blobs><NextMarker /></EnumerationResults>',
  ];
  const client = createAzureBlobClient({
    endpoint: 'https://account.blob.core.windows.net',
    tokenProvider: async () => 'token',
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return new Response(pages[requests.length - 1], { status: 200 });
    },
  });
  assert.deepEqual(await client.listBlobNames('resilientgeo-crowd', 'rescue/'), ['rescue/a.json', 'rescue/b.json']);
  assert.equal(requests[1].searchParams.get('marker'), 'm1');
});
```

（`<NextMarker />` 不符合 `<NextMarker>([^<]*)</NextMarker>`，因此 marker 為空字串，迴圈結束。）

- [ ] **Step 5: 執行測試確認通過**

Run: `node --test server/test/crowd-rescue-store.test.mjs server/test/azure-storage.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/storage/crowd-rescue-store.mjs server/src/storage/azure-blob-rest.mjs server/test/crowd-rescue-store.test.mjs server/test/azure-storage.test.mjs
git commit -m "feat(server): store rescue requests in files or Azure Blob"
```

---

### Task 12: 求救路由

**Files:**
- Create: `server/src/routes/crowd-rescue.mjs`
- Modify: `server/src/app.mjs`（錯誤處理、`trustProxy`、註冊路由）
- Test: `server/test/crowd-rescue-api.test.mjs`

**Interfaces:**
- Consumes: Task 10、Task 11；01 的 `verifyCrowdChunk`、`buildCrowdChunk`、`rescueTransitionErrors`、`RESCUE_NAMESPACE`、`RESCUE_DATASET_ID`、`isDeviceKeyId`；fixture `fixtures/rescue-requests-v0.json`（測試用）
- Produces：

上傳與轉發的單位是 **crowd-rescue chunk**（chunk-v0、單一事件、由事件的裝置金鑰簽章，01 Task 3 的 `buildCrowdChunk`），而不是單筆事件。原因：mesh 轉傳必須有原裝置簽的 chunk，中繼節點不能替別人簽；server 原樣保存 chunk，Android 下載後可直接 `ingestChunk` 再轉傳（07 Task 27）。

`POST /v1/crowd/rescue-events`（body：一個 crowd-rescue chunk，≤ 8192 bytes）

| 狀況 | HTTP | body |
|---|---|---|
| 新版本已接受 | 201 | `{ "result": "accepted", "event_id", "event_version" }` |
| 已存在相同 `payload_hash` | 200 | `{ "result": "already_accepted", "event_id", "event_version" }` |
| 不是 `crowd-rescue` dataset、namespace 不是 `crowd.rescue`、不是單一事件或不是 `device:` key | 400 | `{ "error": "rejected", "reason": "not_rescue_event" }` |
| 驗證失敗 | 400 | `{ "error": "rejected", "reason": <事件驗證的第一個錯誤；事件本身通過時為 chunk 錯誤> }` |
| 已過期 | 400 | `reason: "expired"` |
| `issued_at` 超前 > 5 分鐘 | 400 | `reason: "issued_in_future"` |
| 版本倒退／同版本不同內容／轉移規則 | 409 | `reason: "version_rollback" | "same_version_conflict" | <transition code>` |
| 已有另一筆 ACTIVE | 409 | `reason: "rescue_active_exists"` |
| 同時寫入衝突 | 409 | `reason: "concurrent_update"` |
| 超過 8 KB | 413 | `{ "error": "payload_too_large" }` |
| 速率限制 | 429 | `{ "error": "rate_limited", "retry_after_seconds" }`，並帶 `Retry-After` header |

`GET /v1/crowd/rescue-events?bbox=minLon,minLat,maxLon,maxLat`

| 狀況 | HTTP | body |
|---|---|---|
| 成功 | 200 | `{ "schema_version": "rescue-feed-v0", "generated_at", "chunks": [...] }`，`cache-control: no-store` |
| bbox 缺漏、非數字、反向、任一邊 > 0.05 | 400 | `{ "error": "invalid_bbox" }` |
| 速率限制（每 IP 每 10 分鐘 120 次） | 429 | 同上 |

GET 只回最新版本為 `ACTIVE` 且未過期、座標在 bbox 內的 chunk，內容與上傳時位元相同。chunk 的 `chunk_hash` 涵蓋事件的 provenance，因此 server **不改寫** provenance。

- [ ] **Step 1: 寫失敗的測試**

`server/test/crowd-rescue-api.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signEvent } from '../../pipeline/lib/contract.mjs';
import { buildCrowdChunk } from '../../pipeline/lib/crowd-report.mjs';
import { buildRescueRequest, buildRescueRevision } from '../../pipeline/lib/rescue-request.mjs';
import { buildApp } from '../src/app.mjs';
import { createRateLimiter } from '../src/rate-limit.mjs';
import { createFileRescueStore } from '../src/storage/crowd-rescue-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(await readFile(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'));
const NOW = new Date('2026-10-12T04:00:00Z');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keys(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const releaseStore = { async readFeed() { throw Object.assign(new Error('none'), { code: 'ENOENT' }); } };
const eventCase = (name) => fixture.event_cases.find((entry) => entry.name === name).event;
const v1 = eventCase('valid_v1');
const v2 = eventCase('valid_v2_update');
const device = keys(fixture.seeds.device);
/** What clients actually upload: the event wrapped in a chunk signed by its own device key. */
const chunkOf = (event, signer = device) => buildCrowdChunk(event, signer.privateKey);

async function withApp(run, { clock = () => NOW } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rescue-api-'));
  const app = buildApp({
    releaseStore,
    rescueStore: createFileRescueStore({ root }),
    rescueOptions: { now: clock, rateLimiter: createRateLimiter({ now: () => clock().getTime() }), listCacheMs: 0 },
  });
  try {
    await run(app);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

const post = (app, body, headers = {}) => app.inject({
  method: 'POST',
  url: '/v1/crowd/rescue-events',
  headers: { 'content-type': 'application/json', ...headers },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
});

test('accepts a new request once, then treats a replay as idempotent', async () => {
  await withApp(async (app) => {
    const first = await post(app, chunkOf(v1));
    assert.equal(first.statusCode, 201);
    assert.deepEqual(first.json(), { result: 'accepted', event_id: v1.event_id, event_version: 1 });
    const replay = await post(app, chunkOf(v1));
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().result, 'already_accepted');
    assert.equal((await post(app, chunkOf(v2))).statusCode, 201);
    const rollback = await post(app, chunkOf(v1));
    assert.equal(rollback.statusCode, 409);
    assert.equal(rollback.json().reason, 'version_rollback');
  });
});

test('rejects anything that is not a valid crowd.rescue chunk', async () => {
  await withApp(async (app) => {
    assert.equal((await post(app, v1)).json().reason, 'not_rescue_event'); // a bare event is not accepted
    assert.equal((await post(app, chunkOf(eventCase('official_namespace')))).json().reason, 'not_rescue_event');
    const response = await post(app, chunkOf(eventCase('tampered')));
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, 'payload_hash_mismatch');
    assert.equal((await post(app, chunkOf(eventCase('severity_mismatch')))).json().reason, 'rescue_severity_mismatch');
    const relayTampered = fixture.chunk_cases.find((entry) => entry.name === 'relay_tampered').chunk;
    assert.equal((await post(app, relayTampered)).json().reason, 'chunk_hash_mismatch');
    assert.doesNotMatch(response.body, /樓梯|121\.58|25\.06/u);
  });
});

test('enforces payload size, future issue time and one ACTIVE request per key', async () => {
  await withApp(async (app) => {
    const oversized = await post(app, JSON.stringify({ ...chunkOf(v1), padding: 'x'.repeat(9000) }));
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error, 'payload_too_large');

    const future = buildRescueRequest({
      ...fixture.inputs.create,
      issuedAt: new Date('2026-10-12T04:06:00Z'),
      requestUuid: '00000000-0000-4000-8000-0000000000f1',
      ...device,
    });
    assert.equal((await post(app, chunkOf(future))).json().reason, 'issued_in_future');

    assert.equal((await post(app, chunkOf(v1))).statusCode, 201);
    const second = buildRescueRequest({
      ...fixture.inputs.create,
      issuedAt: new Date('2026-10-12T03:30:00Z'),
      requestUuid: '00000000-0000-4000-8000-0000000000f2',
      ...device,
    });
    const conflict = await post(app, chunkOf(second));
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().reason, 'rescue_active_exists');
  });
});

test('rate limits writes per key', async () => {
  await withApp(async (app) => {
    let latest = v1;
    assert.equal((await post(app, chunkOf(latest))).statusCode, 201);
    for (const minute of ['05', '06']) {
      latest = buildRescueRevision(latest, { action: 'UPDATE', changes: {}, issuedAt: new Date(`2026-10-12T03:${minute}:00Z`), ...device });
      assert.equal((await post(app, chunkOf(latest))).statusCode, 201);
    }
    latest = buildRescueRevision(latest, { action: 'UPDATE', changes: {}, issuedAt: new Date('2026-10-12T03:07:00Z'), ...device });
    const limited = await post(app, chunkOf(latest));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) > 0);
  });
});

test('GET returns the stored chunks of ACTIVE, unexpired requests inside a small bbox', async () => {
  await withApp(async (app) => {
    await post(app, chunkOf(v1));
    const ok = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.57,25.05,121.6,25.08' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const [chunk] = ok.json().chunks;
    assert.deepEqual(chunk, chunkOf(v1));

    const outside = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.0,25.0,121.04,25.04' });
    assert.deepEqual(outside.json().chunks, []);

    for (const bbox of ['', '121,25,121.2,25.1', 'a,b,c,d', '121.6,25.0,121.57,25.04']) {
      const bad = await app.inject({ method: 'GET', url: `/v1/crowd/rescue-events?bbox=${bbox}` });
      assert.equal(bad.statusCode, 400, bbox);
      assert.equal(bad.json().error, 'invalid_bbox');
    }
  });
});

test('a forged official namespace is refused even with a valid device signature', async () => {
  await withApp(async (app) => {
    const forged = signEvent({ ...v1, namespace: 'official.ncdr' }, device.privateKey);
    assert.equal((await post(app, chunkOf(forged))).json().reason, 'not_rescue_event');
    const disguised = { ...chunkOf(v1), dataset_id: 'crowd-reports' };
    assert.equal((await post(app, disguised)).json().reason, 'not_rescue_event');
  });
});

// v3 (issued 08:30) and v4 (issued 09:00) would be "issued_in_future" at
// 04:00, so this test advances the server clock as the timeline advances.
test('GET hides resolved requests', async () => {
  let clock = NOW;
  await withApp(async (app) => {
    await post(app, chunkOf(v1));
    await post(app, chunkOf(v2));
    clock = new Date('2026-10-12T08:31:00Z');
    assert.equal((await post(app, chunkOf(eventCase('valid_v3_extend')))).statusCode, 201);
    clock = new Date('2026-10-12T09:01:00Z');
    assert.equal((await post(app, chunkOf(eventCase('valid_v4_resolved')))).statusCode, 201);
    const after = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.57,25.05,121.6,25.08' });
    assert.deepEqual(after.json().chunks, []);
  }, { clock: () => clock });
});
```

`rate limits writes per key`：server 不管本機的 30 秒冷卻，四次寫入都在同一個 60 秒窗內，第 4 次被限流。各測試用獨立的 `withApp`（新的 store 與 limiter），彼此不共用計數。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test server/test/crowd-rescue-api.test.mjs`
Expected: FAIL（路由不存在，回 404）

- [ ] **Step 3: 實作 `server/src/routes/crowd-rescue.mjs`**

```js
import { verifyCrowdChunk } from '../../../pipeline/lib/crowd-report.mjs';
import { isDeviceKeyId } from '../../../pipeline/lib/device-key.mjs';
import { RESCUE_DATASET_ID, RESCUE_NAMESPACE, rescueTransitionErrors } from '../../../pipeline/lib/rescue-contract.mjs';
import { createRateLimiter } from '../rate-limit.mjs';

const BODY_LIMIT = 8192;
const MAX_BBOX_SPAN = 0.05;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const WRITE_LIMIT_PER_KEY = { limit: 3, windowMs: 60_000 };
const WRITE_LIMIT_PER_IP = { limit: 20, windowMs: 10 * 60_000 };
const READ_LIMIT_PER_IP = { limit: 120, windowMs: 10 * 60_000 };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejected(reply, status, reason) {
  return reply.code(status).send({ error: 'rejected', reason });
}

function limited(reply, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  reply.header('retry-after', String(seconds));
  return reply.code(429).send({ error: 'rate_limited', retry_after_seconds: seconds });
}

function parseBbox(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [minLon, minLat, maxLon, maxLat] = values;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (maxLon - minLon > MAX_BBOX_SPAN || maxLat - minLat > MAX_BBOX_SPAN) return null;
  return values;
}

/** A single-event crowd-rescue chunk, before any cryptographic check. */
function looksLikeRescueChunk(chunk) {
  return isObject(chunk)
    && chunk.dataset_id === RESCUE_DATASET_ID
    && chunk.namespace === RESCUE_NAMESPACE
    && Array.isArray(chunk.events) && chunk.events.length === 1 && isObject(chunk.events[0])
    && chunk.events[0].namespace === RESCUE_NAMESPACE
    && isDeviceKeyId(chunk.signing_key_id);
}

/**
 * Rescue requests from browsers and online Android devices. The unit is the
 * crowd-rescue chunk the reporting device signed, so phones that download it
 * can relay it over the mesh unchanged. The server only verifies, stores and
 * returns those chunks; it never signs them and never logs their description
 * or coordinates.
 */
export function registerCrowdRescueRoutes(app, {
  rescueStore,
  rescueOptions: { now = () => new Date(), rateLimiter = createRateLimiter(), listCacheMs = 15_000 } = {},
}) {
  let cachedList = null;
  let cachedAt = 0;

  async function listRecords({ fresh = false } = {}) {
    const at = now().getTime();
    if (!fresh && cachedList && at - cachedAt < listCacheMs) return cachedList;
    cachedList = await rescueStore.list();
    cachedAt = at;
    return cachedList;
  }

  app.post('/v1/crowd/rescue-events', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const ipHit = rateLimiter.hit(`write-ip:${request.ip}`, WRITE_LIMIT_PER_IP.limit, WRITE_LIMIT_PER_IP.windowMs);
    if (!ipHit.allowed) return limited(reply, ipHit.retryAfterMs);

    const chunk = request.body;
    if (!looksLikeRescueChunk(chunk)) return rejected(reply, 400, 'not_rescue_event');
    const [event] = chunk.events;
    const keyHit = rateLimiter.hit(`write-key:${chunk.signing_key_id}`, WRITE_LIMIT_PER_KEY.limit, WRITE_LIMIT_PER_KEY.windowMs);
    if (!keyHit.allowed) return limited(reply, keyHit.retryAfterMs);

    const at = now();
    const verification = verifyCrowdChunk(chunk, { now: at });
    if (!verification.valid) {
      // Prefer the event's own reason (e.g. payload_hash_mismatch) over the
      // generic chunk_contains_invalid_event.
      return rejected(reply, 400, verification.eventResults?.[0]?.errors?.[0] ?? verification.errors[0]);
    }
    if (!verification.current) return rejected(reply, 400, 'expired');
    if (Date.parse(event.issued_at) - at.getTime() > FUTURE_SKEW_MS) return rejected(reply, 400, 'issued_in_future');

    const existing = await rescueStore.get(event.event_id);
    if (existing) {
      const stored = existing.record.event;
      if (stored.payload_hash === event.payload_hash) {
        return reply.code(200).send({ result: 'already_accepted', event_id: event.event_id, event_version: stored.event_version });
      }
      if (event.event_version < stored.event_version) return rejected(reply, 409, 'version_rollback');
      if (event.event_version === stored.event_version) return rejected(reply, 409, 'same_version_conflict');
      const transitionErrors = rescueTransitionErrors(stored, event);
      if (transitionErrors.length > 0) return rejected(reply, 409, transitionErrors[0]);
    } else if (event.attributes.status === 'ACTIVE') {
      const records = await listRecords({ fresh: true });
      const otherActive = records.some(({ event: other }) => other.signing_key_id === event.signing_key_id
        && other.event_id !== event.event_id
        && other.attributes?.status === 'ACTIVE'
        && Date.parse(other.expires_at) > at.getTime());
      if (otherActive) return rejected(reply, 409, 'rescue_active_exists');
    }

    try {
      await rescueStore.put(
        { event, chunk, stored_at: at.toISOString() },
        existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
      );
    } catch (error) {
      if (error.status === 412) return rejected(reply, 409, 'concurrent_update');
      throw error;
    }
    cachedList = null;
    return reply.code(201).send({ result: 'accepted', event_id: event.event_id, event_version: event.event_version });
  });

  app.get('/v1/crowd/rescue-events', async (request, reply) => {
    const ipHit = rateLimiter.hit(`read-ip:${request.ip}`, READ_LIMIT_PER_IP.limit, READ_LIMIT_PER_IP.windowMs);
    if (!ipHit.allowed) return limited(reply, ipHit.retryAfterMs);
    const bbox = parseBbox(request.query?.bbox);
    if (!bbox) return reply.code(400).send({ error: 'invalid_bbox' });
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const at = now();
    // Chunks go out exactly as uploaded: their chunk_hash covers the event,
    // provenance included, so nothing here may rewrite them.
    const chunks = (await listRecords())
      .filter(({ event }) => event.attributes?.status === 'ACTIVE' && Date.parse(event.expires_at) > at.getTime())
      .filter(({ event }) => {
        const [lon, lat] = event.geometry.coordinates;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
      })
      .map(({ chunk }) => chunk);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.code(200).send({ schema_version: 'rescue-feed-v0', generated_at: at.toISOString(), chunks });
  });
}
```

- [ ] **Step 4: 修改 `server/src/app.mjs`**

```js
import Fastify from 'fastify';

import { registerCrowdRescueRoutes } from './routes/crowd-rescue.mjs';
// ...既有 import

export function buildApp({ config = {}, releaseStore, sourceStateStore = {}, rescueStore = null, rescueOptions, logger = false } = {}) {
  // ...既有檢查
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10_000,
    // Caddy (docker-compose) or the ACA ingress is the single hop in front of
    // the API; trust exactly that hop for request.ip.
    trustProxy: 1,
  });
  // ...既有路由註冊
  if (rescueStore) registerCrowdRescueRoutes(app, { rescueStore, rescueOptions });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((error, _request, reply) => {
    // Client errors keep their status but never echo the request body.
    if (error.statusCode === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request' });
    return reply.code(500).send({ error: 'internal_error' });
  });
  return app;
}
```

`rescueOptions` 在 production 不傳，使用 route 的預設值。

- [ ] **Step 5: 執行測試確認通過**

Run: `node --test server/test/crowd-rescue-api.test.mjs server/test/api.test.mjs`
Expected: PASS（`api.test.mjs` 確認既有路由與錯誤處理不受影響；若既有測試斷言 4xx 會變 500，依新規則更新斷言並在 commit 說明）

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/crowd-rescue.mjs server/src/app.mjs server/test/crowd-rescue-api.test.mjs server/test/api.test.mjs
git commit -m "feat(server): accept and relay device-signed rescue requests"
```

---

### Task 13: 設定與組裝

**Files:**
- Modify: `server/src/config.mjs`（`loadApiConfig`、`azureStorageSettings`）
- Modify: `server/src/api-entrypoint.mjs`
- Modify: `server/src/storage/azure-runtime.mjs`
- Test: `server/test/config.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 11、Task 12
- Produces：
  - `loadApiConfig(env)` 新增 `azureCrowdContainer: string | null`（env `AZURE_CROWD_CONTAINER`，格式同 container 名稱，未設為 null）與 `crowdDataRoot: string | null`（env `CROWD_DATA_ROOT`，必須是絕對路徑）
  - `createAzureRuntimeStorage(config)` 回傳物件新增 `rescueStore`（當 `azureStorageBlobEndpoint` 與 `azureCrowdContainer` 都存在）
  - API 啟動時：有 Azure rescue store 用它；否則有 `crowdDataRoot` 用檔案 store；都沒有就不註冊路由（`/v1/crowd/rescue-events` 回 404，前端顯示「伺服器尚未開放求救接收」）

- [ ] **Step 1: 寫失敗的測試**

在 `server/test/config.test.mjs` 追加：

```js
test('API config reads the optional rescue storage settings', () => {
  const base = {
    PUBLIC_RELEASE_ROOT: '/var/lib/resilientgeo-public',
    SIGNING_PUBLIC_KEY_PEM: 'pem',
    SIGNING_KEY_ID: 'government-feed-2026',
  };
  assert.equal(loadApiConfig(base).azureCrowdContainer, null);
  assert.equal(loadApiConfig(base).crowdDataRoot, null);
  const configured = loadApiConfig({ ...base, AZURE_CROWD_CONTAINER: 'resilientgeo-crowd', CROWD_DATA_ROOT: '/var/lib/resilientgeo-crowd' });
  assert.equal(configured.azureCrowdContainer, 'resilientgeo-crowd');
  assert.equal(configured.crowdDataRoot, '/var/lib/resilientgeo-crowd');
  assert.throws(() => loadApiConfig({ ...base, AZURE_CROWD_CONTAINER: 'Bad_Name' }), /AZURE_CROWD_CONTAINER/);
  assert.throws(() => loadApiConfig({ ...base, CROWD_DATA_ROOT: 'relative/path' }), /CROWD_DATA_ROOT/);
});
```

（`loadApiConfig` 已在該檔 import；若沒有，加入 `import { loadApiConfig } from '../src/config.mjs';`。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test server/test/config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 實作**

`config.mjs` 新增：

```js
function optionalContainer(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (!/^[a-z0-9-]{3,63}$/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
```

`loadApiConfig` 回傳物件加入：

```js
    azureCrowdContainer: optionalContainer(env, 'AZURE_CROWD_CONTAINER'),
    crowdDataRoot: optionalAbsolutePath(env, 'CROWD_DATA_ROOT'),
```

`azure-runtime.mjs`：

```js
import { createAzureRescueStore } from './crowd-rescue-store.mjs';
// ...
  return Object.freeze({
    releasePointerStore: /* 不變 */,
    collectorLockProvider: /* 不變 */,
    ...(config.azureCrowdContainer
      ? { rescueStore: createAzureRescueStore({ blobClient, container: config.azureCrowdContainer }) }
      : {}),
  });
```

`api-entrypoint.mjs`：

```js
import { createFileRescueStore } from './storage/crowd-rescue-store.mjs';
// ...
const rescueStore = azureStorage.rescueStore
  ?? (config.crowdDataRoot ? createFileRescueStore({ root: config.crowdDataRoot }) : null);
const app = buildApp({
  config: { ...config, signingPublicKey: publicKey },
  releaseStore,
  rescueStore,
  sourceStateStore: { /* 不變 */ },
});
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test server/test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/config.mjs server/src/api-entrypoint.mjs server/src/storage/azure-runtime.mjs server/test/config.test.mjs
git commit -m "feat(server): wire rescue storage from configuration"
```

---

### Task 14: 部署設定

**Files:**
- Modify: `deploy/azure/main.bicep`
- Modify: `deploy/docker-compose.yml`（api 服務）
- Modify: `deploy/Dockerfile`
- Modify: `docs/central-server-runbook.md`
- Test: `server/test/deployment-config.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 13 的環境變數 `AZURE_CROWD_CONTAINER`、`CROWD_DATA_ROOT`
- Produces: Azure 私有 container `resilientgeo-crowd`、API identity 只對該 container 有 Blob Data Contributor、`rescue/` 前綴 7 天後刪除；docker-compose 的 `crowd_data` volume

- [ ] **Step 1: 寫失敗的測試**

在 `server/test/deployment-config.test.mjs` 追加：

```js
test('Azure Bicep gives the API write access only to the private crowd container', async () => {
  const bicep = await read('deploy/azure/main.bicep');
  assert.match(bicep, /resource crowdContainer 'Microsoft\.Storage\/storageAccounts\/blobServices\/containers@[^']+' = \{\s*parent: blobService\s*name: 'resilientgeo-crowd'\s*properties: \{ publicAccess: 'None' \}/u);
  assert.match(bicep, /resource apiCrowdBlobWrite 'Microsoft\.Authorization\/roleAssignments@[^']+'[\s\S]*?scope: crowdContainer[\s\S]*?roleDefinitionId: roleBlobContributor, principalId: apiIdentity\.properties\.principalId/u);
  assert.doesNotMatch(bicep, /scope: controlContainer\s*\n\s*properties: \{ roleDefinitionId: roleBlobContributor, principalId: apiIdentity/u);
  assert.match(bicep, /name: 'AZURE_CROWD_CONTAINER', value: crowdContainer\.name/u);
  assert.match(bicep, /managementPolicies[\s\S]*prefixMatch: \[\s*'resilientgeo-crowd\/rescue\/'\s*\][\s\S]*daysAfterModificationGreaterThan: 7/u);
});

test('docker-compose gives the API a writable crowd volume', async () => {
  const compose = await read('deploy/docker-compose.yml');
  assert.match(compose, /CROWD_DATA_ROOT: \/var\/lib\/resilientgeo-crowd/u);
  assert.match(compose, /- crowd_data:\/var\/lib\/resilientgeo-crowd\n/u);
  const dockerfile = await read('deploy/Dockerfile');
  assert.match(dockerfile, /mkdir -p \/var\/lib\/resilientgeo-crowd && chown node:node \/var\/lib\/resilientgeo-crowd/u);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test server/test/deployment-config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 修改 `main.bicep`**

在 `controlContainer` 之後加入：

```bicep
// Rescue requests from the public API. Private, written only by the API
// identity, and deleted seven days after their last write.
resource crowdContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'resilientgeo-crowd'
  properties: { publicAccess: 'None' }
}

resource storageLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'delete-rescue-requests'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [
                'resilientgeo-crowd/rescue/'
              ]
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 7 }
              }
            }
          }
        }
      ]
    }
  }
}
```

在 `apiBlobRead` 之後加入：

```bicep
resource apiCrowdBlobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(crowdContainer.id, apiIdentity.id, roleBlobContributor)
  scope: crowdContainer
  properties: { roleDefinitionId: roleBlobContributor, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
```

`api` 資源：`dependsOn: [apiAcrPull, apiBlobRead, apiCrowdBlobWrite, apiVaultSecrets]`；env 加入 `{ name: 'AZURE_CROWD_CONTAINER', value: crowdContainer.name }`。

- [ ] **Step 4: 修改 docker-compose 與 Dockerfile**

`deploy/docker-compose.yml` 的 `api.environment` 加 `CROWD_DATA_ROOT: /var/lib/resilientgeo-crowd`；`api.volumes` 加 `- crowd_data:/var/lib/resilientgeo-crowd`；檔尾 `volumes:` 加 `crowd_data:`。

`deploy/Dockerfile` 在 `USER root` 之前加入：

```dockerfile
# Writable by the non-root API user; docker-compose mounts the crowd_data
# volume here and copies this ownership into the new volume.
RUN mkdir -p /var/lib/resilientgeo-crowd && chown node:node /var/lib/resilientgeo-crowd
```

- [ ] **Step 5: 更新 runbook**

在 `docs/central-server-runbook.md` 的服務邊界段落後新增一節「求救接收（`/v1/crowd/rescue-events`）」，內容：

- API 只對 `resilientgeo-crowd` container（Azure）或 `crowd_data` volume（docker compose）有寫入權；`resilientgeo-control` 與 public release 仍唯讀。
- 收到的是裝置簽章的 crowd-rescue chunk，API 不簽章、不改寫內容；GET 原樣回傳進行中求救的 chunk，bbox 每邊上限 0.05 度。
- 速率限制在各 replica 記憶體中計算；ACA `maxReplicas: 2` 時實際上限最多為設定值的 2 倍。
- `rescue/` blob 在最後修改 7 天後由 lifecycle policy 刪除；docker compose 版本沒有自動刪除，需定期執行 `find /var/lib/resilientgeo-crowd/rescue -mtime +7 -delete`。
- log 不記錄描述與座標。

- [ ] **Step 6: 執行測試確認通過**

Run: `node --test server/test/deployment-config.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add deploy/azure/main.bicep deploy/docker-compose.yml deploy/Dockerfile docs/central-server-runbook.md server/test/deployment-config.test.mjs
git commit -m "chore(deploy): private crowd storage for rescue requests"
```
