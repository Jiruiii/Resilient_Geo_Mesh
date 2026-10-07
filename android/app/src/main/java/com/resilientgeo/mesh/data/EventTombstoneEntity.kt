package com.resilientgeo.mesh.data

import androidx.room.Entity

/** Minimal replay ledger retained after an expired alert's signed payload is purged. */
@Entity(tableName = "event_tombstones", primaryKeys = ["namespace", "eventId"])
data class EventTombstoneEntity(
    val namespace: String,
    val eventId: String,
    val eventVersion: Int,
    val expiredAtEpochMillis: Long,
)
