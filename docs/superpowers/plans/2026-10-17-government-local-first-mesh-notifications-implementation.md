# Government Announcement Local-First Mesh Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 政府 Android 手機建立公告後立即本機呈現，緊急模式開啟時儘快透過 Mesh 傳播，並在有網路及有效登入工作階段時自動補傳至簽章 feed。

**Architecture:** Android Room continues to own signed event/chunk persistence. Flutter's app controller refreshes its read-only Room snapshot after a local create as a recovery path, while the active Emergency Mode service observes verified inventory changes and asks the existing peer engine to retry recent peers without waiting out the normal success cooldown. A network-constrained Android job uploads the durable Room outbox using the encrypted government session token; Flutter Web continues to receive the centrally signed feed.

**Tech Stack:** Android Kotlin, Room Flow, `JobScheduler`, `HttpURLConnection`, Flutter/Dart `ChangeNotifier`, existing signed government feed and Web IndexedDB cache.

**Spec:** [`docs/superpowers/specs/2026-10-17-government-local-first-mesh-notifications-design.md`](../specs/2026-10-17-government-local-first-mesh-notifications-design.md)

## Global Constraints

- Local Room write remains authoritative; local notification visibility does not depend on cloud download or the manual Government Data Update action.
- Mesh runs only while Emergency Mode is already enabled; no code path in this plan enables radio or Emergency Mode automatically.
- Preserve the signed event JSON, event id and payload hash across Mesh, cloud retries and signed feed publication.
- Do not claim peer delivery without receiver evidence; a missing network or failed Mesh session leaves the locally saved event intact.
- Government cloud uploads require the existing encrypted Android Keystore session token and the authenticated `/api/v1/government/warnings` endpoint.
- Web has no BLE transport; preserve its verified signed-feed receiver and the same official event filtering and notification wording.
- Keep all changes in the existing `fixNotification` checkout; do not run `git add`, commit, push or merge.
- No tests are to be added or run in this execution unless explicitly requested; implementation status must distinguish source inspection from runtime or automated acceptance.

## Review Focus

- Local create can succeed while a subsequent cloud list refresh fails; the created event must still enter the app's local notification state.
- A Room inventory change must expedite a recent peer session while respecting active-session and semaphore limits; an inactive Emergency Mode service must not be started.
- Offline, expired-token, unauthorized, malformed-response, timeout and 5xx upload outcomes must leave the outbox row recoverable; only a response matching event id and payload hash may acknowledge it.
- The one-off upload job and five-minute Flutter foreground retry may overlap; duplicate requests must remain safe under the server's existing idempotent event identity contract.
- Feed ingestion and local creation can update the same event; Room event/chunk identity and signature verification must remain the deduplication boundary.

---

### Task 1: Refresh the local Flutter event view after device announcement creation

**Files:**
- Modify: `flutter/lib/data/government_api.dart`
- Modify: `flutter/lib/app/map_app_controller.dart`
- Modify: `flutter/lib/screens/government_workbench_screen.dart`

**Interfaces:**
- `GovernmentAuthController.onDeviceWarningCreated`: optional `Future<void> Function()?` callback invoked only after native Room creation succeeds.
- `MapAppController._refreshNativeEventsAfterGovernmentWarning()`: reads `bridge.getInitialState()`, filters it through `_withoutUnsupportedEvents`, replaces `persistedEvents`, emits `_eventUpdates`, reschedules expiry and notifies listeners. Refresh errors are recorded locally and must not convert an already committed announcement into a create failure.
- The government workbench reads the existing Emergency Mode state through `MapBridge.getInitialState()` and offers an explicit enable action only when off; the action calls the existing `setEmergencyMode(enabled: true)` bridge contract.

- [x] Wire the post-create callback from `MapAppController` to the native snapshot refresh and clear the callback on dispose.
- [x] Invoke the callback after `createGovernmentWarning` returns successfully; preserve the event result if the fallback snapshot refresh fails.
- [x] Update the Android government warning status panel to distinguish Mesh disabled from waiting for Mesh sync, and offer the explicit Emergency Mode action without asserting peer receipt.
- [x] Review the shared notifications list and Web feed parser to confirm the same signed `official.announcement` event remains visible and verified on both Flutter targets.

### Task 2: Expedite Mesh inventory synchronization while Emergency Mode is active

**Files:**
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/ChunkDao.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/emergency/AutoPeerSyncEngine.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/emergency/EmergencyModeService.kt`

**Interfaces:**
- `ChunkDao.observeAll(): Flow<List<ChunkEntity>>` emits deterministic Room inventory changes.
- `MeshRepository.observePeerInventory(): Flow<List<ChunkEntity>>` exposes the verified chunk inventory without exposing DAO ownership to the service.
- `AutoPeerSyncEngine.requestSyncSoon()` starts a sync for recently seen, non-busy peers immediately, bypassing only their normal successful-sync cooldown. It uses the current `localSummaryProvider` at session start so the new chunk is advertised.
- `EmergencyModeService` collects inventory changes only while the service is running. The service remains opt-in and does not start itself from a repository change.

- [x] Add the Room chunk observation query and repository Flow.
- [x] Extract peer session startup in `AutoPeerSyncEngine` so normal discovery and `requestSyncSoon()` share semaphore, busy-state and cleanup handling.
- [x] Implement `requestSyncSoon()` for peers seen within the existing 30-second visibility window; bypass the 60-second success cooldown only for this explicit inventory-change request.
- [x] Collect distinct inventory identities in `EmergencyModeService` and request expedited sync on changes; cover locally created chunks and chunks received from the signed feed through the same path. The current central feed manifest ID is `government-government-announcements`; the monitor also accepts `government-government-device-announcements` if that separate source is published. Device-local chunks use `government-device-announcements`.
- [x] Confirm the service contains no automatic start path and that only active Emergency Mode reaches the new collector.

### Task 3: Automatically upload Room outbox warnings when network is available

**Files:**
- Modify: `flutter/lib/data/government_api.dart`
- Modify: `flutter/lib/data/map_bridge.dart`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/online/GovernmentSyncManager.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/online/GovernmentSyncJob.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/bridge/FlutterMapBridge.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/MainActivity.kt`

**Interfaces:**
- `GovernmentApiClient.resolveBaseUri(): Future<Uri>` returns the normalized API base used by foreground requests; Android persists it through `MapBridge.configureGovernmentWarningUpload(Uri)` before local creation when available.
- `GovernmentSyncManager.flushPendingGovernmentWarnings(): Boolean` uploads the current Room outbox using `GovernmentSessionKeyStore.read()`. It returns `true` only for retryable network/server or response-integrity failures; no token, no pending rows, permanent authorization failure and a fully flushed batch return `false`.
- Each POST targets the persisted API base plus `government/warnings`, disables redirects, requires HTTPS outside local debug, sends the stored event JSON with `Authorization: Bearer`, and acknowledges only when the response event id and payload hash match the Room row.
- `GovernmentSyncJob.schedulePendingUpload(context)` schedules a persisted `NETWORK_TYPE_ANY` one-off job, independent of the periodic feed download setting. The one-off job retries retryable failures with JobScheduler backoff; the periodic feed job also flushes the outbox before its download.

- [x] Implement the bounded upload loop: expire rows using the existing repository method, POST unexpired signed events, verify response identity, and mark uploaded by the matching event id/hash.
- [x] Persist the actual Flutter API base URL for the native worker so custom release hosts and the Android debug API port use the same endpoint as foreground uploads.
- [x] Treat an identical event/hash already in `UPLOADED` or `PUBLISHED` state as successful acknowledgement to make foreground/background retries safe when they overlap.
- [x] Add the network-constrained one-off job id and retry behavior while preserving the current periodic government feed download job.
- [x] Schedule upload after successful local warning creation, when the encrypted session token is written, and on Activity resume so pending rows recover after app restarts.
- [x] Keep workbench foreground retries and their visible status refresh; they may overlap safely because server retries are idempotent.
- [x] Ensure token clearing does not delete queued warnings and a later authenticated session schedules them again.

### Task 4: Preserve signed-feed reception on Web and document the resulting lifecycle

**Files:**
- Review: `flutter/web/nlsc_government_feed.js`
- Review: `flutter/lib/app/map_app_controller.dart`
- Modify: `docs/government-workbench.md`
- Modify: `docs/government-online-sync.md`

**Interfaces:**
- Web continues to call the existing signed-feed loader, which verifies the central feed and device-signed announcement before updating the cached notification snapshot. It does not receive a device-authenticated upload path or BLE functionality.
- Android downloaded chunks continue through `GovernmentSyncManager` and `MeshRepository.ingestChunk`; Task 2's active-service inventory observer makes verified downloads eligible for Mesh relay.

- [x] Verify the current Web parser accepts the published `official.announcement` event and rejects invalid signatures without showing it as verified.
- [x] Document that local Android display, Mesh eligibility and cloud upload are independent states; explain the Emergency Mode prompt, background retry limits and signed-feed publication state.
- [x] Document Web and Android feed reception separately and state that manual Government Data Update is no longer a prerequisite for creator-local visibility or cloud upload.

### Task 5: Source-level completion review

- [x] Review every changed call path against the spec, confirm only the plan's files changed, and inspect `git diff --check` plus `git status --short`.
- [x] Do not report device/runtime acceptance: no connected Android hardware or `adb` is available in this environment.
- [ ] Automated test and hardware acceptance steps remain pending unless the user explicitly asks to run them.

---

## Follow-up: Refresh signed notifications after cloud announcement mutations

**Root cause:** The workbench screenshot includes the `帳號管理` tab, which `ProfileScreen` shows only for `SYSTEM_ADMIN`. That role uses the cloud `createAnnouncement` API instead of the Android device-signing path. The server responds `publication_status: QUEUED`; the central publisher emits a signed feed on its poll loop (5 seconds by default). The existing local refresh callback only covers device-signed creates, while cloud create/revise/retract only refreshes the workbench. Therefore the notification controller remains stale until the user runs Government Data Update.

**Goal:** After a successful cloud announcement create, revision, or retraction, automatically receive the resulting signed feed on Android and Web. Keep the signed-feed verification boundary; never insert the unsigned API response into notifications or Mesh.

**Files:**
- Modify: `flutter/lib/data/government_api.dart`
- Modify: `flutter/lib/app/map_app_controller.dart`
- Modify: `flutter/lib/screens/government_workbench_screen.dart`
- Modify: `flutter/lib/data/offline_government_feed.dart`
- Modify: `flutter/lib/data/offline_government_feed_stub.dart`
- Modify: `flutter/lib/data/offline_government_feed_web.dart`
- Modify: `flutter/web/nlsc_government_feed.js`

**Implementation:**
- Wrap cloud create/revise/retract mutations in `GovernmentAuthController` and notify the app controller with the returned `event_id`, `event_version`, and whether the event was retracted.
- Android triggers `syncGovernmentNow()`, reads the verified Room snapshot, and retries briefly while the publisher is processing the queued mutation.
- Web polls the signed feed metadata revision (signature-verified, without downloading chunks on every poll), then loads and verifies the full signed feed when a newer release appears.
- Stop when create/revision reaches the expected event version, or when a newer signed release removes the retracted event from the active local snapshot. Keep the existing periodic sync as recovery if the bounded foreground retry expires.
- Preserve the current immediate Room snapshot callback for device-signed Android creates; do not change Emergency Mode or Mesh opt-in behavior.

**Acceptance:**
- [ ] Runtime: `SYSTEM_ADMIN` Android create/revise/retract updates the local notification list automatically after the signed release is available; no manual Government Data Update is needed.
- [ ] Runtime: Web refreshes after the signed release is available and only displays the verified signed feed.
- [ ] Runtime: device-signed Android creates remain visible immediately from Room.
- [x] Source/build: `flutter analyze`, Android debug build and emulator APK install, Web build, and `git diff --check` succeeded. No tests were added or run.
- [ ] Runtime acceptance on the emulator and Web remains pending; source/build verification does not prove a live announcement mutation.
