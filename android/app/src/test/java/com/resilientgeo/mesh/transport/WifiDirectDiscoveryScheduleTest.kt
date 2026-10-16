package com.resilientgeo.mesh.transport

import com.resilientgeo.mesh.transport.WifiDirectDiscoverySchedule.Action
import org.junit.Assert.*
import org.junit.Test

class WifiDirectDiscoveryScheduleTest {
    @Test fun adaptiveRestSurvivesNativeStopAndManualSearchResumesWhenSafe() {
        val schedule = WifiDirectDiscoverySchedule(0, adaptive = true) { min, _ -> min }
        assertEquals(Action.SEARCH, schedule.next(100, false))
        assertEquals(Action.REST, schedule.next(60000, false))
        schedule.searchStopped(60001)
        schedule.searchStarted()
        assertNull(schedule.next(89999, false))
        schedule.searchNow(70000)
        assertNull(schedule.next(70000, true))
        assertEquals(Action.SEARCH, schedule.next(71000, false))
    }

    @Test fun adaptiveKeepsSearchingForRecentPeerAndUsesBoundedIdleWindows() {
        val schedule = WifiDirectDiscoverySchedule(0, adaptive = true) { min, _ -> min }
        schedule.next(100, false)
        schedule.peerSeen(59000)
        assertEquals(Action.SEARCH, schedule.next(60000, false))
        assertEquals(Action.REST, schedule.next(120000, false))
        assertEquals(Action.SEARCH, schedule.next(150000, false))
        assertNull(schedule.next(161999, false))
        assertEquals(Action.REST, schedule.next(162000, false))
        assertEquals(Action.SEARCH, schedule.next(240000, false))
        assertEquals(Action.REST, schedule.next(252000, false))
        assertNull(schedule.next(311999, false))
        assertEquals(Action.SEARCH, schedule.next(312000, false))
    }
    private fun schedule() = WifiDirectDiscoverySchedule(0) { min, _ -> min }

    @Test fun startupAndRetriesAreBoundedWithoutAStopListenPhase() {
        val schedule = schedule()
        assertNull(schedule.next(0, false))
        assertEquals(Action.SEARCH, schedule.next(100, false))
        assertNull(schedule.next(6099, false))
        assertEquals(Action.SEARCH, schedule.next(6100, false))
        assertNull(schedule.next(13099, false))
        assertEquals(Action.SEARCH, schedule.next(13100, false))
    }

    @Test fun negotiationPausesRetriesAndResumesAfterNegotiationEnds() {
        val schedule = schedule()
        schedule.next(100, false)
        assertNull(schedule.next(50000, true))
        assertNull(schedule.next(100000, true))
        assertEquals(Action.SEARCH, schedule.next(100001, false))
        assertNull(schedule.next(100002, false))
    }

    @Test fun stoppedDiscoveryRecoversSoonWithoutBusyLooping() {
        val schedule = schedule()
        schedule.next(100, false)
        schedule.searchStopped(1000)
        schedule.searchStopped(1200)
        assertNull(schedule.next(1699, false))
        assertEquals(Action.SEARCH, schedule.next(1700, false))
        assertNull(schedule.next(1701, false))
    }

    @Test fun failedActionBacksOffAndIgnoresLateStartedBroadcast() {
        val schedule = schedule()
        schedule.next(100, false)
        schedule.failed(200)
        schedule.searchStarted()
        assertNull(schedule.next(2199, false))
        assertEquals(Action.SEARCH, schedule.next(2200, false))
    }

    @Test fun differentJitterSequencesDoNotKeepBothPeersInLockstep() {
        val early = schedule()
        val late = WifiDirectDiscoverySchedule(0) { _, max -> max - 1 }
        assertEquals(Action.SEARCH, early.next(100, false))
        assertNull(late.next(100, false))
        assertEquals(Action.SEARCH, late.next(2499, false))
        assertEquals(Action.SEARCH, early.next(6100, false))
        assertEquals(Action.SEARCH, late.next(8499, false))
        assertEquals(Action.SEARCH, early.next(13100, false))
        assertNull(late.next(13100, false))
        assertEquals(Action.SEARCH, late.next(21498, false))
    }

    @Test fun nativeStopStartAndDuplicateStartedDoNotMoveRetryDeadline() {
        val schedule = schedule()
        schedule.next(100, false)
        schedule.searchStopped(200)
        schedule.searchStarted()
        assertNull(schedule.next(900, false))
        schedule.searchStarted()
        assertNull(schedule.next(6099, false))
        assertEquals(Action.SEARCH, schedule.next(6100, false))
    }
}
