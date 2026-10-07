package com.resilientgeo.mesh.bridge

import android.content.Context
import com.resilientgeo.mesh.data.CrowdReportResult
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.online.GovernmentSyncManager
import com.resilientgeo.mesh.routing.EvacuationRouteService
import com.resilientgeo.mesh.routing.RouteResult
import com.resilientgeo.mesh.routing.RouteStatus
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Android-owned bridge for the Flutter map. It reads verified events from the
 * repository and never gives Flutter a Room write path.
 *
 * `submitCrowdReport` is a write *request*, not a write path: Flutter supplies
 * only form fields. Assembling the event, signing it with the device key,
 * verifying it and storing it all happen in [MeshRepository.createCrowdReport]
 * through the same EventIngestor a report from a peer goes through, so Flutter
 * can neither choose a namespace, a key, an apply state nor skip verification.
 *
 * `calculateEvacuationRoute` is read-only and fully offline: the bundled walk
 * graph plus verified Room events ([EvacuationRouteService]).
 */
class FlutterMapBridge(
    context: Context,
    messenger: BinaryMessenger,
    private val repository: MeshRepository = MeshRepository(context),
    private val emergencyMode: EmergencyModeController = EmergencyModeController(
        AndroidEmergencyModeServiceCommand(context),
        SharedPreferencesEmergencyModeState(context),
    ),
    private val onEmergencyModeChanged: (Boolean) -> Unit = {},
    private val governmentSync: GovernmentSyncManager = GovernmentSyncManager.get(context),
    private val routeService: EvacuationRouteService = EvacuationRouteService(
        graphLoader = EvacuationRouteService.assetGraphLoader(context),
        eventJsonProvider = { repository.allEventsSnapshot().map { it.eventJson } },
        shelterCatalogProvider = {
            repository.verifiedShelterDisasterCatalog(governmentSync.message()["url"] as? String)
        },
    ),
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val methodChannel = MethodChannel(messenger, METHOD_CHANNEL_NAME)
    private val eventChannel = EventChannel(messenger, EVENT_CHANNEL_NAME)
    private var eventObservation: Job? = null
    private val syncStatus = com.resilientgeo.mesh.emergency.SyncStatusStore(context)

    /**
     * Verified static layers, started as soon as the bridge exists. First
     * verification of the nationwide shelter layer took 13-28 s on the test
     * phones, so it runs in the background instead of inside getInitialState
     * (which Flutter waits on behind the splash screen); later launches hit
     * VerifiedLayerCache. A failed verification stays failed: nothing
     * unverified is ever returned.
     */
    private val staticFeatures: Deferred<List<Map<String, Any?>>> =
        scope.async(Dispatchers.Default, start = CoroutineStart.LAZY) {
            repository.verifiedStaticFeatures(governmentSync.message()["url"] as? String)
        }

    init {
        methodChannel.setMethodCallHandler(this)
        eventChannel.setStreamHandler(this)
        staticFeatures.start()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            METHOD_GET_INITIAL_STATE -> getInitialState(result)
            "getSyncStatus" -> result.success(syncStatus.message())
            "getGovernmentSyncStatus" -> result.success(governmentSync.message())
            "configureGovernmentSync" -> {
                val args = call.arguments as? Map<*, *>
                val url = args?.get("url") as? String
                val enabled = args?.get("enabled") as? Boolean
                if (url == null || enabled == null) result.error(INVALID_ARGUMENTS, "Requires url and enabled", null)
                else try {
                    governmentSync.configure(url, enabled, args?.get("area") as? String ?: "all")
                    result.success(governmentSync.message())
                } catch (error: Exception) { result.error(INVALID_ARGUMENTS, "請輸入有效的 HTTPS 更新網址", null) }
            }
            "syncGovernmentNow" -> scope.launch { result.success(governmentSync.sync()) }
            METHOD_GET_STATIC_FEATURES -> getStaticFeatures(result)
            METHOD_LOAD_BUNDLED_FIXTURE -> loadBundledFixture(result)
            METHOD_SET_EMERGENCY_MODE -> setEmergencyMode(call, result)
            METHOD_SUBMIT_CROWD_REPORT -> submitCrowdReport(call, result)
            METHOD_CALCULATE_EVACUATION_ROUTE -> calculateEvacuationRoute(call, result)
            else -> result.notImplemented()
        }
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventObservation?.cancel()
        if (events == null) return

        eventObservation = scope.launch {
            rowsWithOfficialExpiryPurge(
                source = repository.observeEvents(),
                purgeExpired = { now ->
                    withContext(Dispatchers.IO) { repository.purgeExpiredOfficialEvents(now) }
                },
            )
                .map { rows ->
                    val now = Instant.now()
                    rows.map { EventPayloadMapper.toMessage(it, now) }
                }
                .distinctUntilChanged()
                .catch { error ->
                    events.error(EVENT_OBSERVATION_ERROR, error.message, null)
                }
                .collect { eventMessages ->
                    events.success(eventMessages)
                }
        }
    }

    override fun onCancel(arguments: Any?) {
        eventObservation?.cancel()
        eventObservation = null
    }

    /** Called by the host activity so neither channel retains a dead Activity/engine. */
    fun close() {
        eventObservation?.cancel()
        eventObservation = null
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        scope.cancel()
    }

    private fun getInitialState(result: MethodChannel.Result) {
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    repository.purgeUnsupportedOfficialEventData()
                    repository.purgeExpiredOfficialEvents(Instant.now())
                }
                result.success(
                    MapBridgeProtocol.initialState(
                        events = repository.observeEvents().first(),
                        emergencyModeEnabled = emergencyMode.isEnabled,
                    ),
                )
            } catch (error: Throwable) {
                result.error(METHOD_ERROR, error.message, null)
            }
        }
    }

    private fun getStaticFeatures(result: MethodChannel.Result) {
        scope.launch {
            try {
                result.success(MapBridgeProtocol.staticFeaturesResult(staticFeatures.await()))
            } catch (error: Throwable) {
                result.error(STATIC_LAYER_INVALID, error.message, null)
            }
        }
    }

    private fun loadBundledFixture(result: MethodChannel.Result) {
        scope.launch {
            try {
                val results = repository.ingestBundledFixture()
                result.success(MapBridgeProtocol.fixtureLoadSummary(results))
            } catch (error: Throwable) {
                result.error(METHOD_ERROR, error.message, null)
            }
        }
    }

    private fun setEmergencyMode(call: MethodCall, result: MethodChannel.Result) {
        val arguments = call.arguments as? Map<*, *>
        val enabled = arguments?.get("enabled") as? Boolean
        if (enabled == null) {
            result.error(INVALID_ARGUMENTS, "setEmergencyMode requires boolean enabled", null)
            return
        }

        try {
            val applied = emergencyMode.setEnabled(enabled)
            onEmergencyModeChanged(applied)
            result.success(MapBridgeProtocol.emergencyModeResult(applied))
        } catch (error: Throwable) {
            result.error(METHOD_ERROR, error.message, null)
        }
    }

    private fun submitCrowdReport(call: MethodCall, result: MethodChannel.Result) {
        val input = MapBridgeProtocol.crowdReportInput(call.arguments)
        if (input == null) {
            result.error(INVALID_INPUT, "submitCrowdReport arguments do not match the contract", null)
            return
        }
        scope.launch {
            when (val created = repository.createCrowdReport(input)) {
                is CrowdReportResult.Created ->
                    result.success(MapBridgeProtocol.crowdReportCreated(created.eventId, created.applyState.name))
                is CrowdReportResult.Invalid ->
                    result.error(INVALID_INPUT, created.errors.joinToString("; "), null)
                is CrowdReportResult.SigningUnavailable ->
                    result.error(SIGNING_UNAVAILABLE, created.message, null)
                is CrowdReportResult.StorageUnavailable ->
                    result.error(STORAGE_UNAVAILABLE, created.message, null)
            }
        }
    }

    private fun calculateEvacuationRoute(call: MethodCall, result: MethodChannel.Result) {
        scope.launch {
            try {
                val request = MapBridgeProtocol.routeRequest(call.arguments)
                val route = if (request == null) {
                    RouteResult.failure(RouteStatus.INVALID_INPUT, Instant.now().toString())
                } else {
                    withContext(Dispatchers.Default) { routeService.calculate(request) }
                }
                result.success(MapBridgeProtocol.routeResult(route))
            } catch (error: Throwable) {
                result.error(ROUTE_ENGINE_ERROR, error.message, null)
            }
        }
    }

    private companion object {
        const val METHOD_CHANNEL_NAME = "com.resilientgeo.mesh/map"
        const val EVENT_CHANNEL_NAME = "com.resilientgeo.mesh/events"
        const val METHOD_GET_INITIAL_STATE = "getInitialState"
        const val METHOD_GET_STATIC_FEATURES = "getStaticFeatures"
        const val STATIC_LAYER_INVALID = "static_layer_invalid"
        const val METHOD_LOAD_BUNDLED_FIXTURE = "loadBundledFixture"
        const val METHOD_SET_EMERGENCY_MODE = "setEmergencyMode"
        const val METHOD_SUBMIT_CROWD_REPORT = "submitCrowdReport"
        const val METHOD_CALCULATE_EVACUATION_ROUTE = "calculateEvacuationRoute"
        const val INVALID_INPUT = "invalid_input"
        const val SIGNING_UNAVAILABLE = "signing_unavailable"
        const val STORAGE_UNAVAILABLE = "storage_unavailable"
        const val ROUTE_ENGINE_ERROR = "route_engine_error"
        const val INVALID_ARGUMENTS = "invalid_arguments"
        const val METHOD_ERROR = "map_bridge_error"
        const val EVENT_OBSERVATION_ERROR = "event_observation_error"
    }
}
