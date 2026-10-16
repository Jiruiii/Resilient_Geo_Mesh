package com.resilientgeo.mesh.siren

import org.junit.Assert.assertEquals
import org.junit.Test

class SirenStatusTest {
    @Test
    fun `volume zero is a real failure, do not disturb is a warning`() {
        assertEquals("volume_zero", SirenPreflight.failure(alarmVolume = 0))
        assertEquals(null, SirenPreflight.failure(alarmVolume = 3))
        assertEquals(listOf("dnd_may_block"), SirenPreflight.warnings(SirenPreflight.INTERRUPTION_FILTER_NONE, notificationsAllowed = true))
        assertEquals(listOf("dnd_may_block"), SirenPreflight.warnings(SirenPreflight.INTERRUPTION_FILTER_ALARMS, notificationsAllowed = true))
        assertEquals(emptyList<String>(), SirenPreflight.warnings(1, notificationsAllowed = true))
        assertEquals(listOf("notifications_denied"), SirenPreflight.warnings(1, notificationsAllowed = false))
    }

    @Test
    fun `status messages use the shared wire values`() {
        assertEquals(
            mapOf("phase" to "AUTO_STOPPED", "reason" to null, "ends_at_epoch_ms" to null, "warnings" to emptyList<String>()),
            SirenStatus(SirenPhase.AUTO_STOPPED).toMessage(),
        )
        assertEquals("FAILED", SirenStatus(SirenPhase.FAILED, reason = "focus_denied").toMessage()["phase"])
    }
}
