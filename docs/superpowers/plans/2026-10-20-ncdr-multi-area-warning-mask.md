# NCDR Multi-Area Warning Mask Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` task by task. Steps use checkbox syntax for tracking.

**Goal:** Render the 55 townships in the NCDR wind alert as a tappable area mask without a misleading single marker.

**Architecture:** The collector resolves each CAP area against the existing official catalog and publishes simplified display polygons while retaining the raw CAP privately. The signed event carries match metadata. Shared Flutter code renders and selects the NCDR area in both Web and Android.

**Tech Stack:** Node.js collector and signed feed, Dart/Flutter, MapLibre, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-20-ncdr-multi-area-warning-mask-design.md`

## Global Constraints

- Preserve existing source registry, signing and feed architecture.
- Keep complete CAP raw data and full official boundaries on Server.
- Web and Android change in the same batch; leave Git uncommitted.
- Do not color a partial or unverified affected-area match.

## Review Focus

- CAP areas with mixed `台` and `臺`: exact normalized name must match.
- Source polygon present: must retain precedence over derived administrative areas.
- Partial or zero matches: never color the first catalog feature by fallback.
- Offshore polygons and holes: remain valid after display simplification.
- Old signed event version in local cache: new version replaces the geometry after sync.

### Task 1: Collector resolves CAP areas

**Files:** `pipeline/sources/ncdr.mjs`, `pipeline/sources/areas.mjs`, `pipeline/test/cwa-ncdr.test.mjs`, `pipeline/test/taiwan-sources.test.mjs`.

**Interfaces:** `createAreaResolvers(catalog)` supplies a cached display boundary resolver. NCDR normalized attributes add `affected_area_ids`, `area_match_complete`, and optional `unmatched_area_names`.

- [x] Add a failing CAP test with two named towns and no geometry; assert both boundaries appear and no first-feature fallback occurs.
- [x] Add tests for partial and village matches, source polygon precedence, and island polygons.
- [x] Resolve CAP areas individually and validate full county/town names; simplify only derived display boundaries.
- [x] Run focused Node tests and inspect all assertions.

### Task 2: Shared Flutter area rendering and selection

**Files:** `flutter/lib/data/map_models.dart`, `flutter/lib/data/maplibre_overlay.dart`, `flutter/lib/widgets/map_canvas.dart`, `flutter/lib/widgets/map_layers.dart`, `flutter/lib/screens/map_screen.dart`, `flutter/lib/widgets/feature_details_sheet.dart`, and focused Flutter tests.

**Interfaces:** NCDR multi-area predicate comes from signed event attributes. Existing layer switch governs CWA and NCDR masks; MapLibre rendered-feature query returns an event identity.

- [x] Add tests for NCDR area mask filtering, marker suppression, and incomplete-match presentation.
- [x] Render and update NCDR fill/outline only for complete live areas; keep point marker hit tests first, then area hit tests.
- [x] Replace notification focus for multi-area warnings with a bounding-box camera update; preserve existing single-point focus.
- [x] Run focused Dart tests and analyze Flutter code.

### Task 3: Live integration and release checks

**Files:** deployment documentation if commands or expected fields change.

- [x] Build the collector and Web client without changing committed state.
- [x] Refresh the local signed feed from the current raw CAP and verify all 55 area IDs, non-Matsu-only bbox and payload size.
- [ ] Verify Web and Android visual behavior, switch, area tap, notification focus, and expiration.
- [ ] Run `git diff --check`; report any unverified runtime boundary.
