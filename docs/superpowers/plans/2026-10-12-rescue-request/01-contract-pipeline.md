# 01 共用契約（pipeline）

> 總覽與 Global Constraints：[README.md](README.md)。本分冊產出 JS 端的權威實作與共用 fixture；Kotlin（02）與 Web JS（04）都以這裡的輸出為準。

模組切分：

| 檔案 | 責任 | 依賴 |
|---|---|---|
| `pipeline/lib/crowd-common.mjs`（新） | crowd 共用的座標、時間、位置提示驗證 | 無 |
| `pipeline/lib/rescue-contract.mjs`（新） | 求救常數、urgency 推導、無狀態事件驗證、狀態轉移驗證 | `crowd-common.mjs` |
| `pipeline/lib/rescue-request.mjs`（新） | 建立 v1、建立修訂版本 | `contract.mjs`、`device-key.mjs`、`rescue-contract.mjs`、`crowd-common.mjs` |
| `pipeline/lib/crowd-report.mjs`（改） | 改用 `crowd-common.mjs`；chunk 改為依 dataset profile | `rescue-contract.mjs` |
| `pipeline/lib/contract.mjs`（改） | `verifyEvent` 加 contract 階段；`ingestEvent` 加同簽章者與轉移規則 | `rescue-contract.mjs` |

`rescue-contract.mjs` 不得 import `contract.mjs` 或 `crowd-report.mjs`，避免循環引用。

---

### Task 1: crowd 共用模組與求救契約驗證器

**Files:**
- Create: `pipeline/lib/crowd-common.mjs`
- Create: `pipeline/lib/rescue-contract.mjs`
- Modify: `pipeline/lib/crowd-report.mjs:41-92`（改用 crowd-common）
- Test: `pipeline/test/rescue-contract.test.mjs`

**Interfaces:**
- Produces（`crowd-common.mjs`）：`CROWD_LOCATION_SOURCES`、`CROWD_HINT_KINDS`、`CROWD_HINT_PRECISIONS`、`CROWD_HINT_TEXT_MAX_CODE_POINTS`、`TAIWAN_REPORT_BOUNDS`、`roundCoordinate(number): number`、`isoSeconds(Date): string`、`locationHintErrors(hint): string[]`、`coordinateErrors(lon, lat): string[]`
- Produces（`rescue-contract.mjs`）：常數 `RESCUE_NAMESPACE`、`RESCUE_EVENT_TYPE`、`RESCUE_SOURCE`、`RESCUE_SOURCE_VERSION`、`RESCUE_DATASET_ID`、`RESCUE_MANIFEST_ID`、`RESCUE_TTL_MS`、`RESCUE_MAX_LIFETIME_MS`、`RESCUE_MAX_EVENT_VERSION`、`RESCUE_PEOPLE_MAX`、`RESCUE_DESCRIPTION_MAX_CODE_POINTS`、`RESCUE_REQUEST_TYPES`、`RESCUE_STATUSES`、`RESCUE_SUBJECTS`、`RESCUE_TRIAGE_FIELDS`、`RESCUE_TRIAGE_ANSWERS`；函式 `deriveRescueUrgency(requestType, triage): 'CRITICAL'|'HIGH'|'MEDIUM'`、`rescueEventIdPrefix(signingKeyId): string`、`isRescueTerminal(status): boolean`、`rescueFieldErrors(input): string[]`、`rescueEventErrors(event): string[]`、`rescueTransitionErrors(stored, incoming): string[]`

錯誤代碼（Kotlin 與 Web 必須逐字相同）：

| 代碼 | 意義 |
|---|---|
| `rescue_identity_invalid` | namespace／event_type／source／source_version／area_id／theme 不符 |
| `rescue_event_id_unbound` | event_id 格式錯或指紋與簽章者不符 |
| `rescue_geometry_invalid` | 不是 2 維 Point 或座標超出範圍 |
| `rescue_attributes_unknown` | attributes 出現允許清單外的 key |
| `rescue_field_invalid:<field>` | 欄位值不合法，`<field>` 為 wire 名稱 |
| `rescue_severity_mismatch` | severity 與推導結果不同 |
| `rescue_version_too_high` | event_version > 200 |
| `rescue_time_invalid` | first_issued_at 晚於 issued_at，或 v1 時兩者不同，或 expires_at ≤ issued_at |
| `rescue_ttl_too_long` | expires_at − issued_at > 6h |
| `rescue_lifetime_exceeded` | expires_at > first_issued_at + 72h |
| `signer_mismatch` | 更新的簽章者與已儲存版本不同（所有 `crowd.*`） |
| `rescue_terminal` | 已儲存版本為終態 |
| `rescue_terminal_expiry_changed` | 終態版本改了 expires_at |
| `rescue_first_issued_changed` | first_issued_at 與已儲存版本不同 |

- [ ] **Step 1: 寫失敗的測試**

`pipeline/test/rescue-contract.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveRescueUrgency,
  rescueEventErrors,
  rescueEventIdPrefix,
  rescueFieldErrors,
  rescueTransitionErrors,
} from '../lib/rescue-contract.mjs';

const KEY_ID = `device:${'a'.repeat(32)}`;
const triage = (overrides = {}) => ({
  immobile: 'NO',
  breathing_difficulty: 'NO',
  severe_bleeding: 'NO',
  conscious: 'YES',
  ...overrides,
});
const input = (overrides = {}) => ({
  requestType: 'TRAPPED',
  subject: 'OTHERS',
  peopleCount: 2,
  triage: triage(),
  description: '一樓樓梯間',
  lon: 121.588123,
  lat: 25.069876,
  locationSource: 'CURRENT_LOCATION',
  ...overrides,
});

function event(overrides = {}, attributeOverrides = {}) {
  return {
    schema_version: 'event-v0',
    namespace: 'crowd.rescue',
    event_id: `${rescueEventIdPrefix(KEY_ID)}00000000-0000-4000-8000-000000000001`,
    event_type: 'RESCUE_REQUEST',
    geometry: { type: 'Point', coordinates: [121.588123, 25.069876] },
    severity: 'HIGH',
    source: 'CROWD',
    source_version: 'rescue-request-v0',
    event_version: 1,
    issued_at: '2026-10-12T03:00:00Z',
    expires_at: '2026-10-12T09:00:00Z',
    attributes: {
      request_type: 'TRAPPED',
      status: 'ACTIVE',
      subject: 'OTHERS',
      people_count: 2,
      triage: triage(),
      description: '一樓樓梯間',
      location_source: 'CURRENT_LOCATION',
      first_issued_at: '2026-10-12T03:00:00Z',
      area_id: 'crowd',
      theme: 'rescue',
      ...attributeOverrides,
    },
    signing_key_id: KEY_ID,
    ...overrides,
  };
}

test('urgency follows the approved table and ignores people count', () => {
  assert.equal(deriveRescueUrgency('TRAPPED_DEBRIS', triage()), 'CRITICAL');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ breathing_difficulty: 'YES' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ severe_bleeding: 'YES' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('OTHER_RESCUE', triage({ conscious: 'NO' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('TRAPPED', triage()), 'HIGH');
  assert.equal(deriveRescueUrgency('IMMOBILE', triage()), 'HIGH');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ immobile: 'YES' })), 'HIGH');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage()), 'MEDIUM');
  assert.equal(deriveRescueUrgency('OTHER_RESCUE', triage({ conscious: 'UNKNOWN', breathing_difficulty: 'UNKNOWN' })), 'MEDIUM');
});

test('field validation rejects what no form may send', () => {
  assert.deepEqual(rescueFieldErrors(input()), []);
  assert.deepEqual(rescueFieldErrors(input({ requestType: 'TRAPPED_INJURED' })), ['rescue_field_invalid:request_type']);
  assert.deepEqual(rescueFieldErrors(input({ subject: 'ME' })), ['rescue_field_invalid:subject']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 0 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 51 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 1.5 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ triage: triage({ immobile: 'MAYBE' }) })), ['rescue_field_invalid:triage']);
  assert.deepEqual(rescueFieldErrors(input({ subject: 'SELF', triage: triage({ conscious: 'NO' }) })), ['rescue_field_invalid:triage']);
  assert.deepEqual(rescueFieldErrors(input({ description: '字'.repeat(161) })), ['rescue_field_invalid:description']);
  assert.deepEqual(rescueFieldErrors(input({ description: `  ${'字'.repeat(160)}  ` })), []);
  assert.deepEqual(rescueFieldErrors(input({ lon: 139.69, lat: 35.68 })), ['rescue_geometry_invalid']);
  assert.deepEqual(rescueFieldErrors(input({ locationSource: 'GPS' })), ['rescue_field_invalid:location_source']);
  assert.deepEqual(
    rescueFieldErrors(input({ locationHint: { method: 'ADDRESS', query: 'x', label: 'x', kind: 'STREET', precision: 'ROAD' } })),
    ['rescue_field_invalid:location_hint'],
  );
});

test('a well-formed v1 has no contract errors', () => {
  assert.deepEqual(rescueEventErrors(event()), []);
});

test('event-level rules', () => {
  assert.deepEqual(rescueEventErrors(event({ source: 'OTHER' })), ['rescue_identity_invalid']);
  assert.deepEqual(rescueEventErrors(event({}, { theme: 'report' })), ['rescue_identity_invalid']);
  assert.deepEqual(
    rescueEventErrors(event({ event_id: `rescue:${'b'.repeat(32)}:00000000-0000-4000-8000-000000000001` })),
    ['rescue_event_id_unbound'],
  );
  assert.deepEqual(rescueEventErrors(event({ geometry: { type: 'LineString', coordinates: [[121, 25], [121.1, 25]] } })), ['rescue_geometry_invalid']);
  assert.deepEqual(rescueEventErrors(event({}, { phone: '0912000000' })), ['rescue_attributes_unknown']);
  assert.deepEqual(rescueEventErrors(event({}, { status: 'EXPIRED' })), ['rescue_field_invalid:status']);
  assert.deepEqual(rescueEventErrors(event({ severity: 'CRITICAL' })), ['rescue_severity_mismatch']);
  assert.deepEqual(rescueEventErrors(event({ event_version: 201 })), ['rescue_version_too_high']);
  assert.deepEqual(rescueEventErrors(event({}, { first_issued_at: '2026-10-12T02:00:00Z' })), ['rescue_time_invalid']);
  assert.deepEqual(rescueEventErrors(event({ expires_at: '2026-10-12T09:00:01Z' })), ['rescue_ttl_too_long']);
  assert.deepEqual(
    rescueEventErrors(event(
      { event_version: 2, issued_at: '2026-10-15T00:30:00Z', expires_at: '2026-10-15T06:00:00Z' },
      { first_issued_at: '2026-10-12T03:00:00Z' },
    )),
    ['rescue_lifetime_exceeded'],
  );
});

test('transition rules', () => {
  const v1 = event();
  const v2 = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' });
  assert.deepEqual(rescueTransitionErrors(v1, v2), []);
  assert.deepEqual(rescueTransitionErrors(v1, { ...v2, signing_key_id: `device:${'c'.repeat(32)}` }), ['signer_mismatch']);
  const resolved = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' }, { status: 'RESOLVED' });
  assert.deepEqual(rescueTransitionErrors(resolved, event({ event_version: 3, issued_at: '2026-10-12T03:20:00Z' })), ['rescue_terminal']);
  const shortened = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z', expires_at: '2026-10-12T04:00:00Z' }, { status: 'CANCELLED' });
  assert.deepEqual(rescueTransitionErrors(v1, shortened), ['rescue_terminal_expiry_changed']);
  const moved = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' }, { first_issued_at: '2026-10-12T02:59:00Z' });
  assert.deepEqual(rescueTransitionErrors(v1, moved), ['rescue_first_issued_changed']);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/rescue-contract.test.mjs`
Expected: FAIL，`Cannot find module '../lib/rescue-contract.mjs'`

- [ ] **Step 3: 建立 `pipeline/lib/crowd-common.mjs`**

把 `crowd-report.mjs` 第 41–92 行的共用部分搬過來，錯誤字串保持逐字相同：

```js
/**
 * Shared by crowd reports and rescue requests. Pure module with no imports so
 * the event contract can depend on it without an import cycle.
 */

export const CROWD_LOCATION_SOURCES = Object.freeze(['CURRENT_LOCATION', 'MAP_PICK']);
export const CROWD_HINT_KINDS = Object.freeze(['COUNTY', 'DISTRICT', 'VILLAGE', 'ROAD', 'FACILITY']);
export const CROWD_HINT_PRECISIONS = Object.freeze(['AREA', 'ROAD', 'POINT']);
export const CROWD_HINT_TEXT_MAX_CODE_POINTS = 80;

/**
 * Taiwan including Penghu, Kinmen, Matsu, Green/Orchid Island and Pratas.
 * Reports outside it are rejected rather than relayed.
 */
export const TAIWAN_REPORT_BOUNDS = Object.freeze([116.5, 20.5, 122.5, 26.8]);

export function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

export function isoSeconds(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function locationHintErrors(hint) {
  if (hint === undefined || hint === null) return [];
  if (typeof hint !== 'object' || Array.isArray(hint)) return ['location_hint must be an object'];
  const errors = [];
  if (hint.method !== 'ADDRESS') errors.push('location_hint.method must be ADDRESS');
  if (!CROWD_HINT_KINDS.includes(hint.kind)) errors.push('location_hint.kind is invalid');
  if (!CROWD_HINT_PRECISIONS.includes(hint.precision)) errors.push('location_hint.precision is invalid');
  for (const field of ['query', 'label']) {
    const value = hint[field];
    if (typeof value !== 'string' || [...value].length > CROWD_HINT_TEXT_MAX_CODE_POINTS) {
      errors.push(`location_hint.${field} must be a string of at most ${CROWD_HINT_TEXT_MAX_CODE_POINTS} characters`);
    }
  }
  return errors;
}

export function coordinateErrors(lon, lat) {
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return ['location must be finite numbers'];
  }
  const [minLon, minLat, maxLon, maxLat] = TAIWAN_REPORT_BOUNDS;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return ['location is outside the supported area'];
  return [];
}
```

- [ ] **Step 4: `crowd-report.mjs` 改用 crowd-common**

刪除 `crowd-report.mjs` 中 `CROWD_LOCATION_SOURCES` 到 `locationHintErrors` 的定義（第 41–74 行），改為：

```js
import {
  CROWD_HINT_KINDS,
  CROWD_HINT_PRECISIONS,
  CROWD_HINT_TEXT_MAX_CODE_POINTS,
  CROWD_LOCATION_SOURCES,
  TAIWAN_REPORT_BOUNDS,
  coordinateErrors,
  isoSeconds,
  locationHintErrors,
  roundCoordinate,
} from './crowd-common.mjs';

export {
  CROWD_HINT_KINDS,
  CROWD_HINT_PRECISIONS,
  CROWD_HINT_TEXT_MAX_CODE_POINTS,
  CROWD_LOCATION_SOURCES,
  TAIWAN_REPORT_BOUNDS,
};
```

`crowdReportErrors` 的座標分支改為 `errors.push(...coordinateErrors(lon, lat));`，其餘不變。

Run: `node --test pipeline/test/crowd-signature.test.mjs pipeline/test/attest.test.mjs`
Expected: PASS（行為不變）

- [ ] **Step 5: 建立 `pipeline/lib/rescue-contract.mjs`**

```js
import {
  CROWD_LOCATION_SOURCES,
  coordinateErrors,
  locationHintErrors,
} from './crowd-common.mjs';

/**
 * Rescue requests (docs/data-contract-v0.md「求救事件」). Kotlin mirror:
 * `report/RescueContract.kt`; Web mirror: `flutter/web/rescue_outbox.js`.
 * Error codes are part of the contract and must match across all three.
 */

export const RESCUE_NAMESPACE = 'crowd.rescue';
export const RESCUE_EVENT_TYPE = 'RESCUE_REQUEST';
export const RESCUE_SOURCE = 'CROWD';
export const RESCUE_SOURCE_VERSION = 'rescue-request-v0';
export const RESCUE_DATASET_ID = 'crowd-rescue';
export const RESCUE_MANIFEST_ID = 'crowd-rescue:none';
export const RESCUE_TTL_MS = 6 * 60 * 60 * 1000;
export const RESCUE_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const RESCUE_MAX_EVENT_VERSION = 200;
export const RESCUE_PEOPLE_MAX = 50;
export const RESCUE_DESCRIPTION_MAX_CODE_POINTS = 160;

export const RESCUE_REQUEST_TYPES = Object.freeze(['FIRST_AID_NEEDED', 'IMMOBILE', 'TRAPPED', 'TRAPPED_DEBRIS', 'OTHER_RESCUE']);
export const RESCUE_STATUSES = Object.freeze(['ACTIVE', 'RESOLVED', 'CANCELLED']);
export const RESCUE_SUBJECTS = Object.freeze(['SELF', 'OTHERS']);
export const RESCUE_TRIAGE_FIELDS = Object.freeze(['immobile', 'breathing_difficulty', 'severe_bleeding', 'conscious']);
export const RESCUE_TRIAGE_ANSWERS = Object.freeze(['YES', 'NO', 'UNKNOWN']);

const ATTRIBUTE_KEYS = new Set([
  'request_type', 'status', 'subject', 'people_count', 'triage', 'description',
  'location_source', 'location_hint', 'first_issued_at', 'area_id', 'theme',
]);
const EVENT_ID_RE = /^rescue:([0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveRescueUrgency(requestType, triage) {
  if (requestType === 'TRAPPED_DEBRIS') return 'CRITICAL';
  if (triage?.breathing_difficulty === 'YES' || triage?.severe_bleeding === 'YES' || triage?.conscious === 'NO') {
    return 'CRITICAL';
  }
  if (requestType === 'TRAPPED' || requestType === 'IMMOBILE' || triage?.immobile === 'YES') return 'HIGH';
  return 'MEDIUM';
}

export function rescueEventIdPrefix(signingKeyId) {
  return `rescue:${signingKeyId.slice('device:'.length)}:`;
}

export function isRescueTerminal(status) {
  return status === 'RESOLVED' || status === 'CANCELLED';
}

function triageValid(triage, subject) {
  if (triage === null || typeof triage !== 'object' || Array.isArray(triage)) return false;
  const keys = Object.keys(triage);
  if (keys.length !== RESCUE_TRIAGE_FIELDS.length || !RESCUE_TRIAGE_FIELDS.every((field) => keys.includes(field))) {
    return false;
  }
  if (!RESCUE_TRIAGE_FIELDS.every((field) => RESCUE_TRIAGE_ANSWERS.includes(triage[field]))) return false;
  return subject !== 'SELF' || triage.conscious === 'YES';
}

/**
 * Form-level checks shared by the builders and the event validator. Returns
 * at most one code per field, in a fixed order, so every implementation
 * reports the same first error.
 */
export function rescueFieldErrors({
  requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint,
}) {
  const errors = [];
  if (!RESCUE_REQUEST_TYPES.includes(requestType)) errors.push('rescue_field_invalid:request_type');
  if (!RESCUE_SUBJECTS.includes(subject)) errors.push('rescue_field_invalid:subject');
  if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > RESCUE_PEOPLE_MAX) {
    errors.push('rescue_field_invalid:people_count');
  }
  if (!triageValid(triage, subject)) errors.push('rescue_field_invalid:triage');
  if (typeof description !== 'string' || [...description.trim()].length > RESCUE_DESCRIPTION_MAX_CODE_POINTS) {
    errors.push('rescue_field_invalid:description');
  }
  if (!CROWD_LOCATION_SOURCES.includes(locationSource)) errors.push('rescue_field_invalid:location_source');
  if (locationHintErrors(locationHint).length > 0) errors.push('rescue_field_invalid:location_hint');
  if (coordinateErrors(lon, lat).length > 0) errors.push('rescue_geometry_invalid');
  return errors;
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Stateless rules for one crowd.rescue event. Assumes validateEventShape()
 * already passed. Returns the first failing code only.
 */
export function rescueEventErrors(event) {
  const attributes = event.attributes ?? {};
  if (event.namespace !== RESCUE_NAMESPACE || event.event_type !== RESCUE_EVENT_TYPE
    || event.source !== RESCUE_SOURCE || event.source_version !== RESCUE_SOURCE_VERSION
    || attributes.area_id !== 'crowd' || attributes.theme !== 'rescue') {
    return ['rescue_identity_invalid'];
  }
  const match = EVENT_ID_RE.exec(event.event_id);
  if (!match || `device:${match[1]}` !== event.signing_key_id) return ['rescue_event_id_unbound'];
  const geometry = event.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
    return ['rescue_geometry_invalid'];
  }
  if (Object.keys(attributes).some((key) => !ATTRIBUTE_KEYS.has(key))) return ['rescue_attributes_unknown'];
  const fieldErrors = rescueFieldErrors({
    requestType: attributes.request_type,
    subject: attributes.subject,
    peopleCount: attributes.people_count,
    triage: attributes.triage,
    description: attributes.description,
    lon: geometry.coordinates[0],
    lat: geometry.coordinates[1],
    locationSource: attributes.location_source,
    locationHint: attributes.location_hint,
  });
  if (fieldErrors.length > 0) return [fieldErrors[0]];
  if (!RESCUE_STATUSES.includes(attributes.status)) return ['rescue_field_invalid:status'];
  if (event.severity !== deriveRescueUrgency(attributes.request_type, attributes.triage)) {
    return ['rescue_severity_mismatch'];
  }
  if (event.event_version > RESCUE_MAX_EVENT_VERSION) return ['rescue_version_too_high'];
  const issued = time(event.issued_at);
  const expires = time(event.expires_at);
  const first = time(attributes.first_issued_at);
  if (issued === null || expires === null || first === null || first > issued || expires <= issued
    || (event.event_version === 1 && first !== issued)) {
    return ['rescue_time_invalid'];
  }
  if (expires - issued > RESCUE_TTL_MS) return ['rescue_ttl_too_long'];
  if (expires > first + RESCUE_MAX_LIFETIME_MS) return ['rescue_lifetime_exceeded'];
  return [];
}

/** Rules that need the stored version. `stored` and `incoming` are full events. */
export function rescueTransitionErrors(stored, incoming) {
  if (stored.signing_key_id !== incoming.signing_key_id) return ['signer_mismatch'];
  if (isRescueTerminal(stored.attributes?.status)) return ['rescue_terminal'];
  if (isRescueTerminal(incoming.attributes?.status) && incoming.expires_at !== stored.expires_at) {
    return ['rescue_terminal_expiry_changed'];
  }
  if (incoming.attributes?.first_issued_at !== stored.attributes?.first_issued_at) {
    return ['rescue_first_issued_changed'];
  }
  return [];
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `node --test pipeline/test/rescue-contract.test.mjs pipeline/test/crowd-signature.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-12-rescue-request-design.md docs/superpowers/plans/2026-10-12-rescue-request pipeline/lib/crowd-common.mjs pipeline/lib/rescue-contract.mjs pipeline/lib/crowd-report.mjs pipeline/test/rescue-contract.test.mjs
git commit -m "feat(contract): add rescue request contract validators"
```

---

### Task 2: 求救事件與修訂建構器

**Files:**
- Create: `pipeline/lib/rescue-request.mjs`
- Test: `pipeline/test/rescue-request.test.mjs`

**Interfaces:**
- Consumes: Task 1 全部；`signEvent(event, privateKey)`（contract.mjs）；`deviceKeyIdForPublicKey`、`publicKeySpkiBase64`（device-key.mjs）
- Produces:
  - `buildRescueRequest({ requestType, subject, peopleCount, triage, description = '', lon, lat, locationSource, locationHint, issuedAt = new Date(), requestUuid = randomUUID(), privateKey, publicKey, nodeId }) → signed event`
  - `RESCUE_ACTIONS = ['UPDATE', 'EXTEND', 'RESOLVE', 'CANCEL']`
  - `buildRescueRevision(previous, { action, changes = {}, issuedAt = new Date(), privateKey, publicKey, nodeId }) → signed event`；`changes` 只在 `UPDATE` 使用，鍵名與 `buildRescueRequest` 相同（camelCase），未提供的鍵沿用前一版
  - `rescueInputFromEvent(event) → { requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint }`
  - 拋出 `RangeError`，訊息為錯誤代碼或下列字串之一：`rescue_revision_wrong_device`、`rescue_revision_terminal`、`rescue_revision_expired`、`rescue_extend_not_later`、`rescue_action_invalid`

- [ ] **Step 1: 寫失敗的測試**

`pipeline/test/rescue-request.test.mjs`：

```js
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { verifyEvent } from '../lib/contract.mjs';
import { buildRescueRequest, buildRescueRevision } from '../lib/rescue-request.mjs';
import { rescueEventErrors } from '../lib/rescue-contract.mjs';

const NOW = '2026-10-12T04:00:00Z';
const device = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const triage = { immobile: 'YES', breathing_difficulty: 'NO', severe_bleeding: 'UNKNOWN', conscious: 'YES' };

function create(overrides = {}) {
  return buildRescueRequest({
    requestType: 'TRAPPED_DEBRIS',
    subject: 'SELF',
    peopleCount: 2,
    triage,
    description: '  一樓樓梯間，敲牆有回應  ',
    lon: 121.5881234,
    lat: 25.0698764,
    locationSource: 'CURRENT_LOCATION',
    issuedAt: new Date('2026-10-12T03:00:00.900Z'),
    requestUuid: '00000000-0000-4000-8000-0000000000AA',
    privateKey: device.privateKey,
    publicKey: device.publicKey,
    ...overrides,
  });
}

const revise = (previous, action, issuedAt, changes, keys = device) => buildRescueRevision(previous, {
  action, changes, issuedAt: new Date(issuedAt), privateKey: keys.privateKey, publicKey: keys.publicKey,
});

test('v1 is signed, bound to the device and passes the contract', () => {
  const event = create();
  assert.equal(event.namespace, 'crowd.rescue');
  assert.equal(event.event_type, 'RESCUE_REQUEST');
  assert.equal(event.event_id, `rescue:${event.signing_key_id.slice(7)}:00000000-0000-4000-8000-0000000000aa`);
  assert.equal(event.severity, 'CRITICAL');
  assert.equal(event.issued_at, '2026-10-12T03:00:00Z');
  assert.equal(event.expires_at, '2026-10-12T09:00:00Z');
  assert.deepEqual(event.geometry.coordinates, [121.588123, 25.069876]);
  assert.equal(event.attributes.description, '一樓樓梯間，敲牆有回應');
  assert.equal(event.attributes.first_issued_at, '2026-10-12T03:00:00Z');
  assert.equal(event.attributes.status, 'ACTIVE');
  assert.equal(event.provenance.transport_source.kind, 'local_report');
  assert.deepEqual(rescueEventErrors(event), []);
  assert.equal(verifyEvent(event, null, { now: NOW }).valid, true);
});

test('SELF requests are always recorded as conscious', () => {
  const event = create({ triage: { ...triage, conscious: 'UNKNOWN' } });
  assert.equal(event.attributes.triage.conscious, 'YES');
});

test('builder refuses invalid input instead of signing it', () => {
  assert.throws(() => create({ requestType: 'TRAPPED_INJURED' }), /rescue_field_invalid:request_type/);
  assert.throws(() => create({ peopleCount: 0 }), /rescue_field_invalid:people_count/);
  assert.throws(() => create({ lon: 139.69, lat: 35.68 }), /rescue_geometry_invalid/);
});

test('UPDATE keeps expiry, re-derives urgency and bumps the version', () => {
  const v1 = create({ requestType: 'FIRST_AID_NEEDED', triage: { ...triage, immobile: 'NO' } });
  assert.equal(v1.severity, 'MEDIUM');
  const v2 = revise(v1, 'UPDATE', '2026-10-12T03:10:00Z', { triage: { ...triage, severe_bleeding: 'YES' }, peopleCount: 3 });
  assert.equal(v2.event_version, 2);
  assert.equal(v2.event_id, v1.event_id);
  assert.equal(v2.severity, 'CRITICAL');
  assert.equal(v2.attributes.people_count, 3);
  assert.equal(v2.expires_at, v1.expires_at);
  assert.equal(v2.attributes.first_issued_at, v1.attributes.first_issued_at);
  assert.equal(verifyEvent(v2, null, { now: NOW }).valid, true);
});

test('EXTEND moves expiry forward but never past 72 hours', () => {
  const v1 = create();
  const v2 = revise(v1, 'EXTEND', '2026-10-12T08:30:00Z');
  assert.equal(v2.expires_at, '2026-10-12T14:30:00Z');
  let latest = v2;
  for (const issued of ['2026-10-12T14:00:00Z', '2026-10-12T19:50:00Z', '2026-10-13T01:40:00Z',
    '2026-10-13T07:30:00Z', '2026-10-13T13:20:00Z', '2026-10-13T19:10:00Z', '2026-10-14T01:00:00Z',
    '2026-10-14T06:50:00Z', '2026-10-14T12:40:00Z', '2026-10-14T18:30:00Z']) {
    latest = revise(latest, 'EXTEND', issued);
  }
  assert.equal(latest.expires_at, '2026-10-15T00:30:00Z');
  // The next extension is capped at first_issued_at + 72h …
  latest = revise(latest, 'EXTEND', '2026-10-15T00:00:00Z');
  assert.equal(latest.expires_at, '2026-10-15T03:00:00Z');
  // … and once at the cap there is nothing left to extend.
  assert.throws(() => revise(latest, 'EXTEND', '2026-10-15T02:00:00Z'), /rescue_extend_not_later/);
});

test('RESOLVE and CANCEL keep expiry and end the lifecycle', () => {
  const v1 = create();
  const resolved = revise(v1, 'RESOLVE', '2026-10-12T05:00:00Z');
  assert.equal(resolved.attributes.status, 'RESOLVED');
  assert.equal(resolved.expires_at, v1.expires_at);
  assert.throws(() => revise(resolved, 'UPDATE', '2026-10-12T05:10:00Z'), /rescue_revision_terminal/);
  const cancelled = revise(v1, 'CANCEL', '2026-10-12T05:00:00Z');
  assert.equal(cancelled.attributes.status, 'CANCELLED');
});

test('only the original device may revise, and only before expiry', () => {
  const v1 = create();
  assert.throws(() => revise(v1, 'RESOLVE', '2026-10-12T05:00:00Z', {}, other), /rescue_revision_wrong_device/);
  assert.throws(() => revise(v1, 'UPDATE', '2026-10-12T09:00:00Z'), /rescue_revision_expired/);
  assert.throws(() => revise(v1, 'DELETE', '2026-10-12T05:00:00Z'), /rescue_action_invalid/);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/rescue-request.test.mjs`
Expected: FAIL，`Cannot find module '../lib/rescue-request.mjs'`

- [ ] **Step 3: 實作 `pipeline/lib/rescue-request.mjs`**

```js
import { randomUUID } from 'node:crypto';

import { signEvent } from './contract.mjs';
import { isoSeconds, roundCoordinate } from './crowd-common.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from './device-key.mjs';
import {
  RESCUE_EVENT_TYPE,
  RESCUE_MAX_LIFETIME_MS,
  RESCUE_NAMESPACE,
  RESCUE_SOURCE,
  RESCUE_SOURCE_VERSION,
  RESCUE_TTL_MS,
  deriveRescueUrgency,
  isRescueTerminal,
  rescueEventIdPrefix,
  rescueFieldErrors,
} from './rescue-contract.mjs';

/**
 * Builds and device-signs rescue requests. Mirrors `RescueRequestFactory`
 * (Android) and `rescue_outbox.js` (Web); `fixtures/rescue-requests-v0.json`
 * pins all three.
 */

export const RESCUE_ACTIONS = Object.freeze(['UPDATE', 'EXTEND', 'RESOLVE', 'CANCEL']);

function normalizedTriage(subject, triage) {
  return {
    immobile: triage.immobile,
    breathing_difficulty: triage.breathing_difficulty,
    severe_bleeding: triage.severe_bleeding,
    conscious: subject === 'SELF' ? 'YES' : triage.conscious,
  };
}

function attributesFor(input, status, firstIssuedAt) {
  const attributes = {
    request_type: input.requestType,
    status,
    subject: input.subject,
    people_count: input.peopleCount,
    triage: normalizedTriage(input.subject, input.triage),
    description: input.description.trim(),
    location_source: input.locationSource,
    first_issued_at: firstIssuedAt,
    area_id: 'crowd',
    theme: 'rescue',
  };
  if (input.locationHint) {
    const hint = input.locationHint;
    attributes.location_hint = {
      method: hint.method, query: hint.query, label: hint.label, kind: hint.kind, precision: hint.precision,
    };
  }
  return attributes;
}

function assembleAndSign({ input, eventId, version, issued, expires, status, firstIssuedAt, privateKey, publicKey, nodeId }) {
  const errors = rescueFieldErrors({ ...input, triage: normalizedTriage(input.subject ?? '', input.triage ?? {}) });
  if (errors.length > 0) throw new RangeError(errors.join('; '));
  const attributes = attributesFor(input, status, firstIssuedAt);
  const event = {
    schema_version: 'event-v0',
    namespace: RESCUE_NAMESPACE,
    event_id: eventId,
    event_type: RESCUE_EVENT_TYPE,
    geometry: { type: 'Point', coordinates: [roundCoordinate(input.lon), roundCoordinate(input.lat)] },
    severity: deriveRescueUrgency(attributes.request_type, attributes.triage),
    source: RESCUE_SOURCE,
    source_version: RESCUE_SOURCE_VERSION,
    event_version: version,
    issued_at: issued,
    expires_at: expires,
    attributes,
    signing_key_id: deviceKeyIdForPublicKey(publicKey),
    signer_public_key: publicKeySpkiBase64(publicKey),
    provenance: {
      original_source: 'crowd-app',
      received_at: issued,
      transport_source: nodeId ? { kind: 'local_report', node_id: nodeId } : { kind: 'local_report' },
    },
  };
  return signEvent(event, privateKey);
}

export function buildRescueRequest({
  requestType, subject, peopleCount, triage, description = '', lon, lat, locationSource, locationHint,
  issuedAt = new Date(), requestUuid = randomUUID(), privateKey, publicKey, nodeId,
}) {
  const issuedDate = new Date(issuedAt);
  const issued = isoSeconds(issuedDate);
  const keyId = deviceKeyIdForPublicKey(publicKey);
  return assembleAndSign({
    input: { requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint },
    eventId: `${rescueEventIdPrefix(keyId)}${requestUuid.toLowerCase()}`,
    version: 1,
    issued,
    expires: isoSeconds(new Date(Date.parse(issued) + RESCUE_TTL_MS)),
    status: 'ACTIVE',
    firstIssuedAt: issued,
    privateKey,
    publicKey,
    nodeId,
  });
}

export function rescueInputFromEvent(event) {
  const attributes = event.attributes;
  return {
    requestType: attributes.request_type,
    subject: attributes.subject,
    peopleCount: attributes.people_count,
    triage: { ...attributes.triage },
    description: attributes.description,
    lon: event.geometry.coordinates[0],
    lat: event.geometry.coordinates[1],
    locationSource: attributes.location_source,
    locationHint: attributes.location_hint ? { ...attributes.location_hint } : undefined,
  };
}

export function buildRescueRevision(previous, {
  action, changes = {}, issuedAt = new Date(), privateKey, publicKey, nodeId,
}) {
  if (!RESCUE_ACTIONS.includes(action)) throw new RangeError('rescue_action_invalid');
  if (deviceKeyIdForPublicKey(publicKey) !== previous.signing_key_id) throw new RangeError('rescue_revision_wrong_device');
  if (isRescueTerminal(previous.attributes.status)) throw new RangeError('rescue_revision_terminal');
  const issued = isoSeconds(new Date(issuedAt));
  const issuedMs = Date.parse(issued);
  const previousExpires = Date.parse(previous.expires_at);
  if (issuedMs >= previousExpires) throw new RangeError('rescue_revision_expired');

  const base = rescueInputFromEvent(previous);
  const input = action === 'UPDATE' ? { ...base, ...changes } : base;
  const firstIssuedAt = previous.attributes.first_issued_at;
  let expires = previous.expires_at;
  if (action === 'EXTEND') {
    const extended = Math.min(issuedMs + RESCUE_TTL_MS, Date.parse(firstIssuedAt) + RESCUE_MAX_LIFETIME_MS);
    if (extended <= previousExpires) throw new RangeError('rescue_extend_not_later');
    expires = isoSeconds(new Date(extended));
  }
  const status = action === 'RESOLVE' ? 'RESOLVED' : action === 'CANCEL' ? 'CANCELLED' : 'ACTIVE';
  return assembleAndSign({
    input,
    eventId: previous.event_id,
    version: previous.event_version + 1,
    issued,
    expires,
    status,
    firstIssuedAt,
    privateKey,
    publicKey,
    nodeId,
  });
}
```

說明：`assembleAndSign` 先正規化 triage 再驗證，使 `SELF` 搭配 `conscious: 'UNKNOWN'` 的輸入會被記成 `YES`，而不是被拒；`SELF` 搭配 `conscious: 'NO'` 也會被正規化成 `YES`（表單本來就不會在 SELF 時問這題）。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test pipeline/test/rescue-request.test.mjs`
Expected: PASS。若 `verifyEvent` 相關測試失敗，是因為 contract 階段尚未接上（Task 3）；本任務只要求 `rescueEventErrors` 與簽章驗證通過，`verifyEvent(...).valid` 在 Task 3 前也應為 true（尚未有 contract 檢查）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/rescue-request.mjs pipeline/test/rescue-request.test.mjs
git commit -m "feat(contract): build and revise signed rescue requests"
```

---

### Task 3: contract 階段、套用規則與通用 crowd chunk

**Files:**
- Modify: `pipeline/lib/contract.mjs:155-186`（`verifyEvent`）、`:305-351`（`ingestEvent`）
- Modify: `pipeline/lib/crowd-report.mjs:152-230`（`buildCrowdChunk`、`verifyCrowdChunk`）
- Test: `pipeline/test/rescue-request.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1、Task 2
- Produces:
  - `verifyEvent` 對 `crowd.rescue` 在簽章通過後執行 `rescueEventErrors`，失敗回 `{ valid: false, stage: 'contract', errors: [code], current: false }`
  - `ingestEvent` 新的拒收 reason：`signer_mismatch`（所有 `crowd.*` 更新）、`rescue_terminal`、`rescue_terminal_expiry_changed`、`rescue_first_issued_changed`
  - `CROWD_CHUNK_PROFILES`：`{ 'crowd-reports': { manifestId: 'crowd:none', chunkPrefix: 'crowd:', theme: 'report' }, 'crowd-rescue': { manifestId: 'crowd-rescue:none', chunkPrefix: 'crowd-rescue:', theme: 'rescue' } }`
  - `buildCrowdChunk(event, privateKey)` 依 `event.namespace` 選 profile（`crowd.rescue` → `crowd-rescue`，其他 → `crowd-reports`）；`verifyCrowdChunk(chunk, options)` 依 `chunk.dataset_id` 選 profile，`crowd-rescue` 只收 `crowd.rescue`，`crowd-reports` 不收 `crowd.rescue`

- [ ] **Step 1: 追加失敗的測試**

在 `pipeline/test/rescue-request.test.mjs` 末尾加入：

```js
import { ingestEvent, signEvent } from '../lib/contract.mjs';
import { buildCrowdChunk, buildCrowdReport, verifyCrowdChunk } from '../lib/crowd-report.mjs';

test('verifyEvent reports contract errors only after the signature checks out', () => {
  const forged = signEvent({ ...create(), severity: 'LOW' }, device.privateKey);
  const result = verifyEvent(forged, null, { now: NOW });
  assert.equal(result.valid, false);
  assert.equal(result.stage, 'contract');
  assert.deepEqual(result.errors, ['rescue_severity_mismatch']);
});

test('ingest applies signer and lifecycle rules', () => {
  const store = new Map();
  const v1 = create();
  assert.equal(ingestEvent(store, v1, null, { now: NOW }).result, 'inserted');
  const resolved = revise(v1, 'RESOLVE', '2026-10-12T03:30:00Z');
  assert.equal(ingestEvent(store, resolved, null, { now: NOW }).result, 'updated');
  const reopened = signEvent({
    ...resolved,
    event_version: 3,
    issued_at: '2026-10-12T03:40:00Z',
    attributes: { ...resolved.attributes, status: 'ACTIVE' },
  }, device.privateKey);
  assert.equal(ingestEvent(store, reopened, null, { now: NOW }).reason, 'rescue_terminal');
});

test('a crowd report cannot be overwritten by another device', () => {
  const store = new Map();
  const report = buildCrowdReport({
    category: 'FLOOD', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
    issuedAt: new Date('2026-10-12T03:00:00Z'), privateKey: device.privateKey, publicKey: device.publicKey,
  });
  ingestEvent(store, report, null, { now: NOW });
  const hijack = buildCrowdReport({
    category: 'OTHER', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
    issuedAt: new Date('2026-10-12T03:05:00Z'), privateKey: other.privateKey, publicKey: other.publicKey,
  });
  const forged = signEvent({ ...hijack, event_id: report.event_id, event_version: 2 }, other.privateKey);
  assert.equal(ingestEvent(store, forged, null, { now: NOW }).reason, 'signer_mismatch');
});

test('rescue chunks use their own dataset and keep relay rules', () => {
  const v1 = create();
  const chunk = buildCrowdChunk(v1, device.privateKey);
  assert.equal(chunk.dataset_id, 'crowd-rescue');
  assert.equal(chunk.chunk_id, `crowd-rescue:${v1.event_id}`);
  assert.equal(chunk.manifest_id, 'crowd-rescue:none');
  assert.equal(chunk.theme, 'rescue');
  assert.equal(chunk.priority, 'HIGH');
  assert.equal(verifyCrowdChunk(structuredClone(chunk), { now: NOW }).valid, true);

  const tampered = structuredClone(chunk);
  tampered.events[0].attributes.status = 'CANCELLED';
  assert.equal(verifyCrowdChunk(tampered, { now: NOW }).errors[0], 'chunk_hash_mismatch');

  const smuggled = { ...structuredClone(chunk), dataset_id: 'crowd-reports' };
  assert.equal(verifyCrowdChunk(smuggled, { now: NOW }).errors[0], 'not_a_crowd_chunk');
});

test('the worst-case legitimate rescue request fits the crowd chunk cap', () => {
  const event = create({
    description: '測'.repeat(160),
    locationHint: { method: 'ADDRESS', query: '測'.repeat(80), label: '測'.repeat(80), kind: 'FACILITY', precision: 'POINT' },
  });
  const chunk = buildCrowdChunk(event, device.privateKey);
  assert.ok(chunk.byte_length <= 4096, `${chunk.byte_length} bytes`);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/rescue-request.test.mjs`
Expected: FAIL（stage 不是 `contract`；`signer_mismatch` 等 reason 不存在；chunk dataset 為 `crowd-reports`）

- [ ] **Step 3: 修改 `contract.mjs`**

import 區加入：

```js
import { isCrowdNamespace, isDeviceKeyId, resolveDeviceKey } from './device-key.mjs';
import { RESCUE_NAMESPACE, rescueEventErrors, rescueTransitionErrors } from './rescue-contract.mjs';
```

（取代原本的 `import { isDeviceKeyId, resolveDeviceKey } from './device-key.mjs';`）

`verifyEvent` 在簽章檢查之後、計算 `now` 之前加入：

```js
  if (event.namespace === RESCUE_NAMESPACE) {
    const contractErrors = rescueEventErrors(event);
    if (contractErrors.length > 0) return { valid: false, stage: 'contract', errors: contractErrors, current: false };
  }
```

`ingestEvent` 的 `if (event.event_version > current.event_version) {` 區塊開頭加入：

```js
    const transitionErrors = event.namespace === RESCUE_NAMESPACE
      ? rescueTransitionErrors(current, event)
      : isCrowdNamespace(event.namespace) && current.signing_key_id !== event.signing_key_id
        ? ['signer_mismatch']
        : [];
    if (transitionErrors.length > 0) {
      return {
        key,
        result: 'rejected',
        stored_version_before: current.event_version,
        incoming_version: event.event_version,
        reason: transitionErrors[0],
        verification,
      };
    }
```

- [ ] **Step 4: 修改 `crowd-report.mjs` 的 chunk 函式**

import 加入：

```js
import { RESCUE_DATASET_ID, RESCUE_MANIFEST_ID, RESCUE_NAMESPACE } from './rescue-contract.mjs';
```

在 `priorityForSeverity` 之前加入：

```js
export const CROWD_CHUNK_PROFILES = Object.freeze({
  [CROWD_DATASET_ID]: Object.freeze({ manifestId: CROWD_MANIFEST_ID, chunkPrefix: 'crowd:', theme: 'report' }),
  [RESCUE_DATASET_ID]: Object.freeze({ manifestId: RESCUE_MANIFEST_ID, chunkPrefix: 'crowd-rescue:', theme: 'rescue' }),
});

function datasetIdForNamespace(namespace) {
  return namespace === RESCUE_NAMESPACE ? RESCUE_DATASET_ID : CROWD_DATASET_ID;
}

function namespaceFitsDataset(datasetId, namespace) {
  if (!isCrowdNamespace(namespace)) return false;
  return datasetId === RESCUE_DATASET_ID ? namespace === RESCUE_NAMESPACE : namespace !== RESCUE_NAMESPACE;
}
```

`buildCrowdChunk` 改為：

```js
export function buildCrowdChunk(event, privateKey) {
  const datasetId = datasetIdForNamespace(event.namespace);
  const profile = CROWD_CHUNK_PROFILES[datasetId];
  const content = {
    schema_version: 'chunk-v0',
    chunk_id: `${profile.chunkPrefix}${event.event_id}`,
    manifest_id: profile.manifestId,
    manifest_hash: event.payload_hash,
    dataset_id: datasetId,
    namespace: event.namespace,
    dataset_version: 1,
    sequence: 0,
    priority: priorityForSeverity(event.severity),
    area_id: 'crowd',
    theme: profile.theme,
    bbox: bboxOfEvents([event]),
    created_at: event.issued_at,
    content_type: 'application/json',
    content_encoding: 'identity',
    event_count: 1,
    events: [event],
    signature_algorithm: 'Ed25519',
    signing_key_id: event.signing_key_id,
  };
  const payloadBytes = chunkPayloadBytes(content);
  const unsigned = { ...content, byte_length: payloadBytes.length, chunk_hash: sha256Bytes(payloadBytes) };
  return { ...unsigned, signature: signCanonical(chunkSignatureInput(unsigned), privateKey) };
}
```

`verifyCrowdChunk` 的開頭兩個檢查與 binding 檢查改為：

```js
  if (validateChunkShape(chunk).length > 0) return invalid('schema', 'crowd_chunk_shape_invalid');
  const profile = CROWD_CHUNK_PROFILES[chunk?.dataset_id];
  if (!profile || !namespaceFitsDataset(chunk.dataset_id, chunk?.namespace)) {
    return invalid('binding', 'not_a_crowd_chunk');
  }
  // ...（event 數量與 shape 檢查不變）
  if (chunk.chunk_id !== `${profile.chunkPrefix}${event.event_id}`
    || chunk.manifest_id !== profile.manifestId
    || chunk.manifest_hash !== event.payload_hash
    || chunk.dataset_version !== 1
    || chunk.namespace !== event.namespace) {
    return invalid('binding', 'crowd_chunk_binding_invalid');
  }
```

其餘檢查順序與錯誤字串不變。

- [ ] **Step 5: 執行測試確認通過**

Run: `node --test pipeline/test/rescue-request.test.mjs pipeline/test/rescue-contract.test.mjs pipeline/test/crowd-signature.test.mjs pipeline/test/attest.test.mjs pipeline/test/peer-sync.test.mjs`
Expected: PASS（既有 crowd 測試不受影響）

- [ ] **Step 6: Commit**

```bash
git add pipeline/lib/contract.mjs pipeline/lib/crowd-report.mjs pipeline/test/rescue-request.test.mjs
git commit -m "feat(contract): enforce rescue lifecycle and same-signer crowd updates"
```

---

### Task 4: 共用 fixture 與產生器

**Files:**
- Create: `pipeline/tools/generate-rescue-fixture.mjs`
- Create（產生）：`fixtures/rescue-requests-v0.json`、`android/app/src/test/resources/fixtures/rescue-requests-v0.json`
- Test: `pipeline/test/rescue-fixture.test.mjs`
- Modify: `pipeline/test/schema.test.mjs`（追加 schema 與位元相同檢查）

**Interfaces:**
- Consumes: Task 1–3；`buildCrowdReport`；`keyPairFromSeed` 寫法沿用 `generate-crowd-fixture.mjs`
- Produces（fixture 結構，Kotlin 與 Web 測試依此讀取）：

```text
{
  schema_version: 'rescue-fixture-v0',
  description, now: '2026-10-12T04:00:00Z',
  device_key_id, other_device_key_id,
  seeds: { device: 'rescue-fixture-device-a', other: 'rescue-fixture-device-b' },
  inputs: {
    create: { requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint, issuedAt, requestUuid },
    revisions: [ { action, issuedAt, changes } ... ]   // v2 UPDATE, v3 EXTEND, v4 RESOLVE
  },
  event_cases: [ { name, expect: { valid, stage?, error? }, event } ],
  transition_cases: [ { name, stored, incoming, expect: { result, reason? } } ],
  chunk_cases: [ { name, expect: { valid, error? }, chunk } ]
}
```

金鑰種子沿用既有規則：UTF-8 標籤、補零到 32 bytes（Kotlin `CrowdFixtures.deviceKey(label)` 可重建）。

- [ ] **Step 1: 寫失敗的測試**

`pipeline/test/rescue-fixture.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ingestEvent, verifyEvent } from '../lib/contract.mjs';
import { verifyCrowdChunk } from '../lib/crowd-report.mjs';
import { buildRescueRequest, buildRescueRevision } from '../lib/rescue-request.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'));
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyPairFromSeed(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

for (const testCase of fixture.event_cases) {
  test(`rescue event case ${testCase.name}`, () => {
    const result = verifyEvent(testCase.event, null, { now: fixture.now });
    assert.equal(result.valid, testCase.expect.valid, JSON.stringify(result));
    if (!testCase.expect.valid) {
      assert.equal(result.stage, testCase.expect.stage);
      if (testCase.expect.error) assert.equal(result.errors[0], testCase.expect.error);
    }
  });
}

for (const testCase of fixture.transition_cases) {
  test(`rescue transition case ${testCase.name}`, () => {
    const store = new Map();
    assert.notEqual(ingestEvent(store, testCase.stored, null, { now: fixture.now }).result, 'rejected');
    const result = ingestEvent(store, testCase.incoming, null, { now: fixture.now });
    assert.equal(result.result, testCase.expect.result, JSON.stringify(result));
    if (testCase.expect.reason) assert.equal(result.reason, testCase.expect.reason);
  });
}

for (const testCase of fixture.chunk_cases) {
  test(`rescue chunk case ${testCase.name}`, () => {
    const result = verifyCrowdChunk(testCase.chunk, { now: fixture.now });
    assert.equal(result.valid, testCase.expect.valid, JSON.stringify(result));
    if (!testCase.expect.valid) assert.equal(result.errors[0], testCase.expect.error);
  });
}

test('the builders reproduce the fixture timeline byte for byte', () => {
  const keys = keyPairFromSeed(fixture.seeds.device);
  const create = fixture.inputs.create;
  let latest = buildRescueRequest({ ...create, issuedAt: new Date(create.issuedAt), ...keys });
  assert.deepEqual(latest, fixture.event_cases.find((entry) => entry.name === 'valid_v1').event);
  const names = ['valid_v2_update', 'valid_v3_extend', 'valid_v4_resolved'];
  fixture.inputs.revisions.forEach((revision, index) => {
    latest = buildRescueRevision(latest, { ...revision, issuedAt: new Date(revision.issuedAt), ...keys });
    assert.deepEqual(latest, fixture.event_cases.find((entry) => entry.name === names[index]).event);
  });
});

test('rescue-requests-v0.json is byte-identical to the Android test copy', () => {
  assert.equal(
    readFileSync(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'),
    readFileSync(path.join(ROOT, 'android/app/src/test/resources/fixtures/rescue-requests-v0.json'), 'utf8'),
  );
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/rescue-fixture.test.mjs`
Expected: FAIL，`ENOENT ... fixtures/rescue-requests-v0.json`

- [ ] **Step 3: 實作產生器 `pipeline/tools/generate-rescue-fixture.mjs`**

```js
#!/usr/bin/env node
// Generates fixtures/rescue-requests-v0.json and its byte-identical copy under
// android/app/src/test/resources/fixtures/. Keys come from fixed seeds; they
// exist ONLY for this fixture and must never be trusted anywhere else.
//
//   node pipeline/tools/generate-rescue-fixture.mjs

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestEvent, signEvent, verifyEvent } from '../lib/contract.mjs';
import { buildCrowdChunk, buildCrowdReport, verifyCrowdChunk } from '../lib/crowd-report.mjs';
import { deviceKeyIdForPublicKey } from '../lib/device-key.mjs';
import { rescueEventIdPrefix } from '../lib/rescue-contract.mjs';
import { buildRescueRequest, buildRescueRevision } from '../lib/rescue-request.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const NOW = '2026-10-12T04:00:00Z';
const SEEDS = { device: 'rescue-fixture-device-a', other: 'rescue-fixture-device-b' };

function keyPairFromSeed(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const device = keyPairFromSeed(SEEDS.device);
const other = keyPairFromSeed(SEEDS.other);

const createInput = {
  requestType: 'TRAPPED_DEBRIS',
  subject: 'SELF',
  peopleCount: 2,
  triage: { immobile: 'YES', breathing_difficulty: 'NO', severe_bleeding: 'UNKNOWN', conscious: 'YES' },
  description: '一樓樓梯間，敲牆有回應',
  lon: 121.588123,
  lat: 25.069876,
  locationSource: 'MAP_PICK',
  locationHint: { method: 'ADDRESS', query: '內湖區成功路', label: '成功路', kind: 'ROAD', precision: 'ROAD' },
  issuedAt: '2026-10-12T03:00:00Z',
  requestUuid: '00000000-0000-4000-8000-0000000000a1',
};
const revisions = [
  { action: 'UPDATE', issuedAt: '2026-10-12T03:10:00Z', changes: { peopleCount: 3, description: '一樓樓梯間，三人受困' } },
  { action: 'EXTEND', issuedAt: '2026-10-12T08:30:00Z', changes: {} },
  { action: 'RESOLVE', issuedAt: '2026-10-12T09:00:00Z', changes: {} },
];

const v1 = buildRescueRequest({ ...createInput, issuedAt: new Date(createInput.issuedAt), ...device });
const timeline = [v1];
for (const revision of revisions) {
  timeline.push(buildRescueRevision(timeline.at(-1), { ...revision, issuedAt: new Date(revision.issuedAt), ...device }));
}
const [, v2, v3, v4] = timeline;

const resign = (event, keys = device) => signEvent(structuredClone(event), keys.privateKey);
const tampered = structuredClone(v1);
tampered.attributes.description = '已被竄改';
const officialImpostor = resign({ ...v1, namespace: 'official.tdx' });
const severityMismatch = resign({ ...v1, severity: 'MEDIUM' });
const unbound = resign({ ...v1, event_id: `${rescueEventIdPrefix(deviceKeyIdForPublicKey(other.publicKey))}${createInput.requestUuid}` });
const ttlTooLong = resign({ ...v1, expires_at: '2026-10-12T09:00:01Z' });
const lifetimeExceeded = resign({
  ...v2,
  issued_at: '2026-10-15T00:30:00Z',
  expires_at: '2026-10-15T06:00:00Z',
});
const unknownAttribute = resign({ ...v1, attributes: { ...v1.attributes, phone: '0912000000' } });
const selfUnconscious = resign({ ...v1, attributes: { ...v1.attributes, triage: { ...v1.attributes.triage, conscious: 'NO' } } });

const reopened = resign({ ...v4, event_version: 5, issued_at: '2026-10-12T09:10:00Z', attributes: { ...v4.attributes, status: 'ACTIVE' } });
const shortenedResolve = resign({ ...v4, expires_at: '2026-10-12T10:00:00Z' });
const movedFirstIssued = resign({ ...v2, attributes: { ...v2.attributes, first_issued_at: '2026-10-12T02:59:00Z' } });

const report = buildCrowdReport({
  category: 'FLOOD', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
  issuedAt: new Date('2026-10-12T03:00:00Z'), reportUuid: '00000000-0000-4000-8000-0000000000b1', ...device,
});
const reportHijack = signEvent({
  ...buildCrowdReport({
    category: 'OTHER', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
    issuedAt: new Date('2026-10-12T03:05:00Z'), reportUuid: '00000000-0000-4000-8000-0000000000b2', ...other,
  }),
  event_id: report.event_id,
  event_version: 2,
}, other.privateKey);

const validChunk = buildCrowdChunk(v1, device.privateKey);
const relayTampered = structuredClone(validChunk);
relayTampered.events[0].attributes.status = 'CANCELLED';
const smuggled = { ...structuredClone(validChunk), dataset_id: 'crowd-reports' };

const fixture = {
  schema_version: 'rescue-fixture-v0',
  description: 'Generated by pipeline/tools/generate-rescue-fixture.mjs. Keys are fixture-only seeds; never trust them outside tests.',
  now: NOW,
  device_key_id: v1.signing_key_id,
  other_device_key_id: deviceKeyIdForPublicKey(other.publicKey),
  seeds: SEEDS,
  inputs: { create: createInput, revisions },
  event_cases: [
    { name: 'valid_v1', expect: { valid: true }, event: v1 },
    { name: 'valid_v2_update', expect: { valid: true }, event: v2 },
    { name: 'valid_v3_extend', expect: { valid: true }, event: v3 },
    { name: 'valid_v4_resolved', expect: { valid: true }, event: v4 },
    { name: 'tampered', expect: { valid: false, stage: 'integrity' }, event: tampered },
    { name: 'official_namespace', expect: { valid: false, stage: 'trust' }, event: officialImpostor },
    { name: 'severity_mismatch', expect: { valid: false, stage: 'contract', error: 'rescue_severity_mismatch' }, event: severityMismatch },
    { name: 'unbound_event_id', expect: { valid: false, stage: 'contract', error: 'rescue_event_id_unbound' }, event: unbound },
    { name: 'ttl_too_long', expect: { valid: false, stage: 'contract', error: 'rescue_ttl_too_long' }, event: ttlTooLong },
    { name: 'lifetime_exceeded', expect: { valid: false, stage: 'contract', error: 'rescue_lifetime_exceeded' }, event: lifetimeExceeded },
    { name: 'unknown_attribute', expect: { valid: false, stage: 'contract', error: 'rescue_attributes_unknown' }, event: unknownAttribute },
    { name: 'self_unconscious', expect: { valid: false, stage: 'contract', error: 'rescue_field_invalid:triage' }, event: selfUnconscious },
  ],
  transition_cases: [
    { name: 'update_after_create', stored: v1, incoming: v2, expect: { result: 'updated' } },
    { name: 'rollback', stored: v2, incoming: v1, expect: { result: 'rejected', reason: 'version_rollback' } },
    { name: 'reopen_after_resolved', stored: v4, incoming: reopened, expect: { result: 'rejected', reason: 'rescue_terminal' } },
    { name: 'terminal_shortens_expiry', stored: v3, incoming: shortenedResolve, expect: { result: 'rejected', reason: 'rescue_terminal_expiry_changed' } },
    { name: 'first_issued_changed', stored: v1, incoming: movedFirstIssued, expect: { result: 'rejected', reason: 'rescue_first_issued_changed' } },
    { name: 'report_update_other_signer', stored: report, incoming: reportHijack, expect: { result: 'rejected', reason: 'signer_mismatch' } },
  ],
  chunk_cases: [
    { name: 'valid_rescue_chunk', expect: { valid: true }, chunk: validChunk },
    { name: 'relay_tampered', expect: { valid: false, error: 'chunk_hash_mismatch' }, chunk: relayTampered },
    { name: 'rescue_in_report_dataset', expect: { valid: false, error: 'not_a_crowd_chunk' }, chunk: smuggled },
  ],
};

// Self-check before writing so a broken generator cannot ship a fixture that
// disagrees with the contract it pins.
for (const testCase of fixture.event_cases) {
  const result = verifyEvent(testCase.event, null, { now: NOW });
  const ok = result.valid === testCase.expect.valid
    && (result.valid || (result.stage === testCase.expect.stage && (!testCase.expect.error || result.errors[0] === testCase.expect.error)));
  if (!ok) throw new Error(`${testCase.name}: expected ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(result)}`);
}
for (const testCase of fixture.transition_cases) {
  const store = new Map();
  ingestEvent(store, testCase.stored, null, { now: NOW });
  const result = ingestEvent(store, testCase.incoming, null, { now: NOW });
  if (result.result !== testCase.expect.result || (testCase.expect.reason && result.reason !== testCase.expect.reason)) {
    throw new Error(`${testCase.name}: expected ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(result)}`);
  }
}
for (const testCase of fixture.chunk_cases) {
  const result = verifyCrowdChunk(testCase.chunk, { now: NOW });
  if (result.valid !== testCase.expect.valid || (!result.valid && result.errors[0] !== testCase.expect.error)) {
    throw new Error(`${testCase.name}: expected ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(result)}`);
  }
}

const text = `${JSON.stringify(fixture, null, 2)}\n`;
const targets = [
  path.join(ROOT, 'fixtures/rescue-requests-v0.json'),
  path.join(ROOT, 'android/app/src/test/resources/fixtures/rescue-requests-v0.json'),
];
for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}
console.log(`wrote:\n${targets.map((target) => `  ${target}`).join('\n')}`);
```

注意：`lifetimeExceeded` 以 v2 為底，`issued_at` 改到 2026-10-15T00:30Z、`expires_at` 2026-10-15T06:00Z，`first_issued_at` 仍是 2026-10-12T03:00Z，因此 `expires_at` 超過 +72h；它在 `now`（2026-10-12T04:00Z）時尚未過期，驗證一定走到 contract 階段。

- [ ] **Step 4: 產生 fixture**

Run: `node pipeline/tools/generate-rescue-fixture.mjs`
Expected: 印出兩個寫入路徑，沒有 `Error`。

- [ ] **Step 5: schema 測試追加**

在 `pipeline/test/schema.test.mjs` 的 crowd 區塊之後加入：

```js
const rescueFixture = readJson('fixtures/rescue-requests-v0.json');

test('valid rescue requests conform to event-v0', () => {
  for (const entry of rescueFixture.event_cases.filter((item) => item.expect.valid)) {
    assert.deepEqual(validate(entry.event, eventSchema), [], entry.name);
  }
});
```

- [ ] **Step 6: 執行測試確認通過**

Run: `node --test pipeline/test/rescue-fixture.test.mjs pipeline/test/schema.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add pipeline/tools/generate-rescue-fixture.mjs fixtures/rescue-requests-v0.json android/app/src/test/resources/fixtures/rescue-requests-v0.json pipeline/test/rescue-fixture.test.mjs pipeline/test/schema.test.mjs
git commit -m "test(contract): pin rescue requests with a shared fixture"
```
