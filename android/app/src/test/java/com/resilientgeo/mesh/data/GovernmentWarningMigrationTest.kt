package com.resilientgeo.mesh.data

import androidx.sqlite.db.SupportSQLiteDatabase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

class GovernmentWarningMigrationTest {
    @Test
    fun `v4 to v5 creates only the upload queue and index without dropping offline data`() {
        val statements = mutableListOf<String>()
        val database = Proxy.newProxyInstance(
            SupportSQLiteDatabase::class.java.classLoader,
            arrayOf(SupportSQLiteDatabase::class.java),
        ) { _, method, arguments ->
            if (method.name == "execSQL") statements += arguments?.get(0).toString()
            when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                java.lang.Integer.TYPE -> 0
                java.lang.Long.TYPE -> 0L
                else -> null
            }
        } as SupportSQLiteDatabase

        AppDatabase.MIGRATION_4_5.migrate(database)

        assertEquals(2, statements.size)
        assertTrue(statements[0].contains("CREATE TABLE IF NOT EXISTS `government_warning_uploads`"))
        assertTrue(statements[1].contains("CREATE INDEX IF NOT EXISTS `index_government_warning_uploads_uploadStatus_createdAtEpochMillis`"))
        assertFalse(statements.any { it.contains("DROP TABLE") || it.contains("DELETE FROM events") })
    }

    @Test
    fun `v5 to v6 creates durable device revocation cache without dropping offline data`() {
        val statements = mutableListOf<String>()
        val database = Proxy.newProxyInstance(
            SupportSQLiteDatabase::class.java.classLoader,
            arrayOf(SupportSQLiteDatabase::class.java),
        ) { _, method, arguments ->
            if (method.name == "execSQL") statements += arguments?.get(0).toString()
            when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                java.lang.Integer.TYPE -> 0
                java.lang.Long.TYPE -> 0L
                else -> null
            }
        } as SupportSQLiteDatabase

        AppDatabase.MIGRATION_5_6.migrate(database)

        assertEquals(1, statements.size)
        assertTrue(statements.single().contains("CREATE TABLE IF NOT EXISTS `government_device_revocations`"))
        assertTrue(statements.single().contains("PRIMARY KEY(`certificateId`)"))
        assertFalse(statements.any { it.contains("DROP TABLE") || it.contains("DELETE FROM events") })
    }
}
