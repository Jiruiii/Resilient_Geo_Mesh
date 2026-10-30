package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [EventEntity::class, ChunkEntity::class, EventTombstoneEntity::class, GovernmentWarningUploadEntity::class, GovernmentDeviceRevocationEntity::class], version = 8, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun eventDao(): EventDao
    abstract fun chunkDao(): ChunkDao
    abstract fun governmentWarningUploadDao(): GovernmentWarningUploadDao
    abstract fun governmentDeviceRevocationDao(): GovernmentDeviceRevocationDao

    companion object {

        /**
         * v1 -> v2 adds the local chunk inventory ([ChunkEntity]).
         *
         * A real migration rather than `fallbackToDestructiveMigration()`:
         * dropping the database on upgrade would wipe the events a phone is
         * carrying, and "the data survives with no network" is this
         * project's phase-1 acceptance criterion. An upgrading device
         * simply starts with an empty inventory and repopulates it as
         * chunks arrive.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `chunks` (
                        `datasetId` TEXT NOT NULL,
                        `namespace` TEXT NOT NULL,
                        `chunkId` TEXT NOT NULL,
                        `manifestId` TEXT NOT NULL,
                        `datasetVersion` INTEGER NOT NULL,
                        `chunkHash` TEXT NOT NULL,
                        `sizeBytes` INTEGER NOT NULL,
                        `priority` TEXT NOT NULL,
                        `receivedAtEpochMillis` INTEGER NOT NULL,
                        PRIMARY KEY(`datasetId`, `namespace`, `chunkId`)
                    )
                    """.trimIndent(),
                )
            }
        }

        /** v2 -> v3 keeps only event identity/version after alert payload expiry. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `event_tombstones` (
                        `namespace` TEXT NOT NULL,
                        `eventId` TEXT NOT NULL,
                        `eventVersion` INTEGER NOT NULL,
                        `expiredAtEpochMillis` INTEGER NOT NULL,
                        PRIMARY KEY(`namespace`, `eventId`)
                    )
                    """.trimIndent(),
                )
            }
        }

        /** v3 -> v4 removes retired FIRE_AGENCY shelter-status events. */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "DELETE FROM events WHERE eventType = 'SHELTER_STATUS' AND eventJson LIKE '%FIRE_AGENCY%'",
                )
            }
        }

        /** v4 -> v5 adds a durable, retryable cloud-upload queue for device-signed warnings. */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `government_warning_uploads` (
                        `eventId` TEXT NOT NULL,
                        `payloadHash` TEXT NOT NULL,
                        `eventJson` TEXT NOT NULL,
                        `createdAtEpochMillis` INTEGER NOT NULL,
                        `uploadStatus` TEXT NOT NULL,
                        `uploadedAtEpochMillis` INTEGER,
                        PRIMARY KEY(`eventId`)
                    )
                    """.trimIndent(),
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_government_warning_uploads_uploadStatus_createdAtEpochMillis` " +
                    "ON `government_warning_uploads` (`uploadStatus`, `createdAtEpochMillis`)")
            }
        }

        /** v5 -> v6 stores signed device certificate revocations for offline event verification. */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `government_device_revocations` (
                        `certificateId` TEXT NOT NULL,
                        `revokedAtEpochMillis` INTEGER NOT NULL,
                        `eventId` TEXT NOT NULL,
                        `eventVersion` INTEGER NOT NULL,
                        PRIMARY KEY(`certificateId`)
                    )
                    """.trimIndent(),
                )
            }
        }

        /** v6 -> v7 indexes normalized NCDR category codes for selective local reads. */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `events` ADD COLUMN `ncdrCategoryCode` TEXT")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_events_ncdrCategoryCode` ON `events` (`ncdrCategoryCode`)")
            }
        }

        /** v7 -> v8 stores a compact UI payload separately from the signed relay payload. */
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `events` ADD COLUMN `bridgePayloadJson` TEXT")
            }
        }

        /** Every registered upgrade, shared by the app and the migration tests. */
        val ALL_MIGRATIONS: Array<Migration> = arrayOf(
            MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8,
        )

        @Volatile
        private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "resilientgeo-mesh.db",
            ).addMigrations(*ALL_MIGRATIONS).build().also { instance = it }
        }
    }
}
