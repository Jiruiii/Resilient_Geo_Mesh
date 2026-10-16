package com.resilientgeo.mesh.transport

import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.os.Build
import android.os.Parcel
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WifiDirectConnectionConfigTest {
    @Test fun invitationKeepsIpv4ClientSettingsAcrossTheFrameworkParcel() {
        assumeTrue(Build.VERSION.SDK_INT >= 34)
        val config = WifiDirectTransport.connectionConfig("02:12:34:56:78:9a")
        val parcel = Parcel.obtain()
        try {
            config.writeToParcel(parcel, 0)
            parcel.setDataPosition(0)
            val received = WifiP2pConfig.CREATOR.createFromParcel(parcel)
            assertEquals("02:12:34:56:78:9a", received.deviceAddress)
            assertEquals(WpsInfo.PBC, received.wps.setup)
            assertEquals(0, received.groupOwnerIntent)
            assertEquals(WifiP2pConfig.GROUP_CLIENT_IP_PROVISIONING_MODE_IPV4_DHCP,
                received.groupClientIpProvisioningMode)
            assertEquals(-1, received.networkId)
        } finally { parcel.recycle() }
    }
}
