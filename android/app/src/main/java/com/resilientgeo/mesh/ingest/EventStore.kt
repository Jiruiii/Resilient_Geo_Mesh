package com.resilientgeo.mesh.ingest

/**
 * Storage boundary for the apply rules in [EventIngestor]. This mirrors the
 * plain `Map` that `pipeline/lib/contract.mjs`'s `ingestEvent()` takes as
 * its `store` argument: [InMemoryEventStore] is a drop-in for JVM unit
 * tests (parity with the Node test suite), and `data.RoomEventStore` is the
 * on-device implementation backed by SQLite.
 *
 * The identity of an event is (namespace, event_id) — see
 * `docs/data-contract-v0.md` — so namespace isolation falls out of using
 * that pair as the lookup key rather than being special-cased anywhere.
 */
interface EventStore {
    fun find(namespace: String, eventId: String): StoredEvent?

    /** Any stored event with this `eventId` under a *different* namespace, if one exists. */
    fun findUnderOtherNamespace(eventId: String, excludingNamespace: String): StoredEvent?

    fun save(event: StoredEvent)

    /** Highest signed version retained after an expired payload is purged. */
    fun versionFloor(namespace: String, eventId: String): Int? = null

    /** Preserve replay protection while deleting the expired event document. */
    fun rememberVersion(namespace: String, eventId: String, eventVersion: Int) = Unit

    fun clearVersionFloor(namespace: String, eventId: String) = Unit

    fun all(): List<StoredEvent>
}
