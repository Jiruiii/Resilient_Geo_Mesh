package com.resilientgeo.mesh.siren

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Starts and stops the real service. Whether sound is audible is a manual
 * check; this only proves the phases are reported truthfully and nothing is
 * left playing after stop. It never changes the device volume.
 */
@RunWith(AndroidJUnit4::class)
class LocatorSirenServiceInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun waitFor(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(50)
    }

    @Test
    fun startReportsPlayingOrARealFailureAndStopLeavesNothingPlaying() {
        ContextCompat.startForegroundService(context, LocatorSirenService.intent(context, LocatorSirenService.ACTION_START))
        waitFor(3_000) { SirenStatusHolder.status.value.phase in setOf(SirenPhase.PLAYING, SirenPhase.FAILED) }
        val started = SirenStatusHolder.status.value
        assertTrue("unexpected $started", started.phase == SirenPhase.PLAYING || started.reason != null)
        context.startService(LocatorSirenService.intent(context, LocatorSirenService.ACTION_STOP))
        waitFor(3_000) { SirenStatusHolder.status.value.phase !in setOf(SirenPhase.PLAYING, SirenPhase.STARTING) }
        assertEquals(if (started.phase == SirenPhase.PLAYING) SirenPhase.IDLE else SirenPhase.FAILED, SirenStatusHolder.status.value.phase)
    }
}
