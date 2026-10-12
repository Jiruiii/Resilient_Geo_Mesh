package com.resilientgeo.mesh.data

import androidx.room.Entity

/** Earliest centrally signed revocation timestamp observed for a device certificate. */
@Entity(tableName = "government_device_revocations", primaryKeys = ["certificateId"])
data class GovernmentDeviceRevocationEntity(
    val certificateId: String,
    val revokedAtEpochMillis: Long,
    val eventId: String,
    val eventVersion: Int,
)
