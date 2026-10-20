package com.resilientgeo.mesh.data

import androidx.room.Entity
import androidx.room.Index

interface OfficialEventExpiryRecord {
    val namespace: String
    val expiresAt: String
}

/**
 * The local database row for one (namespace, event_id). Persisted with
 * Room/SQLite, so it survives an app restart with no network at all —
 * this is what the phase 1 acceptance check ("turn off network, restart
 * the app, map and last data are still readable") relies on.
 */
@Entity(
    tableName = "events",
    primaryKeys = ["namespace", "eventId"],
    indices = [Index(value = ["ncdrCategoryCode"])],
)
data class EventEntity(
    override val namespace: String,
    val eventId: String,
    val eventVersion: Int,
    val eventType: String,
    val severity: String,
    override val expiresAt: String,
    /** Name of an [com.resilientgeo.mesh.ingest.ApplyState] value. */
    val applyState: String,
    /** The full signed Event v0 document, verbatim, so the map layer can read geometry/attributes. */
    val eventJson: String,
    /** Compact UI projection; excludes duplicated NCDR source_record payloads. */
    val bridgePayloadJson: String? = null,
    val storedAtEpochMillis: Long,
    /** Indexed outside eventJson so UI queries can skip unselected NCDR records without parsing the full database. */
    val ncdrCategoryCode: String? = null,
) : OfficialEventExpiryRecord
