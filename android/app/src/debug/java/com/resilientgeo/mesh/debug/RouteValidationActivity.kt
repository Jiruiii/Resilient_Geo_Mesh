package com.resilientgeo.mesh.debug

import android.os.Bundle
import android.os.Build
import android.util.Log
import com.resilientgeo.mesh.bridge.MapBridgeProtocol
import com.resilientgeo.mesh.bridge.OfflineMapAssetBridge
import com.resilientgeo.mesh.routing.EvacuationRouteService
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.*
import org.json.JSONObject
import java.time.Instant

/** Debug-only end-to-end fixture host. Never reads or writes the user's Room DB. */
class RouteValidationActivity : FlutterFragmentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var eventSink: EventChannel.EventSink? = null
    private var event: Map<String, Any?>? = null
    private var version = 0
    private var supply: Map<String, Any?>? = supplyStation(version = 1, lon = 121.5880, lat = 25.0595)
    private var supplyVersion = 1
    private var calls = 0
    private var assetBridge: OfflineMapAssetBridge? = null
    private var routeService: EvacuationRouteService? = null
    private fun service(): EvacuationRouteService = routeService ?: run {
        EvacuationRouteService(EvacuationRouteService.assetGraphLoader(applicationContext), {
            // Copy on the main dispatcher: fixture updates and snapshots cannot race.
            withContext(Dispatchers.Main.immediate) { fixtureEvents().map { JSONObject(it).toString() } }
        }).also { routeService = it }
    }

    override fun getDartEntrypointFunctionName(): String = "routeValidationMain"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        assetBridge = OfflineMapAssetBridge(applicationContext, messenger)
        EventChannel(messenger, "com.resilientgeo.mesh/route-validation/events")
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                    publish()
                }
                override fun onCancel(arguments: Any?) { eventSink = null }
            })
        MethodChannel(messenger, "com.resilientgeo.mesh/route-validation/map")
            .setMethodCallHandler { call, result ->
                if (call.method != "calculateEvacuationRoute") {
                    result.notImplemented()
                } else {
                    scope.launch {
                        try {
                            val request = requireNotNull(MapBridgeProtocol.routeRequest(call.arguments))
                            calls++
                            val service = service()
                            val route = withContext(Dispatchers.Default) { service.calculate(request) }
                            Log.i("RouteValidation", "call=$calls destination=${request.destinationId} status=${route.status} distance=${route.distanceM}")
                            result.success(MapBridgeProtocol.routeResult(route))
                        } catch (error: Exception) {
                            result.error("route_engine_error", error.message, null)
                        }
                    }
                }
            }
        MethodChannel(messenger, "com.resilientgeo.mesh/route-validation")
            .setMethodCallHandler { call, result ->
                if (call.method != "phase") {
                    result.notImplemented()
                } else {
                    val phase = call.arguments as? String
                    if (phase in setOf("supply-reset", "supply-move", "supply-retract")) {
                        supplyVersion++
                        supply = when (phase) {
                            "supply-move" -> supplyStation(supplyVersion, lon = 121.5865, lat = 25.0620)
                            "supply-retract" -> supplyStation(supplyVersion, lon = 121.5880, lat = 25.0595, retracted = true)
                            else -> supplyStation(supplyVersion, lon = 121.5880, lat = 25.0595)
                        }
                        publish()
                        result.success(null)
                    } else if (phase !in setOf("full", "open", "expiry", "burst")) {
                        result.error("invalid_input", "Unknown fixture phase", null)
                    } else {
                        repeat(if (phase == "burst") 3 else 1) {
                            val now = Instant.now()
                            event = mapOf(
                                "namespace" to "official", "event_id" to "validation:shelter-status",
                                "event_version" to ++version, "event_type" to "SHELTER_STATUS",
                                "severity" to "HIGH", "source" to "device-validation",
                                "issued_at" to now.toString(),
                                "expires_at" to now.plusSeconds(if (phase == "expiry") 12 else 3600).toString(),
                                "apply_state" to "CURRENT",
                                "geometry" to mapOf("type" to "Point", "coordinates" to listOf(121.5920, 25.0600)),
                                "attributes" to mapOf("status" to "OPEN", "available" to if (phase == "open") 10 else 0),
                            )
                            publish()
                        }
                        result.success(null)
                    }
                }
            }
    }

    private fun fixtureEvents(): List<Map<String, Any?>> = listOfNotNull(event, supply)

    private fun publish() { eventSink?.success(fixtureEvents()) }

    /**
     * A supply station announcement shaped like the central publisher's. A
     * retraction is republished with an immediate expiry, as the publisher does.
     */
    private fun supplyStation(version: Int, lon: Double, lat: Double, retracted: Boolean = false): Map<String, Any?> {
        val now = Instant.now()
        return mapOf(
            "namespace" to "official.announcement", "event_id" to "validation:supply-station",
            "event_version" to version, "event_type" to "GOVERNMENT_ANNOUNCEMENT",
            "severity" to "LOW", "source" to "GOVERNMENT",
            "issued_at" to now.minusSeconds(60).toString(),
            "expires_at" to (if (retracted) now else now.plusSeconds(3600)).toString(),
            "apply_state" to if (retracted) "EXPIRED" else "CURRENT",
            "payload_hash" to "sha256:validation-supply-$version",
            "geometry" to mapOf("type" to "Point", "coordinates" to listOf(lon, lat)),
            "attributes" to buildMap<String, Any?> {
                put("category", "SUPPLY_STATION")
                put("has_map_location", true)
                put("title", "測試物資站")
                put("content", "路線實機測試用物資站公告")
                if (retracted) put("publication_retracted", true)
            },
        )
    }

    override fun onDestroy() {
        scope.cancel()
        // Clear the large graph even if Android still retains this Activity
        // briefly while destroying its Flutter engine and window.
        routeService = null
        eventSink = null
        assetBridge?.close()
        super.onDestroy()
    }
}
