package com.resilientgeo.mesh.data

import androidx.room.Entity
import androidx.room.Index

/** Durable handoff from locally signed mesh warning to the authenticated cloud API. */
@Entity(
    tableName = "government_warning_uploads",
    primaryKeys = ["eventId"],
    indices = [Index(value = ["uploadStatus", "createdAtEpochMillis"])],
)
data class GovernmentWarningUploadEntity(
    val eventId: String,
    val payloadHash: String,
    val eventJson: String,
    val createdAtEpochMillis: Long,
    val uploadStatus: String,
    val uploadedAtEpochMillis: Long?,
)
