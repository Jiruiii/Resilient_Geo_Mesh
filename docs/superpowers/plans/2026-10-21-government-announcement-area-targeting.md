# Government Announcement Area Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 政府公告依類別顯示，發布者可從座標取得並調整行政區影響範圍，使用者可用本機接收區域篩選通知與未讀數。

**Architecture:** 由 pipeline 從正式縣市及鄉鎮邊界產生輕量行政區目錄與含完整邊界座標的版本化空間索引。Flutter 共用此目錄支援 Web、Android 的公告編輯、接收區域及本機通知比對；伺服器以同版本目錄驗證區域 ID，Android 將區域寫入裝置簽章事件，中央發布器保留現有全國 transport bucket。

**Tech Stack:** Node.js pipeline/server、Flutter/Dart Web 與 Android 共用 UI、Android Kotlin event-v0 簽章、SharedPreferences。

**Spec:** [`docs/superpowers/specs/2026-10-21-government-announcement-area-targeting-design.md`](../specs/2026-10-21-government-announcement-area-targeting-design.md)

## Global Constraints

- Web 與 Flutter／Android 在同一批完成；Flutter 共用介面涵蓋 Web 與 Android。
- 通知分類依六種政府公告類別顯示「政府公告」前綴；避難收容使用 `MapIconCatalog.shelter`，物資站保留 `MapIconCatalog.supplyStation`。
- 點位推定最小支援行政區鄉鎮市區，發布者可改選、多選或明確選全台；未選範圍不得預設全台。
- `attributes.affected_area_ids` 是新事件的影響範圍；`attributes.area_id` 維持 `tw.national`，只供既有 feed 分組及舊版相容。
- 事件簽章涵蓋 `affected_area_ids`；伺服器使用正式行政區目錄拒絕未知 ID。
- 本機接收偏好缺少或無法讀取時預設 `tw.national`；行政區比較需支援縣市／鄉鎮階層及舊事件 `area_id` fallback。
- 接收偏好只篩本機通知清單、分類、未讀數及全部已讀；不得改動地圖事件、資料下載範圍、feed 路由或伺服器推播。
- 無法比對區域的事件保留可見；設定畫面說明接收區域只能篩選已同步到本機的事件。
- 不加入半徑、多邊形或村里範圍；保留現有道路、避難收容、物資站必須有地圖位置的規則。
- 不執行 `git add`、commit、push 或 merge；交付時保留工作樹變更。

## Review Focus

- 座標落在邊界或多個候選面：只在唯一鄉鎮命中時自動預選；零或多筆候選要求發布者手動確認。由 Task 2 的 resolver 測試涵蓋。
- 空白、重複、父子重疊或不存在的區域 ID：用戶端正規化父子重複，伺服器拒絕未知或空清單。由 Task 4 的 workbench service 測試涵蓋。
- 縣市／鄉鎮、全台與舊事件範圍交疊：縣市選項涵蓋子鄉鎮、鄉鎮接收涵蓋該縣市級公告、全台公告符合所有設定；缺少新欄位時沿用 `area_id`。由 Task 5 的 matcher 測試涵蓋。
- 接收區域變更後的未讀及全部已讀：篩選外事件不計入未讀或 mark-all-read。由 Task 5 的 controller 測試涵蓋。
- 偏好缺失、格式錯誤、目錄版本不符或空間索引無法載入：通知採全台可見；工作台不得在無法推定時自動發布全台公告。由 Task 2、Task 5 的載入及 fallback 測試涵蓋。

---

### Task 1: 產生正式行政區目錄與離線空間索引

**Files:**
- Create: `pipeline/sources/administrative-area-index.mjs`
- Modify: `pipeline/cli.mjs`
- Modify: `pipeline/README.md`
- Modify: `flutter/pubspec.yaml`
- Create: `data/administrative-area-directory.json` (generated)
- Create: `flutter/assets/map/boundaries/taiwan-administrative-area-directory.json` (generated)
- Create: `flutter/assets/map/boundaries/taiwan-administrative-area-index.json` (generated)
- Create: `flutter/tool/benchmark_taiwan_area_index.dart`
- Test: `pipeline/test/administrative-area-index.test.mjs`

**Interfaces:**
- `generateAdministrativeAreaAssets({ counties, towns, sourceVersion })` returns `{ directory, spatialIndex }`; IDs must match `normalizeAreaCatalog` (`tw.<COUNTYCODE>` and `tw.<TOWNCODE>`).
- Directory schema `taiwan-area-directory-v1` contains area ID, level, parent county ID, county name and town name. Spatial schema `taiwan-area-index-v1` contains the same metadata, source SHA-256, EPSG:4326 bounds and unmodified Polygon/MultiPolygon coordinates; omit raw source properties.
- CLI command: `node pipeline/cli.mjs area-index --county <county.geojson> --town <town.geojson> --directory-out <data/administrative-area-directory.json> --flutter-directory-out <flutter asset path> --spatial-out <flutter spatial asset path> --android-area-ids-out <Android source path>`.

- [ ] Add the index builder using the existing area ID normalization and preserve every source coordinate without simplification or rounding.
- [ ] Add the CLI output options and deterministic source hash; write identical directory JSON to the server and Flutter destinations.
- [ ] Add the two Flutter assets to `pubspec.yaml` and document regeneration from `data/boundaries/geojson/county.geojson` and `town.geojson`.
- [ ] Add generator tests asserting 22 counties, 368 towns, stable IDs/parent links, source hash, and exact input polygon coordinates in the output.
- [ ] Run the generator and record output byte size and gzip size; keep the compressed spatial asset at or below the 14.7 MB compressed town source. If needed, encode coordinates as Float64 values with offsets; do not simplify or round official coordinates.

### Task 2: 建立 Flutter 行政區目錄、空間查詢及共用選擇器

**Files:**
- Create: `flutter/lib/data/taiwan_administrative_area_directory.dart`
- Create: `flutter/lib/data/taiwan_administrative_area_index.dart`
- Create: `flutter/lib/widgets/administrative_area_selector.dart`
- Modify: `flutter/tool/benchmark_taiwan_area_index.dart`
- Test: `flutter/test/taiwan_administrative_area_test.dart`
- Test: `flutter/test/administrative_area_selector_test.dart`

**Interfaces:**
- `TaiwanAdministrativeAreaDirectory.load()` loads the metadata-only asset and provides `areaById`, `childrenOf`, `displayName`, and `normalizeSelection(Set<String>)`.
- `TaiwanAdministrativeAreaIndex.load(directory)` loads the version-matched polygon asset. `resolvePoint(GeoPoint point)` returns all matching town candidates; only one candidate is an automatic suggestion. Use bbox rejection before full Polygon/MultiPolygon point-in-polygon checks and account for polygon holes.
- `AdministrativeAreaSelector.show(context, {directory, selectedIds, allowNational})` returns a normalized selected ID set or `null` on cancel. It provides a searchable county/town hierarchy and explicit `tw.national` selection.
- When a county is selected, remove selected descendant towns; selecting a town while its county is selected changes the selection to the town. `tw.national` is mutually exclusive with all other IDs.

- [ ] Implement metadata loading, source version consistency checks, parent/child lookup and human-readable names.
- [ ] Implement bounded point lookup; return zero or multiple matches without silently choosing a county or national scope.
- [ ] Implement selection normalization and the shared searchable county/town selector with an explicit whole-Taiwan option.
- [ ] Test a unique point, a point outside all polygons, a boundary point with multiple candidates, parent/child normalization, and selector cancel/national behavior.
- [ ] Run Flutter analyzer and the benchmark command; report index load time, peak retained memory and lookup latency for representative northern, central, southern, eastern, offshore and no-match coordinates. Run the same Dart resolver workload for Web and Android targets.

### Task 3: 依座標預判並可調整公告影響範圍

**Files:**
- Modify: `flutter/lib/screens/government_workbench_screen.dart`
- Modify: `flutter/test/government_announcement_editor_test.dart`

**Interfaces:**
- The editor keeps `location` and `affectedAreaIds` as separate values. Existing records initialize from `location` and `affected_area_ids`.
- A selected point is resolved by `TaiwanAdministrativeAreaIndex.resolvePoint`; one match offers that town as the suggested range. Zero or multiple matches show the candidates/manual selector and never set `tw.national` automatically.
- The editor opens `AdministrativeAreaSelector` to add towns, replace them with a county or explicitly choose all Taiwan. Changing a point after manual range edits shows the new suggestion and requires an explicit apply action to replace the current range.
- Submit body includes required `affected_area_ids`; publishing is disabled until the scope is non-empty and location/category/expiry rules pass. Point outside selected areas shows a warning and requires an explicit acknowledgement before submit.

- [ ] Load the metadata and spatial index when opening the government announcement editor; show a recoverable error and block publication if index loading fails.
- [ ] Initialize a new point's unique town suggestion and preserve independent manual scope edits when the point changes.
- [ ] Add the range selector, selected area names, explicit national option, point/range mismatch acknowledgement and no-scope validation.
- [ ] Include normalized `affected_area_ids` in create/revise requests; preserve the current location requirement for ROAD, SHELTER and SUPPLY_STATION.
- [ ] Test coordinate suggestion, manual override, multiple areas, national opt-in, mismatch acknowledgement, and blocking an empty scope.

### Task 4: 驗證並簽署公告影響區域

**Files:**
- Modify: `server/src/government/entrypoint.mjs`
- Modify: `server/src/government/app.mjs`
- Modify: `server/src/government/workbench-service.mjs`
- Modify: `server/src/government/publisher-worker.mjs`
- Review: `server/src/government/postgres-store.mjs`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/bridge/MapBridgeProtocol.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/report/GovernmentWarningFactory.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/report/GovernmentWarningFactoryTest.kt`
- Modify: `android/app/src/test/java/com/resilientgeo/mesh/bridge/MapBridgeProtocolTest.kt`
- Modify: `server/test/government-workbench.test.mjs`

**Interfaces:**
- Government API startup loads `data/administrative-area-directory.json` from `dirname(config.areaCatalogPath)` and passes its ID/parent directory to `buildGovernmentApp`; production startup fails closed if the directory is missing or invalid.
- `validateAnnouncement(input, now, areaDirectory)` requires a non-empty, unique `affected_area_ids` list; allow `tw.national` alone or canonical county/town IDs only. Store it with the announcement while retaining `area_id: tw.national`.
- `validateGovernmentWarning(event, now, areaDirectory)` applies the same ID rules to the already signed device event. The event payload includes `affected_area_ids` before `payload_hash` and Ed25519 signature generation.
- `announcementEvent(row, now)` publishes `affected_area_ids`; for previously stored rows without it, publish the legacy `area_id` as the fallback. The existing national feed chunk routing remains unchanged.
- `postgres-store.mjs` already persists the complete announcement as JSONB; no SQL migration is needed for this field.

- [ ] Load and validate the compact canonical directory at server startup, then inject it into the workbench service.
- [ ] Validate create/revise input IDs and persist `affected_area_ids`; keep the existing category, expiry and location validation.
- [ ] Validate device-signed event IDs against the directory without changing event-v0 identity, signature algorithm or national `area_id`.
- [ ] Parse `affected_area_ids` through the Android bridge and add it to the event attributes before calculating payload hash/signature.
- [ ] Publish the field in central-signed events and preserve a national fallback for existing stored rows.
- [ ] Test unknown/empty/duplicate IDs rejection, valid town/county/national values, altered signed attributes failing verification, central publication and old-row fallback.

### Task 5: 儲存接收區域並先篩本機通知與未讀數

**Files:**
- Create: `flutter/lib/data/notification_area_matcher.dart`
- Create: `flutter/lib/screens/notification_area_selection_screen.dart`
- Modify: `flutter/lib/app/map_app_controller.dart`
- Modify: `flutter/lib/screens/profile_screen.dart`
- Modify: `flutter/lib/main.dart`
- Test: `flutter/test/notification_area_matcher_test.dart`
- Modify: `flutter/test/map_app_controller_test.dart`
- Modify: `flutter/test/profile_screen_test.dart`

**Interfaces:**
- `eventMatchesNotificationAreas(event, selectedIds, directory)` matches `tw.national` against all; a selected county against its towns; and a selected town against itself or a county-level event covering its county. If no event area ID resolves in the directory, return visible.
- `MapAppController.notificationAreaIds` is persisted under `map.notification_area_ids`; missing/corrupt preferences or directory load errors resolve to `{tw.national}`.
- `MapAppController.notificationEvents` applies area matching after existing expiry/source/dismissal checks. Existing `unreadEvents`, `notificationCount`, category options and mark-all-read continue to derive from this filtered list.
- Profile opens a shared Web/Android area selection screen. Display the selected names and the notice that this only filters events already synced locally; leave `government_feed.area` and Android sync configuration untouched.

- [ ] Add preference load/save and area directory loading to `MapAppController`; notify listeners after a user changes selection.
- [ ] Filter only `notificationEvents`; do not change `events`, map snapshots, source feeds or `government_feed.area`.
- [ ] Add profile entry and a searchable multi-select screen using Task 2's directory and selector.
- [ ] Add tests for national/county/town matching, county-level notices reaching a selected town, legacy `area_id`, unknown-area visibility, malformed preference fallback, unread count and mark-all-read scope.

### Task 6: 顯示政府公告分類、圖示與影響範圍

**Files:**
- Modify: `flutter/lib/data/alert_category.dart`
- Modify: `flutter/lib/widgets/map_layers.dart`
- Modify: `flutter/lib/screens/notifications_screen.dart`
- Modify: `flutter/lib/screens/map_screen.dart`
- Modify: `flutter/lib/main.dart`
- Modify: `flutter/lib/widgets/feature_details_sheet.dart`
- Modify: `flutter/lib/screens/government_workbench_screen.dart`
- Modify: `flutter/test/alert_category_test.dart`
- Modify: `flutter/test/map_layers_test.dart`
- Modify: `flutter/test/notifications_screen_test.dart`

**Interfaces:**
- Government announcement category labels are `政府公告・安全提醒`, `政府公告・天氣`, `政府公告・道路`, `政府公告・避難收容`, `政府公告・物資站`, `政府公告・其他`; other sources keep current labels.
- `MapIconCatalog.forEvent(event)` uses one category mapping for map markers and notification cards: `SHELTER -> shelter`, `SUPPLY_STATION -> supplyStation`; other government categories use their matching semantic glyph and unknown categories fall back to disaster.
- A shared formatter reads new `affected_area_ids`, resolves county/town names through `TaiwanAdministrativeAreaDirectory`, and uses old `area_id` when the new list is absent.

- [ ] Add government-aware category labels without merging them into same-named NCDR/CWA groups.
- [ ] Map government categories to the shared event icon catalog; keep supply station styling and correct shelter icon on map and notification cards.
- [ ] Show resolved impact-area names in notification details, map feature details and the government workbench list; retain nationwide rendering for legacy announcements.
- [ ] Test all six groups, shelter/supply icon parity, legacy nationwide rendering and multi-area labels.

### Task 7: Cross-platform contract review and acceptance

**Files:**
- Review: `flutter/lib/main.dart`
- Review: `flutter/lib/app/map_app_controller.dart`
- Review: `server/src/government/workbench-service.mjs`
- Review: `android/app/src/main/java/com/resilientgeo/mesh/report/GovernmentWarningFactory.kt`
- Review: `pipeline/test/administrative-area-index.test.mjs`
- Review: `server/test/government-workbench.test.mjs`
- Review: Flutter and Android tests listed above
- Modify: `docs/government-workbench.md`

- [ ] Run the focused pipeline, server, Flutter and Android tests named in Tasks 1–6; record Web and Android outcomes separately.
- [ ] Run `flutter analyze`, Android debug compilation, Web build and `git diff --check`.
- [ ] Review that the map event stream is unchanged, notification filter affects list/count/all-read together, download scope remains separate, legacy events remain visible, and new signed fields are verified.
- [ ] Document area asset regeneration, the `affected_area_ids` contract, legacy fallback, local preference behavior and the distinction from government download scope.
- [ ] Report any unavailable live Web or device acceptance separately; do not claim it from build/test results.
