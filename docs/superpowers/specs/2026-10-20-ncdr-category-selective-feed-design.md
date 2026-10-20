# NCDR Category-Selective Feed Design

## Goal

Keep the complete NCDR source snapshot on the Server while Web and Android download, cache, display, and relay only the supported alert categories and configured geographic areas.

## Approved behavior

- The Collector continues to fetch and retain complete NCDR raw snapshots in the Server's private source store.
- The signed public government feed continues to include every current NCDR event, partitioned into independently selectable chunks by `area_id` and normalized NCDR category code.
- The signed manifest carries each chunk's `category_code`; the manifest signature binds the routing metadata. The chunk's event signatures remain unchanged as the integrity boundary.
- NCDR categories from the user's screenshot are eligible. `other`, `water_supply_alert`, `marine_pollution_alert`, and fire-safety inspection failures are ineligible. A fire warning remains eligible.
- Android and Flutter Web select chunks by the same area preference (`all` or `taipei`) and eligible category codes. `taipei` includes Taipei/New Taipei plus nationwide and unknown-area alerts; nationwide government announcements remain included.
- Both clients verify the complete feed and manifest metadata, then fetch and verify only selected chunks. The last verified, non-expired selected subset remains available offline; a failed update does not replace it.
- Old on-device NCDR events and relay chunks that do not match the eligible categories are removed in bounded batches. New ineligible NCDR chunks received through Mesh are rejected. Android backfills a compact Room bridge projection in one-row batches and queries that projection, so a legacy full CAP payload is not loaded into a single Flutter snapshot.
- Web, Flutter notifications, unread counts, map markers, and Android bridge snapshots use the same category rules. Android does not serialize the raw `source_record` into Flutter's in-memory bridge payload.
- Keep the existing `/feed.json` and immutable chunk routes. Deploy the category-aware Server release before distributing updated clients.

## Data and trust boundaries

- Server private source snapshots remain the complete upstream record set. Public normalized events keep the fields required for display, provenance, category classification, geometry, validity, and event verification; duplicated raw `source_record` payloads are not sent to clients.
- The feed and manifest remain signed. Category and area metadata are trusted only after manifest verification; downloaded event payloads still require existing chunk and event verification.
- An older manifest without `category_code` remains readable during rollout. Clients may use the legacy all-chunks behavior only until the Server publishes a category-aware release.
- NCDR full source event types/codes remain preserved as normalized classification metadata so exclusions can be audited without displaying the excluded alert.

## Acceptance

- Server private raw snapshot still contains complete NCDR source records and the signed release retains all active NCDR events, including `other` categories.
- Manifest chunks are independently selectable by both area and category; every emitted category agrees with all NCDR events in that chunk.
- Android and Web fetch only eligible NCDR chunk paths after category-aware publication, while preserving existing area and offline-cache behavior.
- `other`, water-supply, marine-pollution, and fire-safety inspection events are absent from client notifications, unread counts, maps, Room event cache, and Mesh relay inventory. Fire, high-temperature, and national-forest-recreation alerts remain eligible.
- A legacy large Room database can be pruned and loaded without constructing an unbounded event snapshot; raw NCDR source payloads are not copied over the Flutter bridge.
- Web and Android retain identical NCDR category behavior. Source/build verification is reported separately from live Server, browser, and device acceptance.
