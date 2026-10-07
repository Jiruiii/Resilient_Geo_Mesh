# 醫療院所部分定位資料發布 Implementation Plan

> **For agentic workers:** Use the existing repository architecture and complete the steps in order. This plan intentionally leaves tests and commits out because this session's higher-priority instructions prohibit adding/running tests and committing without an explicit request.

**Goal:** Publish the verified medical points from each complete MOHW roster, keep unresolved and ambiguous records searchable with null geometry, and expose auditable partial counts through the existing API.

**Architecture:** Keep the current collector, signed static-layer publisher, source-status API, and layer IDs. Reclassify duplicate identities before creating the signed point layer; validate the resulting point/directory accounting before accepting a partial result; publish both layers behind the existing atomic release pointer. Retain the existing Web and Android loaders because both already verify Ed25519 bundles, accept null-geometry directory records, and enforce the 512-chunk limit.

**Tech Stack:** Node.js ESM collector and publisher, existing Ed25519 feature bundle contract, Kotlin Android verifier/loader, Flutter Web JavaScript loader.

**Spec:** [2026-10-07-medical-partial-release-design.md](../specs/2026-10-07-medical-partial-release-design.md)

## Global Constraints

- Map points require a trusted coordinate source, valid WGS84 coordinates and county, and a unique institution code and feature ID.
- Unresolved or identity-ambiguous directory entries have `geometry: null` and `point_feature_id: null`.
- Never guess, synthesize, or silently merge institution identities or coordinates.
- Keep the existing Ed25519 layer format, API routes, layer IDs, and client trust keys.
- Keep each published medical layer at or below 512 chunks; use server-side chunk sizing and never raise the Web or Android limit.
- Publish the point layer, directory layer, and medical source status from the same collection result behind one release-pointer update.
- Preserve last-known-good layers when source, accounting, signature, or chunk validation fails.
- Preserve existing working-tree changes; do not stage, commit, push, deploy, or add/run tests in this task.

## Review Focus

- Duplicate institution codes include every row in the ambiguous group in the directory and none in the point layer.
- A repeated or colliding feature ID cannot pass as a unique institution point.
- A missing coordinate or county keeps the row searchable but never creates a marker.
- Invalid source shape or inconsistent counts prevent release and leave the previous pointer active.
- A legacy medical layer with more than 512 chunks is rebuilt even if its feature content is otherwise unchanged.

---

### Task 1: Partition the roster into safe points and directory-only rows

**Files:**
- Modify: `pipeline/sources/medical.mjs`
- Modify: `pipeline/lib/source-collector.mjs`
- Modify: `pipeline/lib/medical-directory.mjs`

**Interfaces:**
- Consume the existing `normalizeMedicalFacilitiesReport()` and `mergeMedicalCoordinates()` outputs.
- Produce the safe point `features`, directory `unresolved`/`excluded` rows, and one `coordinate_report` whose counts reconcile to the parsed roster.

- [ ] Group all roster rows by normalized institution code and point `feature_id` after coordinate matching.
- [ ] Move every row in a duplicate-code or duplicate-point-ID group out of the point list; retain it in the directory with `geometry_status=unresolved`, null geometry/link, and an identity-conflict reason.
- [ ] Add deterministic unique directory IDs for repeated business codes, using a source row ID when present and a stable row fingerprint plus deterministic collision suffix otherwise.
- [ ] Recompute `matched_count`, `unresolved_count`, `excluded_count`, duplicate group/affected-row/extra-row counts, unresolved reason counts, and county coverage after partitioning.
- [ ] Set the medical result status to `partial` when unresolved, identity-conflict, excluded, or coordinate-query failures remain; keep an empty safe-point layer non-publishable so it cannot replace the current map with an empty one.
- [ ] Require a fully retrieved and parsed MOHW roster (`roster_complete=true`); coordinate-query partiality may release safe points, but a truncated roster may not.

### Task 2: Validate safe partial results and expose current counts

**Files:**
- Modify: `server/src/collector/medical-release-policy.mjs`
- Modify: `server/src/collector/collector-runner.mjs`
- Modify: `server/src/publisher/release-publisher.mjs`
- Modify: `server/src/routes/source-status.mjs`

**Interfaces:**
- `isPublishableResult(result)` accepts `ok`, `not_modified`, or structurally valid `partial` medical results only.
- Public medical status carries source, matched, unresolved, excluded, duplicate-identity, and reason counts from the same result.

- [ ] Replace the all-located gate with structural validation of source-count reconciliation, safe unique point IDs/codes, verified coordinates/counties, directory null-geometry states, and valid point links.
- [ ] Validate partial county coverage while still requiring every published point to have a valid county and every county/master aggregate to reconcile.
- [ ] Include duplicate institution-code and duplicate point-ID reason counts in the public medical status; reject malformed or contradictory count summaries.
- [ ] Write successful medical source status only after the release pointer activates both verified bundles; continue publishing failure status without changing the layer pointer.
- [ ] Keep source/network/format/signature failures on the failure path so no new layer is activated and the last-known-good pointer remains in use.

### Task 3: Bound and repack server-produced medical chunks

**Files:**
- Modify: `server/src/publisher/release-publisher.mjs`

**Interfaces:**
- `publishStaticLayer()` builds medical point and directory bundles using the current 256 KiB target first, with a bounded larger server-side target only if required to meet the 512-chunk client cap.
- A bundle that still exceeds 512 chunks fails before pointer activation.

- [ ] Apply the 512-chunk cap to `taiwan-medical` and `taiwan-medical-directory` bundles before writing them as the current release.
- [ ] Increase medical chunk target in bounded steps only when the 256 KiB output would exceed 512 chunks; fail closed if the cap still cannot be met.
- [ ] Bypass the unchanged-bundle shortcut when the previous medical manifest exceeds 512 chunks, so legacy 747-chunk releases can be repacked.
- [ ] Allocate the next unused immutable layer version so a failed pre-pointer publish cannot block a later retry with an orphaned version directory.
- [ ] Keep both medical layer versions in the same `commitReleasePointer()` call after both bundles and the government feed verify successfully.

### Task 4: Confirm Web and Flutter Android compatibility with the signed partial bundle

**Files reviewed:**
- `flutter/web/nlsc_static_layers.js`
- `android/app/src/main/java/com/resilientgeo/mesh/trust/FeatureVerifier.kt`
- `android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt`

**Interfaces:**
- Both clients continue to consume `taiwan-medical` and `taiwan-medical-directory` from the existing manifest/chunk routes, verify signatures, and resolve a directory point only when `geometry_status=located`.

- [ ] Confirm both clients accept unresolved/excluded directory entries only with null geometry and null point link.
- [ ] Confirm both clients continue to reject a manifest over 512 chunks; do not change either limit.
- [ ] Compare the server's published point/directory manifest versions against both client loader contracts and report platform-specific evidence separately.

## Completion Criteria

- Partial medical results pass the release gate only when the point subset and directory counts reconcile to the same successfully parsed roster.
- Duplicate-code and duplicate-feature-ID rows never enter the map point layer.
- Source status reports `partial` with actual matched, unresolved, excluded, and duplicate counts.
- Medical manifests are at or below 512 chunks, including a forced rebuild of a legacy over-limit bundle.
- Web and Flutter Android retain signature validation and consume the same pointer-selected versions without changing their chunk limits.
- Tests, runtime download, emulator, browser, and production deployment remain unverified in this task unless separately requested and authorized.
