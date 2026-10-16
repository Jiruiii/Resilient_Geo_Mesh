package com.resilientgeo.mesh.transport

import org.junit.Assert.*
import org.junit.Test

class WifiReadinessTest {
    @Test fun readyDeviceHasNoProblemAndNoMessage() {
        val problems = WifiReadiness.problems(true, true, true, emptyList())
        assertTrue(problems.isEmpty())
        assertNull(WifiReadiness.message(problems))
    }

    @Test fun missingLocalNetworkPermissionIsNamedInsteadOfAGenericWifiError() {
        val message = WifiReadiness.message(
            WifiReadiness.problems(true, true, true, listOf("android.permission.ACCESS_LOCAL_NETWORK")),
        )
        assertEquals("無法開始：缺少權限：區域網路（Android 17）", message)
    }

    @Test fun everyIndependentProblemIsReportedTogether() {
        val message = WifiReadiness.message(
            WifiReadiness.problems(
                false, false, false,
                listOf("android.permission.NEARBY_WIFI_DEVICES", "android.permission.ACCESS_LOCAL_NETWORK"),
            ),
        )!!
        assertTrue(message.contains("此裝置不支援 Wi-Fi Direct"))
        assertTrue(message.contains("Wi-Fi 未開啟"))
        assertTrue(message.contains("系統定位服務未開啟"))
        assertTrue(message.contains("附近 Wi-Fi 裝置、區域網路（Android 17）"))
    }

    @Test fun unknownPermissionFallsBackToItsShortName() {
        val problems = WifiReadiness.problems(true, true, true, listOf("com.example.permission.SOMETHING"))
        assertEquals(listOf("缺少權限：SOMETHING"), problems)
    }
}
