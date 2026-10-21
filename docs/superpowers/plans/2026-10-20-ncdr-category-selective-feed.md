# NCDR Category-Selective Feed Implementation Plan

> **For agentic workers:** Implement this plan inline, task by task. Keep the current `fixui` worktree and preserve all pre-existing uncommitted changes.

**Goal:** Keep complete NCDR data on the Server and make Web and Android fetch only screenshot-approved categories in their selected geographic scope.

**Architecture:** Keep the existing signed `government-feed-v1` and immutable chunk routes. Add signed category routing metadata to NCDR manifest chunks, publish every NCDR event in area/category buckets, and have Android and Web validate the full index but download only matching chunks. Keep the complete raw source snapshot private on the Server, prune old excluded client records in bounded batches, and keep the Android-to-Flutter bridge payload compact.

**Tech Stack:** Node.js collector/publisher, signed JSON manifests/chunks, Kotlin Room and Flutter method/event channels, Flutter Web IndexedDB.

**Spec:** [`docs/superpowers/specs/2026-10-20-ncdr-category-selective-feed-design.md`](../specs/2026-10-20-ncdr-category-selective-feed-design.md)

## Global Constraints

- Preserve the existing signed feed, chunk, event, Mesh, and last-known-good offline-cache trust boundaries.
- Keep all full NCDR source snapshots in Server private storage; do not filter source collection or delete source records to satisfy App display rules.
- Use the screenshot category taxonomy. Do not fetch or expose `other`, water supply, marine pollution, or fire-safety inspection failures; keep ordinary fire, high-temperature, and national forest recreation alerts.
- Web and Flutter/Android changes ship in this same implementation batch.
- Keep the existing `fixui` checkout and all pre-existing uncommitted changes; do not stage, commit, push, or merge.
- Do not add or run automated tests in this execution. Run source/build checks only and report runtime acceptance separately.

## Review Focus

- A signed category index must not let a mismatched chunk be routed under another category; verify manifest category against every signed event after chunk download.
- Old manifests and old Room rows must remain readable during migration, and stale excluded records must be pruned without loading the whole database into memory.
- A failed or partial feed refresh must leave the previous verified selected cache intact on both platforms.
- Mesh ingestion must not reintroduce excluded NCDR categories or advertise old mixed-category chunks.
- `source_record` must remain in Server private source storage but must not inflate the Android Flutter bridge snapshot.

---

### Task 1: Publish signed NCDR area/category chunks

**Files:** `pipeline/sources/ncdr.mjs`, `pipeline/lib/bundle.mjs`, `pipeline/lib/contract.mjs`, `pipeline/lib/government-feed.mjs`, `pipeline/lib/government-feed-v2.mjs`, `schemas/manifest-v0.schema.json`, `pipeline/README.md`, `docs/central-server-runbook.md`

- [x] Normalize legacy cached NCDR events from the retained raw/private source record so the next publication has a category code even when the upstream endpoint is not modified.
- [x] Bucket NCDR chunks by area, existing theme, and `ncdr_category_code`; sign the category code in each manifest entry and use it in stable chunk identity/order.
- [x] Verify category-to-event agreement in the publisher; preserve every active event in the Server release while omitting duplicated raw `source_record` from public signed event payloads.
- [x] Keep raw and normalized source cache data in the Server private store, and document Server-first rollout.
- [x] Run Node syntax checks and inspect the produced schema/source diff (no automated tests in this run).

### Task 2: Select and safely cache Android chunks

**Files:** `android/.../GovernmentFeedSync.kt`, `android/.../GovernmentFeedVerifier.kt`, `android/.../GovernmentSyncManager.kt`, `android/.../OfficialEventSourcePolicy.kt`, `android/.../EventEntity.kt`, `android/.../EventDao.kt`, `android/.../AppDatabase.kt`, `android/.../EventMappers.kt`, `android/.../MeshRepository.kt`, `android/.../FlutterMapBridge.kt`, `android/.../MapBridgeProtocol.kt`, `android/.../EventPayloadMapper.kt`

- [x] Verify signed category metadata and per-selected-release byte limits, then download only screenshot-approved NCDR category chunks within the configured area.
- [x] Persist a queryable NCDR category code and compact bridge projection in Room with non-destructive migrations; classify/backfill legacy cached rows in bounded batches, deleting excluded rows and invalidating mixed-category relay chunks.
- [x] Reject excluded NCDR chunks arriving over Mesh; query only compact eligible event projections for Flutter and keep full signed/relay payloads out of the UI snapshot.
- [x] Keep existing offline rows when a selected-category sync fails.
- [ ] Confirm Android source compiles.

### Task 3: Select and safely cache Web chunks

**Files:** `flutter/web/nlsc_government_feed.js`, `flutter/lib/data/ncdr_category.dart`, `flutter/lib/data/government_feed_scope.dart`, `flutter/lib/data/offline_government_feed_web.dart`, `flutter/lib/app/map_app_controller.dart`, `flutter/lib/main.dart`, `flutter/lib/screens/profile_screen.dart`, `flutter/lib/screens/government_sync_screen.dart`, `flutter/lib/screens/notifications_screen.dart`

- [x] Verify the complete signed index but select only eligible NCDR manifest entries in the selected area; download and verify only selected chunks while retaining CWA and announcement handling.
- [x] Validate each selected manifest category against the signed event; revalidate/prune old IndexedDB cache to the selected category subset and preserve last-known-good data on failure.
- [x] Use the Android-compatible `all` / `taipei` scope selector in Web preferences and immediately reload the selected chunks when it changes.
- [x] Use the shared screenshot category policy for Web/Flutter notifications, unread counts, and map markers.
- [ ] Confirm Flutter Web source compiles.

### Task 4: Source/build review and delivery notes

**Files:** `docs/frontend-real-data-integration.md`, `docs/central-server-runbook.md`, all task files

- [x] Run `git diff --check`, Node syntax checks, and manifest schema JSON parsing. Flutter analysis/build could not start because the SDK attempted to write its lockfile outside the workspace's writable roots; Android build remains unverified.
- [x] Review the final diff against the spec and report Web and Flutter/Android changes, Server deployment order, build results, unverified live acceptance, and Git state separately.

