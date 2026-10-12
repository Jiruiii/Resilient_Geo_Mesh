package com.resilientgeo.mesh.data

import androidx.room.Dao
import androidx.room.Query

@Dao
interface GovernmentDeviceRevocationDao {
    @Query("INSERT INTO government_device_revocations(certificateId, revokedAtEpochMillis, eventId, eventVersion) " +
        "VALUES(:certificateId, :revokedAtEpochMillis, :eventId, :eventVersion) " +
        "ON CONFLICT(certificateId) DO UPDATE SET " +
        "revokedAtEpochMillis = MIN(government_device_revocations.revokedAtEpochMillis, excluded.revokedAtEpochMillis), " +
        "eventVersion = MAX(government_device_revocations.eventVersion, excluded.eventVersion)")
    fun upsertSync(certificateId: String, revokedAtEpochMillis: Long, eventId: String, eventVersion: Int)

    @Query("SELECT * FROM government_device_revocations ORDER BY certificateId")
    fun allSync(): List<GovernmentDeviceRevocationEntity>
}
