# 政府手機離線 Mesh 警告實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓已授權的政府 Android 手機可離線建立已驗證官方警告、透過 mesh 分享並於恢復連線後同步至雲端。

**Architecture:** 以中央簽章的 7 天政府設備憑證授權手機 Ed25519 金鑰。Android 保留原始設備簽章事件及 mesh chunk；API 驗證後保存，發布 worker 保留事件簽章並以中央金鑰簽 feed manifest/chunk。Web 使用相同事件契約和驗證規則完成線上發布與同步。

**Tech Stack:** Node.js ESM、Fastify、PostgreSQL、event-v0／Ed25519；Android Kotlin、Room、Android Keystore wrapping、既有 BLE／Nearby mesh；Flutter Dart/Web；Node test、JUnit、Flutter test。

**Spec:** [`docs/superpowers/specs/2026-10-12-government-device-mesh-warning-design.md`](../specs/2026-10-12-government-device-mesh-warning-design.md)

## Global Constraints

- 政府設備憑證有效期固定為 7 天，線上時續期；憑證只授權新的警告簽署，已簽警告可在自身有效期內繼續驗證。
- 政府警告使用 `official.announcement`、`source=GOVERNMENT`、`area_id=tw.national`，有效期不超過 90 天，地點選填。
- 中央 Ed25519 私鑰只供 `government-publisher` 使用；API 與 Android 不得讀取中央私鑰。
- `device:` 自我識別簽章維持只可用於 `crowd.*`；政府事件必須帶由可信中央金鑰簽署的設備憑證。
- Android 只有在既有「緊急模式」啟用時參與 mesh；Web 保留線上建立、驗證、同步及相同顯示，不實作 BLE mesh。
- 民眾回報維持 `UNVERIFIED`，`REFUTED` 不顯示為確認。
- 停權資訊透過中央簽章的 `government-device-revocations` feed 分發；離線端只依最近收到的撤銷資料判斷。
- 保留目前工作目錄中既有政府工作台變更；不執行 `git add`、commit 或 push。

## Review Focus

- 裝置公鑰、憑證及事件 key id 不一致時，政府事件必須拒絕；由 Task 1 的憑證與跨語言驗證測試固定。
- 憑證在事件簽署後才過期，不得讓仍有效的舊警告失效；在事件簽署前已過期則必須拒絕，由 Task 1 與 Task 4 測試固定。
- 同 event id 的完全相同補傳必須冪等；相同 id 不同 payload 必須回 409，由 Task 2 測試固定。
- 已知撤銷時間之後簽署的事件必須拒絕，撤銷之前的有效事件可保留；由 Task 3 與 Task 5 測試固定。
- 發布失敗不可丟失設備憑證、撤銷記錄或警告；重試後 feed 只能出現每個事件的最高有效版本，由 Task 2、Task 3 測試固定。

---

### Task 1: 設備憑證與政府事件驗證契約

**Files:**
- Create: `pipeline/lib/government-device-certificate.mjs`
- Create: `pipeline/test/government-device-certificate.test.mjs`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/trust/GovernmentDeviceCertificate.kt`
- Create: `android/app/src/test/java/com/resilientgeo/mesh/trust/GovernmentDeviceCertificateTest.kt`
- Modify: `pipeline/lib/device-key.mjs`, `pipeline/lib/contract.mjs`, `schemas/event-v0.schema.json`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/trust/DeviceKeys.kt`, `EventShapeValidator.kt`, `EventVerifier.kt`

**Interfaces:**
- Produces `signGovernmentDeviceCertificate(fields, signingKey)` and `verifyGovernmentDeviceCertificate(certificate, publicKey, { trustedKeyIds, at })` in Node.
- Produces `GovernmentDeviceCertificate.verify(certificate, trustStore, at)` in Android.
- Extends `verifyEvent(event, publicKey, options)` and `EventVerifier.verify(event, trustStore, now)` so `device:` still self-certifies only `crowd.*`; `official.announcement` accepts that key only with a valid certificate in `attributes.government_device_certificate` and `official.announcement.publish` permission.
- Certificate schema is `government-device-certificate-v1`; event verification checks certificate validity at the event's `issued_at`, not the later receipt time.

- [x] **Step 1: Add Node tests** for valid certificate, altered certificate/signature, issuer not trusted, key fingerprint mismatch, missing publish permission, certificate expired at event issue time, post-expiry receipt of an event signed during its validity, and self-certified device keys remaining rejected for official events.
- [x] **Step 2: Run `node --test pipeline/test/government-device-certificate.test.mjs`** and confirm the new cases fail before implementation.
- [x] **Step 3: Implement the certificate builder/verifier and extend the Node event trust path** without changing crowd-report behavior.
- [x] **Step 4: Run `node --test pipeline/test/government-device-certificate.test.mjs pipeline/test/crowd-signature.test.mjs pipeline/test/pipeline.test.mjs`** and confirm all pass.
- [x] **Step 5: Add matching Kotlin fixture tests** for canonical signature verification, certificate/event key binding, expiry-at-issuance, and rejection of uncertified official device events.
- [x] **Step 6: Run `:app:testDebugUnitTest --tests ...`** with the installed JDK 21; the new and existing event verifier tests pass. The root aggregate also runs third-party plugin tests and currently fails 3 `geolocator_android` Mockito tests before the full app module suite can complete.

### Task 2: Backend設備生命週期、憑證簽發與警告補傳

**Files:**
- Create: `server/db/migrations/003_government_device_mesh_warnings.sql`
- Create: `server/test/government-devices.test.mjs`
- Modify: `server/src/government/app.mjs`, `workbench-service.mjs`, `postgres-store.mjs`, `publisher-worker.mjs`
- Modify: `server/src/government/config.mjs`, `entrypoint.mjs`, `deploy/docker-compose.yml`
- Create: `server/test/government-devices.test.mjs`, `server/test/government-config.test.mjs`
- Modify: `server/test/government-auth.test.mjs`, `government-postgres-store.test.mjs`, `government-publisher.test.mjs`, `deployment-config.test.mjs`

**Interfaces:**
- Add `POST /api/v1/government/devices` to enroll the authenticated Android key; response is `{ device_id, status: "PENDING_CERTIFICATE" }`.
- Add `GET /api/v1/government/devices/current` to return state and issued certificate; add `POST /api/v1/government/devices/current/renew` to queue renewal.
- Add admin-only `GET /api/v1/government/devices` and `DELETE /api/v1/government/devices/:deviceId`; disabling an account revokes every linked device.
- Add authenticated `POST /api/v1/government/warnings` for the original signed event; return `{ event_id, payload_hash, publication_status, duplicate }`.
- Store devices, certificates, raw device warnings and revocation timestamps in PostgreSQL. Add outbox aggregate types for certificate issuance and warning publication. Publisher signs certificates and revocation records; API never loads the signing private key.

- [x] **Step 1: Add server tests** for gov/admin role rules, enrollment key validation, certificate pending/issued/renewed state, user/device revocation, invalid certificate/event rejection, active-account enforcement, exact duplicate idempotency, same-id payload conflict, audit rows, and post-revocation upload rejection.
- [x] **Step 2: Run `node --test server/test/government-devices.test.mjs`** and confirm new route/service behavior fails before implementation.
- [x] **Step 3: Add migration and Postgres store methods** for device registration, certificate outbox, warning persistence, revocation, listing, and audit records.
- [x] **Step 4: Add authenticated Fastify routes and service validation** using Task 1's certificate/event verifiers; enforce event TTL <= 90 days and reject future issue times beyond five minutes.
- [x] **Step 5: Extend the internal publisher worker** to sign queued 7-day certificates and store them for API retrieval; revocations are durably queued for the signed feed added in Task 3.
- [x] **Step 6: Run `npm run test:server`**; all 116 server tests pass, including certificate issuance, device/account revocation, audit, and auth behavior.

### Task 3: 官方 feed 保留手機簽章並發布撤銷資料

**Files:**
- Modify: `pipeline/lib/government-feed.mjs`, `pipeline/lib/contract.mjs`
- Modify: `server/src/government/publisher-worker.mjs`, `server/src/publisher/release-publisher.mjs`
- Modify: `pipeline/test/government-feed.test.mjs`, `server/test/government-publisher.test.mjs`

**Interfaces:**
- `government-announcements` accepts centrally signed workbench events and validated device-signed warning events.
- `buildGovernmentFeed(...)` preserves a valid device-signed event's signed fields and event version; it centrally signs the containing feed, manifest and chunks. It continues centrally signing online-created, revised and retracted events.
- Publisher emits a hidden internal `government-device-revocations` source with `official.device-revocation` events carrying certificate/device id and `revoked_at`; it contains no account name or password data.

- [x] **Step 1: Add pipeline tests** proving a valid device event is preserved byte-for-byte in event payload/signature inside the central bundle, while tampering, unsupported namespace and unknown issuer fail publication.
- [x] **Step 2: Run `node --test pipeline/test/government-feed.test.mjs`** and confirm preservation tests fail before implementation.
- [x] **Step 3: Update feed version handling** to preserve device event v1 and let later centrally signed revisions/retractions increment the same event id without rollback or same-version conflict.
- [x] **Step 4: Add revocation source output** and prevent its metadata events from becoming user notifications.
- [x] **Step 5: Run `node --test pipeline/test/government-feed.test.mjs pipeline/test/government-device-certificate.test.mjs server/test/government-publisher.test.mjs`** and confirm feed signature, event versions and revocation content pass.

### Task 4: Android 離線簽署、Room outbox 與 mesh chunk

**Files:**
- Create: `android/app/src/main/java/com/resilientgeo/mesh/report/GovernmentWarningFactory.kt`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/report/GovernmentWarningChunkCodec.kt`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/trust/GovernmentDeviceKeyStore.kt`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/data/GovernmentWarningUploadEntity.kt`
- Create: `android/app/src/test/java/com/resilientgeo/mesh/report/GovernmentWarningFactoryTest.kt`
- Create: `android/app/src/test/java/com/resilientgeo/mesh/report/GovernmentWarningChunkCodecTest.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/AppDatabase.kt`, `MeshRepository.kt`, `ChunkVerifier.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/bridge/FlutterMapBridge.kt`, `MapBridgeProtocol.kt`, `MainActivity.kt`

**Interfaces:**
- `GovernmentWarningFactory.create(input, key, certificate, issuedAt, eventId)` returns a signed event-v0 JSON document.
- `GovernmentWarningChunkCodec.build(event, key)` and `.verify(chunk, trustStore, now)` use one signed event per `government-device-announcements` chunk.
- Add Flutter bridge calls to get the government device public key, store a returned certificate, read device authorization state, create a warning, list pending upload events, and mark an event uploaded by id/hash.
- Room adds a durable upload-state table; local creation commits the event, mesh chunk and pending upload row atomically.

- [x] **Step 1: Add factory/codec JVM tests** for event-v0 parity, bounds, 90-day expiry maximum, tampered event, wrong cert key, invalid chunk signature, duplicate event id and payload conflict.
- [x] **Step 2: Run `cd android && ./gradlew testDebugUnitTest`** and confirm the new tests fail before implementation.
- [x] **Step 3: Add a separate government device key storage namespace** wrapped by Android Keystore so government warning signing never reuses the crowd-report key.
- [x] **Step 4: Add Room migration and DAO** for pending cloud upload status; do not use destructive migration or drop existing offline data.
- [x] **Step 5: Implement factory, codec and `MeshRepository.createGovernmentWarning(...)`**; verify through the same `ChunkVerifier`/`EventIngestor` path before commit.
- [x] **Step 6: Add bridge protocol and handlers** for device key, certificate state, local warning creation and upload queue acknowledgement.
- [x] **Step 7: Run `cd android && ./gradlew testDebugUnitTest`** and confirm factory, codec, Room migration and bridge contract tests pass (219 app JVM tests pass after Task 5).

### Task 5: Android feed trust、撤銷快取與 peer relay

**Files:**
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/OfficialEventSourcePolicy.kt`, `MeshRepository.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/online/GovernmentFeedVerifier.kt`, `GovernmentSyncManager.kt`
- Modify: `android/app/src/test/java/com/resilientgeo/mesh/data/OfficialEventSourcePolicyTest.kt`
- Modify: `android/app/src/test/java/com/resilientgeo/mesh/online/GovernmentFeedSyncTest.kt`
- Modify: `android/app/src/androidTest/java/com/resilientgeo/mesh/data/GovernmentPeerInstrumentedTest.kt`

**Interfaces:**
- Add `government-device-announcements` and `government-device-revocations` to supported source policies.
- Ingest revocation records into a durable local authority cache; a known revoked certificate rejects events with `issued_at >= revoked_at` and remains available for mesh relay.
- The existing Emergency Mode service advertises the new held dataset and relays accepted chunks unchanged. No automatic radio start is added.

- [x] **Step 1: Add sync/mesh tests** for accepting certified official-device events, rejecting known-revoked post-time events, preserving prior valid events, and advertising the new datasets.
- [x] **Step 2: Run `cd android && ./gradlew testDebugUnitTest`** and confirm the new policy/cache cases fail before implementation.
- [x] **Step 3: Update source allowlists, feed ingestion, revocation cache and `MeshRepository` verification.** Keep revocation events out of map/notification event results while relaying their signed chunks.
- [x] **Step 4: Extend the opt-in two-phone instrumentation flow** so the source creates a warning while offline and the receiver accepts it over BLE without internet.
- [x] **Step 5: Run `cd android && ./gradlew testDebugUnitTest`**; run connected-device tests only on available paired Android phones and report hardware status separately. App JVM tests pass; Android instrumentation sources compile, but paired hardware could not be checked because `adb` is unavailable in this environment.

### Task 6: Flutter 登入授權狀態、工作台建立及補傳

**Files:**
- Create: `flutter/lib/data/government_warning_upload_queue.dart`
- Create: `flutter/test/government_warning_upload_queue_test.dart`
- Modify: `flutter/lib/data/government_api.dart`, `map_bridge.dart`, `government_feed_models.dart`
- Modify: `flutter/lib/screens/government_workbench_screen.dart`, `profile_screen.dart`
- Modify: `flutter/test/government_announcement_editor_test.dart`, `profile_screen_test.dart`

**Interfaces:**
- `GovernmentApiClient` implements enroll/current-state/renew/list/revoke/upload methods for Task 2 endpoints.
- Android login enrolls or renews its device and passes issued certificate to the bridge; cached account descriptor and certificate allow offline workbench restoration only while the certificate is valid.
- Android announcement create uses Task 4 native signing and local persistence, then queues authenticated upload. Exact retry keeps the same event id. Workbench shows `待 mesh 同步`, `待雲端補傳`, `已發布` and authorization expiry based on real state.
- Flutter Web continues using the online announcement API and does not call native device enrollment.

- [x] **Step 1: Add Flutter tests** for API request/response contracts, offline auth restoration with valid/expired certificates, warning queue idempotency/retry/expiry, and UI status states.
- [x] **Step 2: Run `cd flutter && flutter test --no-pub`** and confirm the new cases fail before implementation.
- [x] **Step 3: Add API client methods and Android bridge orchestration** for post-login enrollment, certificate retrieval/renewal and pending warning upload.
- [x] **Step 4: Add cached account/device state** so an already enrolled government user can open the workbench offline; logout clears the signing session but preserves already signed alerts for relay.
- [x] **Step 5: Route Android warning creation to the native factory and Web creation to the online API.** Keep existing nationwide fields, expiry picker and optional location.
- [x] **Step 6: Display certificate validity, last revocation sync and upload state** without claiming a peer received an alert until peer telemetry confirms it.
- [x] **Step 7: Run `cd flutter && flutter analyze --no-pub && flutter test --no-pub`** and confirm Web/Android shared UI tests pass; analyzer clean and 304 Flutter tests pass.

### Task 7: Web feed verification、介面一致性、文件及整合驗收

**Files:**
- Modify: `flutter/web/nlsc_static_layers.js`, `flutter/web/nlsc_government_feed.js`
- Modify: `flutter/lib/screens/notifications_screen.dart`, `flutter/lib/data/ncdr_map_filter.dart`
- Create: `flutter/test/government_device_event_test.dart`
- Modify: `pipeline/test/nlsc-government-feed-web.test.mjs`, `flutter/test/government_announcement_editor_test.dart`
- Modify: `docs/government-workbench.md`, `docs/government-online-sync.md`
- Modify: `android/app/src/androidTest/java/com/resilientgeo/mesh/data/GovernmentPeerInstrumentedTest.kt`

**Interfaces:**
- Web and Android agree on whether a device-signed warning is valid, expired, superseded or revoked using the same certificate/event rules.
- Public UI displays only official alerts as verified and preserves citizen-report verification states. Internal revocation events are never shown as warnings.

- [x] **Step 1: Add Web verifier tests** for valid device certificate, bad certificate/signature, expiry-at-issuance and known revocation in `pipeline/test/nlsc-government-feed-web.test.mjs`; add a shared fixture consumed by Node, Kotlin and Web tests.
- [x] **Step 2: Run `npm test`** and confirm contract/feed verification tests pass (317/317).
- [x] **Step 3: Update Web parsing and Flutter notifications** to display the same verified label, content, nationwide scope, optional map point and event version as Android.
- [x] **Step 4: Document enrollment, 7-day renewal, offline status, Emergency Mode, revocation freshness, cloud retry and key boundary** in the government workbench runbook.
- [x] **Step 5: Run `npm run test:server`, `npm test`, `cd flutter && flutter analyze --no-pub && flutter test --no-pub`, and `cd android && ./gradlew testDebugUnitTest`.** Server 119/119; pipeline and simulator 317/317; Flutter analyzer clean and tests 304/304; Android app JVM 220/220 and Android test sources compile.
- [ ] **Step 6: Run the paired-phone acceptance:** enroll source phone online; disable internet on both phones; enable Emergency Mode; create warning on source; verify receiver shows government signature; restore network; verify one feed event and same event id/version on Web and both phones.
- [x] **Step 7: Inspect `git diff --check` and `git status --short`; report Web, Flutter Android, backend and hardware results separately. Do not commit.** `git diff --check` is clean. Physical acceptance remains outstanding because `adb` is unavailable in this environment.
