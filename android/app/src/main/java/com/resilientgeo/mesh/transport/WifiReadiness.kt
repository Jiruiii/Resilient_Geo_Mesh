package com.resilientgeo.mesh.transport

/** Turns the separate Wi-Fi Direct preconditions into one readable reason per failure. */
internal object WifiReadiness {
    private val permissionLabels = mapOf(
        "android.permission.NEARBY_WIFI_DEVICES" to "附近 Wi-Fi 裝置",
        "android.permission.ACCESS_LOCAL_NETWORK" to "區域網路（Android 17）",
        "android.permission.ACCESS_FINE_LOCATION" to "精確位置",
        "android.permission.ACCESS_COARSE_LOCATION" to "概略位置",
    )

    fun problems(available: Boolean, wifiOn: Boolean, locationOn: Boolean, missingPermissions: List<String>): List<String> =
        buildList {
            if (!available) add("此裝置不支援 Wi-Fi Direct")
            if (!wifiOn) add("Wi-Fi 未開啟")
            if (!locationOn) add("系統定位服務未開啟")
            if (missingPermissions.isNotEmpty())
                add("缺少權限：" + missingPermissions.joinToString("、") { permissionLabels[it] ?: it.substringAfterLast('.') })
        }

    fun message(problems: List<String>): String? =
        if (problems.isEmpty()) null else "無法開始：" + problems.joinToString("；")
}
