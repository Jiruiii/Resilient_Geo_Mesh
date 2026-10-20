package com.resilientgeo.mesh.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface EventDao {

    // Synchronous lookups back the EventStore used by EventIngestor's apply
    // rules; callers are expected to run them off the main thread (the
    // ingest path already runs inside a coroutine on Dispatchers.IO).
    @Query("SELECT * FROM events WHERE namespace = :namespace AND eventId = :eventId LIMIT 1")
    fun findSync(namespace: String, eventId: String): EventEntity?

    @Query("SELECT * FROM events WHERE eventId = :eventId AND namespace != :excludingNamespace LIMIT 1")
    fun findUnderOtherNamespaceSync(eventId: String, excludingNamespace: String): EventEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertSync(entity: EventEntity)

    @Query("SELECT * FROM events ORDER BY namespace, eventId")
    fun allSync(): List<EventEntity>

    @Query(
        "SELECT * FROM events WHERE namespace LIKE 'official.%' AND " +
            "(namespace > :afterNamespace OR (namespace = :afterNamespace AND eventId > :afterEventId)) " +
            "ORDER BY namespace, eventId LIMIT :limit",
    )
    fun officialAfterSync(afterNamespace: String, afterEventId: String, limit: Int): List<EventEntity>

    @Query("SELECT namespace, eventId, eventVersion, expiresAt FROM events WHERE namespace LIKE 'official.%' ORDER BY namespace, eventId LIMIT :limit OFFSET :offset")
    fun officialExpiryPageSync(limit: Int, offset: Int): List<EventExpiryRow>

    @Query("UPDATE events SET ncdrCategoryCode = :categoryCode WHERE namespace = :namespace AND eventId = :eventId")
    fun updateNcdrCategoryCodeSync(namespace: String, eventId: String, categoryCode: String)

    @Query("UPDATE events SET bridgePayloadJson = :payloadJson WHERE namespace = :namespace AND eventId = :eventId")
    fun updateBridgePayloadJsonSync(namespace: String, eventId: String, payloadJson: String)

    @Query("SELECT * FROM events WHERE namespace = :namespace ORDER BY eventId")
    fun forNamespaceSync(namespace: String): List<EventEntity>

    /** Only for bounded crowd-report storage (MeshRepository.pruneCrowdInventory). */
    @Query("DELETE FROM events WHERE namespace = :namespace AND eventId = :eventId")
    fun deleteSync(namespace: String, eventId: String)

    @Query("SELECT eventVersion FROM event_tombstones WHERE namespace = :namespace AND eventId = :eventId LIMIT 1")
    fun versionFloorSync(namespace: String, eventId: String): Int?

    @Query("INSERT INTO event_tombstones(namespace, eventId, eventVersion, expiredAtEpochMillis) VALUES(:namespace, :eventId, :eventVersion, :expiredAtEpochMillis) ON CONFLICT(namespace, eventId) DO UPDATE SET eventVersion = MAX(event_tombstones.eventVersion, excluded.eventVersion), expiredAtEpochMillis = MAX(event_tombstones.expiredAtEpochMillis, excluded.expiredAtEpochMillis)")
    fun rememberVersionSync(namespace: String, eventId: String, eventVersion: Int, expiredAtEpochMillis: Long)

    @Query("DELETE FROM event_tombstones WHERE namespace = :namespace AND eventId = :eventId")
    fun clearVersionFloorSync(namespace: String, eventId: String)

    /** Drives the event-list / map UI so it updates live as ingestion writes new rows. */
    @Query("SELECT * FROM events ORDER BY namespace, eventId")
    fun observeAll(): Flow<List<EventEntity>>

    /** Avoids parsing and copying excluded NCDR payloads into the Flutter bridge. */
    @Query(
        "SELECT namespace, eventId, eventVersion, eventType, severity, expiresAt, applyState, " +
            "COALESCE(bridgePayloadJson, eventJson) AS bridgePayloadJson, ncdrCategoryCode FROM events WHERE " +
            "(namespace NOT LIKE 'official.ncdr%' AND namespace NOT LIKE 'official.live.ncdr%') " +
            "OR ncdrCategoryCode IN (:visibleNcdrCategoryCodes) ORDER BY namespace, eventId",
    )
    fun observeAppEvents(visibleNcdrCategoryCodes: List<String>): Flow<List<EventBridgeRow>>

    @Query(
        "SELECT * FROM events WHERE " +
            "(namespace NOT LIKE 'official.ncdr%' AND namespace NOT LIKE 'official.live.ncdr%') " +
            "OR ncdrCategoryCode IN (:visibleNcdrCategoryCodes) ORDER BY namespace, eventId",
    )
    fun observeAppEventEntities(visibleNcdrCategoryCodes: List<String>): Flow<List<EventEntity>>

    @Query(
        "SELECT namespace, eventId, eventVersion, eventType, severity, expiresAt, applyState, " +
            "COALESCE(bridgePayloadJson, eventJson) AS bridgePayloadJson, ncdrCategoryCode FROM events WHERE " +
            "(namespace NOT LIKE 'official.ncdr%' AND namespace NOT LIKE 'official.live.ncdr%') " +
            "OR ncdrCategoryCode IN (:visibleNcdrCategoryCodes) ORDER BY namespace, eventId",
    )
    fun bridgeSnapshotSync(visibleNcdrCategoryCodes: List<String>): List<EventBridgeRow>
}

data class EventExpiryRow(
    val namespace: String,
    val eventId: String,
    val eventVersion: Int,
    val expiresAt: String,
)

/** Room projection intentionally omits the full signed JSON column. */
data class EventBridgeRow(
    override val namespace: String,
    val eventId: String,
    val eventVersion: Int,
    val eventType: String,
    val severity: String,
    override val expiresAt: String,
    val applyState: String,
    val bridgePayloadJson: String?,
    val ncdrCategoryCode: String?,
) : OfficialEventExpiryRecord
