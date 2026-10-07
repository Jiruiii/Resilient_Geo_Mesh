package com.resilientgeo.mesh.bridge

import android.content.Context
import com.resilientgeo.mesh.data.OfflineAddressPackStore
import com.resilientgeo.mesh.online.GovernmentSyncManager
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.net.URL
import java.util.concurrent.Executors

/** Installs bundled OSM PMTiles and manages signed offline address packs. */
class OfflineMapAssetBridge(
    context: Context,
    messenger: BinaryMessenger,
) : MethodChannel.MethodCallHandler {

    private val applicationContext = context.applicationContext
    private val channel = MethodChannel(messenger, CHANNEL_NAME)
    private val executor = Executors.newSingleThreadExecutor()
    private val addressPackStore by lazy {
        OfflineAddressPackStore(applicationContext, ::serviceBaseUrl)
    }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            METHOD_COPY_PMTILES -> copyPmtiles(call, result)
            METHOD_ADDRESS_CATALOG -> executor.execute {
                try {
                    val catalog = addressPackStore.catalogJson()
                    runOnMain { result.success(catalog) }
                } catch (error: Throwable) {
                    runOnMain { result.error(ADDRESS_PACK_ERROR, error.message, null) }
                }
            }
            METHOD_INSTALLED_ADDRESS_PACKS -> executor.execute {
                try {
                    val packs = addressPackStore.installedPacksJson()
                    runOnMain { result.success(packs) }
                } catch (error: Throwable) {
                    runOnMain { result.error(ADDRESS_PACK_ERROR, error.message, null) }
                }
            }
            METHOD_SEARCH_ADDRESS_PACKS -> executor.execute {
                try {
                    val query = call.argument<String>("query").orEmpty()
                    val matches = addressPackStore.searchPacksJson(query)
                    runOnMain { result.success(matches) }
                } catch (error: Throwable) {
                    runOnMain { result.error(ADDRESS_PACK_ERROR, error.message, null) }
                }
            }
            METHOD_DOWNLOAD_ADDRESS_PACK -> downloadAddressPack(call, result)
            METHOD_ADDRESS_PROGRESS -> result.success(addressPackStore.progressState())
            else -> result.notImplemented()
        }
    }

    private fun copyPmtiles(call: MethodCall, result: MethodChannel.Result) {
        val assets = call.argument<List<String>>(ARG_ASSETS)
        val versions = call.argument<Map<String, String>>("versions").orEmpty()
        if (assets.isNullOrEmpty()) {
            result.error(INVALID_ARGUMENTS, "copyPmtiles requires assets", null)
            return
        }

        executor.execute {
            try {
                val mapDirectory = File(applicationContext.filesDir, "maps")
                    .apply { mkdirs() }
                val paths = linkedMapOf<String, String>()
                for (asset in assets) {
                    val fileName = asset.substringAfterLast('/')
                    require(fileName.isNotEmpty() && fileName.endsWith(".pmtiles")) {
                        "Unsupported map asset: $asset"
                    }
                    val destination = File(mapDirectory, fileName)
                    val version = versions[asset]
                    val stamp = File(mapDirectory, "$fileName.version")
                    val cached = version != null && destination.isFile && destination.length() > 0 &&
                        stamp.isFile && stamp.readText() == "$version:${destination.length()}"
                    if (!cached) {
                        // Publish only a complete file. An interrupted install
                        // leaves the prior map available and no valid stamp.
                        val pending = File(mapDirectory, "$fileName.pending")
                        applicationContext.assets.open("flutter_assets/$asset").use { input ->
                            pending.outputStream().buffered(128 * 1024).use { output ->
                                input.copyTo(output, 128 * 1024)
                            }
                        }
                        java.nio.file.Files.move(
                            pending.toPath(),
                            destination.toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                        )
                        if (version != null) stamp.writeText("$version:${destination.length()}")
                    }
                    paths[asset] = destination.absolutePath
                }
                runOnMain { result.success(paths) }
            } catch (error: Throwable) {
                runOnMain { result.error(MAP_ASSET_ERROR, error.message, null) }
            }
        }
    }

    private fun downloadAddressPack(call: MethodCall, result: MethodChannel.Result) {
        val arguments = call.arguments as? Map<*, *>
        val countyCode = arguments?.get("countyCode") as? String
        val allowMobileData = arguments?.get("allowMobileData") as? Boolean ?: false
        if (countyCode.isNullOrBlank()) {
            result.error(ADDRESS_PACK_ERROR, "需要縣市代碼", null)
        } else executor.execute {
            try {
                val response = addressPackStore.downloadCounty(countyCode, allowMobileData)
                runOnMain { result.success(response) }
            } catch (error: Throwable) {
                runOnMain { result.error(ADDRESS_PACK_ERROR, error.message, null) }
            }
        }
    }

    private fun serviceBaseUrl(): URL {
        val configured = (GovernmentSyncManager.get(applicationContext).message()["url"] as? String).orEmpty()
        require(configured.isNotBlank()) { "缺少政府資料服務網址設定" }
        return URL(configured.trimEnd('/') + "/")
    }

    fun close() {
        channel.setMethodCallHandler(null)
        executor.shutdownNow()
    }

    private fun runOnMain(block: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(block)
    }

    private companion object {
        const val CHANNEL_NAME = "com.resilientgeo.mesh/offline_map_assets"
        const val METHOD_COPY_PMTILES = "copyPmtiles"
        const val METHOD_ADDRESS_CATALOG = "getAddressPackCatalog"
        const val METHOD_INSTALLED_ADDRESS_PACKS = "getInstalledAddressPacks"
        const val METHOD_SEARCH_ADDRESS_PACKS = "searchAddressPacks"
        const val METHOD_DOWNLOAD_ADDRESS_PACK = "downloadAddressPack"
        const val METHOD_ADDRESS_PROGRESS = "getAddressPackProgress"
        const val ARG_ASSETS = "assets"
        const val INVALID_ARGUMENTS = "invalid_arguments"
        const val MAP_ASSET_ERROR = "map_asset_error"
        const val ADDRESS_PACK_ERROR = "address_pack_error"
    }
}
