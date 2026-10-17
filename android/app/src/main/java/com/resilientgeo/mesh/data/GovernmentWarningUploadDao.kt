package com.resilientgeo.mesh.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface GovernmentWarningUploadDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertIgnoreSync(entity: GovernmentWarningUploadEntity): Long

    @Query("SELECT * FROM government_warning_uploads WHERE eventId = :eventId LIMIT 1")
    fun findSync(eventId: String): GovernmentWarningUploadEntity?

    @Query("SELECT * FROM government_warning_uploads WHERE uploadStatus = 'PENDING' ORDER BY createdAtEpochMillis,eventId LIMIT :limit")
    fun pendingSync(limit: Int): List<GovernmentWarningUploadEntity>

    @Query("SELECT * FROM government_warning_uploads ORDER BY createdAtEpochMillis DESC,eventId LIMIT :limit")
    fun statusesSync(limit: Int): List<GovernmentWarningUploadEntity>

    @Query("UPDATE government_warning_uploads SET uploadStatus = 'UPLOADED', uploadedAtEpochMillis = :uploadedAtEpochMillis " +
        "WHERE eventId = :eventId AND payloadHash = :payloadHash AND uploadStatus = 'PENDING'")
    fun markUploadedSync(eventId: String, payloadHash: String, uploadedAtEpochMillis: Long): Int

    @Query("UPDATE government_warning_uploads SET uploadStatus = 'PUBLISHED', uploadedAtEpochMillis = COALESCE(uploadedAtEpochMillis, :publishedAtEpochMillis) " +
        "WHERE eventId = :eventId AND payloadHash = :payloadHash AND uploadStatus IN ('PENDING','UPLOADED','PUBLISHED')")
    fun markPublishedSync(eventId: String, payloadHash: String, publishedAtEpochMillis: Long): Int

    @Query("UPDATE government_warning_uploads SET uploadStatus = 'EXPIRED' " +
        "WHERE eventId = :eventId AND payloadHash = :payloadHash AND uploadStatus = 'PENDING'")
    fun markExpiredSync(eventId: String, payloadHash: String): Int
}
