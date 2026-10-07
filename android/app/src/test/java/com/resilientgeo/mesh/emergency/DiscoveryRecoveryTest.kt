package com.resilientgeo.mesh.emergency

import com.resilientgeo.mesh.emergency.DiscoveryRecovery.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class DiscoveryRecoveryTest {
    @Test fun `enabling Bluetooth after the service starts begins discovery`() {
        val recovery = DiscoveryRecovery()
        assertEquals(Action.NONE, recovery.nextAction(0, ready = false, active = false, hasTransport = false))
        assertEquals(Action.RESTART, recovery.nextAction(5_000, ready = true, active = false, hasTransport = false))
        assertEquals(Action.NONE, recovery.nextAction(10_000, ready = true, active = true, hasTransport = true))
    }

    @Test fun `radio disable stops transport and reenable recovers without a mode toggle`() {
        val recovery = DiscoveryRecovery()
        assertEquals(Action.RESTART, recovery.nextAction(0, true, false, false))
        assertEquals(Action.STOP, recovery.nextAction(5_000, false, true, true))
        assertEquals(Action.NONE, recovery.nextAction(10_000, false, false, false))
        assertEquals(Action.RESTART, recovery.nextAction(15_000, true, false, false))
    }

    @Test fun `scan failures retry after cooldown but healthy scans keep running`() {
        val recovery = DiscoveryRecovery()
        assertEquals(Action.RESTART, recovery.nextAction(0, true, false, false))
        assertEquals(Action.NONE, recovery.nextAction(5_000, true, false, true))
        assertEquals(Action.RESTART, recovery.nextAction(30_000, true, false, true))
        assertEquals(Action.NONE, recovery.nextAction(60_000, true, true, true))
    }
}
