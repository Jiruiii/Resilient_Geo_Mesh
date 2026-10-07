package com.resilientgeo.mesh.ingest

/** Reference [EventStore] used by unit tests; keeps parity with the `new Map()` store in the Node tests. */
class InMemoryEventStore : EventStore {
    private val byKey = LinkedHashMap<Pair<String, String>, StoredEvent>()
    private val versionFloors = LinkedHashMap<Pair<String, String>, Int>()

    override fun find(namespace: String, eventId: String): StoredEvent? = byKey[namespace to eventId]

    override fun findUnderOtherNamespace(eventId: String, excludingNamespace: String): StoredEvent? =
        byKey.values.firstOrNull { it.eventId == eventId && it.namespace != excludingNamespace }

    override fun save(event: StoredEvent) {
        val key = event.namespace to event.eventId
        byKey[key] = event
        if ((versionFloors[key] ?: Int.MIN_VALUE) < event.eventVersion) versionFloors.remove(key)
    }

    override fun versionFloor(namespace: String, eventId: String): Int? =
        versionFloors[namespace to eventId]

    override fun rememberVersion(namespace: String, eventId: String, eventVersion: Int) {
        val key = namespace to eventId
        versionFloors[key] = maxOf(versionFloors[key] ?: Int.MIN_VALUE, eventVersion)
    }

    override fun clearVersionFloor(namespace: String, eventId: String) {
        versionFloors.remove(namespace to eventId)
    }

    override fun all(): List<StoredEvent> = byKey.values.toList()
}
