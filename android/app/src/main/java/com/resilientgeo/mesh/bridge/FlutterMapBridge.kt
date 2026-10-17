package com.resilientgeo.mesh.bridge

import android.content.Context
import com.resilientgeo.mesh.data.ChunkIngestResult
import com.resilientgeo.mesh.data.CrowdReportResult
import com.resilientgeo.mesh.data.GovernmentWarningResult
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.data.RescueResult
import com.resilientgeo.mesh.online.GovernmentSyncJob
import com.resilientgeo.mesh.online.GovernmentSyncManager
import com.resilientgeo.mesh.online.RescueServerSync
import com.resilientgeo.mesh.online.RescueUploadStates
import com.resilientgeo.mesh.online.SharedPreferencesRescueUploadStates
import com.resilientgeo.mesh.online.UrlConnectionRescueHttp
import com.resilientgeo.mesh.report.GovernmentWarningInput
import com.resilientgeo.mesh.routing.EvacuationRouteService
import com.resilientgeo.mesh.routing.RouteResult
import com.resilientgeo.mesh.routing.RouteStatus
import com.resilientgeo.mesh.transport.MeshTransportSettings
import com.resilientgeo.mesh.trust.GovernmentDeviceKeyStore
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
 * `submitRescueRequest`／`reviseRescueRequest` 同樣只是寫入請求，簽章與儲存在
 * [MeshRepository] 內。
 *
 * `calculateEvacuationRoute` is read-only and fully offline: the bundled walk
 * graph plus verified Room events ([EvacuationRouteService]).
 */
class FlutterMapBridge(
    context: Context,
    messenger: BinaryMessenger,
    private val governmentDeviceKeyStore: GovernmentDeviceKeyStore = GovernmentDeviceKeyStore(context),
    private val repository: MeshRepository = MeshRepository(context, governmentDeviceKeyStore = governmentDeviceKeyStore),
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
    private val rescueUploadStates: RescueUploadStates = SharedPreferencesRescueUploadStates(context),
    private val rescueSync: RescueServerSync = RescueServerSync(UrlConnectionRescueHttp, rescueUploadStates),
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val methodChannel = MethodChannel(messenger, METHOD_CHANNEL_NAME)
    private val eventChannel = EventChannel(messenger, EVENT_CHANNEL_NAME)
    private var eventObservation: Job? = null
    private val syncStatus = com.resilientgeo.mesh.emergency.SyncStatusStore(context)
    private val transportSettings = MeshTransportSettings(context.applicationContext)

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
            "setDiscoveryMode" -> {
                val mode = (call.arguments as? Map<*, *>)?.get("mode") as? String
                if (mode !in listOf("balanced", "adaptive")) result.error(INVALID_ARGUMENTS, "Unknown discovery mode", null)
                else if (emergencyMode.isEnabled) result.error(METHOD_ERROR, "請先關閉緊急模式再切換搜尋模式", null)
                else { transportSettings.discoveryMode = mode!!; result.success(syncStatus.message()) }
            }
            "searchPeersNow" -> {
                if (!emergencyMode.isEnabled || transportSettings.mode != "wifi_direct" || syncStatus.message()["service_running"] != true)
                    result.error(METHOD_ERROR, "請先開啟 Wi-Fi Direct 緊急模式", null)
                else {
                    com.resilientgeo.mesh.transport.WifiDiscoveryControl.requests.incrementAndGet()
                    result.success(syncStatus.message())
                }
            }
            "setSyncTransport" -> {
                val mode = (call.arguments as? Map<*, *>)?.get("transport") as? String
                if (mode !in MeshTransportSettings.MODES) {
                    result.error(INVALID_ARGUMENTS, "Unknown sync transport", null)
                } else if (emergencyMode.isEnabled) {
                    result.error(METHOD_ERROR, "請先關閉緊急模式再切換傳輸方式", null)
                } else {
                    transportSettings.mode = mode!!
                    result.success(syncStatus.message())
                }
            }
            "getGovernmentSyncStatus" -> result.success(governmentSync.message())
            "configureGovernmentSync" -> {
                val args = call.arguments as? Map<*, *>
                val url = args?.get("url") as? String
                val enabled = args?.get("enabled") as? Boolean
                if (url == null || enabled == null) result.error(INVALID_ARGUMENTS, "Requires url and enabled", null)
                else try {
                    governmentSync.configure(url, enabled, args?.get("area") as? String ?: "all")
                    result.success(governmentSync.message())
                } catch (error: Exception) { result.error(INVALID_ARGUMENTS, "請輸入有效的更新網址；模擬器 debug 版可用 http://10.0.2.2:8787/", null) }
            }
            "syncGovernmentNow" -> scope.launch { result.success(governmentSync.sync()) }
            METHOD_GET_STATIC_FEATURES -> getStaticFeatures(result)
            METHOD_LOAD_BUNDLED_FIXTURE -> loadBundledFixture(result)
            METHOD_SET_EMERGENCY_MODE -> setEmergencyMode(call, result)
            METHOD_SUBMIT_CROWD_REPORT -> submitCrowdReport(call, result)
            METHOD_SUBMIT_RESCUE_REQUEST -> submitRescueRequest(call, result)
            METHOD_REVISE_RESCUE_REQUEST -> reviseRescueRequest(call, result)
            METHOD_GET_OWN_RESCUE_REQUESTS -> getOwnRescueRequests(result)
            "syncRescueNearby" -> syncRescueNearby(call, result)
            "getGovernmentDevicePublicKey" -> getGovernmentDevicePublicKey(result)
            "storeGovernmentDeviceCertificate" -> storeGovernmentDeviceCertificate(call, result)
            "getGovernmentDeviceAuthorization" -> getGovernmentDeviceAuthorization(result)
            "configureGovernmentWarningUpload" -> configureGovernmentWarningUpload(call, result)
            "createGovernmentWarning" -> createGovernmentWarning(call, result)
            "listPendingGovernmentWarningUploads" -> listPendingGovernmentWarningUploads(result)
            "listGovernmentWarningStatuses" -> listGovernmentWarningStatuses(result)
            "markGovernmentWarningUploaded" -> markGovernmentWarningUploaded(call, result)
            "markGovernmentWarningExpired" -> markGovernmentWarningExpired(call, result)
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
                android.util.Log.e("FlutterMapBridge", "Verified static layers unavailable", error)
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
                    result.success(MapBridgeProtocol.crowdReportCreated(created.eventId, created.applyState.name, created.eventJson))
                is CrowdReportResult.Invalid ->
                    result.error(INVALID_INPUT, created.errors.joinToString("; "), null)
                is CrowdReportResult.SigningUnavailable ->
                    result.error(SIGNING_UNAVAILABLE, created.message, null)
                is CrowdReportResult.StorageUnavailable ->
                    result.error(STORAGE_UNAVAILABLE, created.message, null)
            }
        }
    }

    private fun submitRescueRequest(call: MethodCall, result: MethodChannel.Result) {
        val input = MapBridgeProtocol.rescueRequestInput(call.arguments)
        if (input == null) {
            result.error(INVALID_INPUT, "submitRescueRequest arguments do not match the contract", null)
            return
        }
        scope.launch { replyRescue(repository.createRescueRequest(input), result) }
    }

    private fun reviseRescueRequest(call: MethodCall, result: MethodChannel.Result) {
        val arguments = call.arguments as? Map<*, *>
        val eventId = arguments?.get("event_id") as? String
        val action = MapBridgeProtocol.rescueAction(arguments?.get("action"))
        val requestArguments = arguments?.get("request")
        val input = requestArguments?.let { MapBridgeProtocol.rescueRequestInput(it) }
        if (eventId == null || action == null || (requestArguments != null && input == null) ||
            (action == com.resilientgeo.mesh.report.RescueAction.UPDATE && input == null)
        ) {
            result.error(INVALID_INPUT, "reviseRescueRequest arguments do not match the contract", null)
            return
        }
        scope.launch { replyRescue(repository.reviseRescueRequest(eventId, action, input), result) }
    }

    private fun getOwnRescueRequests(result: MethodChannel.Result) {
        scope.launch {
            try {
                val rows = repository.ownRescueRequests()
                result.success(mapOf("requests" to rows.map { row ->
                    val state = rescueUploadStates.get(row.eventId)?.takeIf { it.version == row.eventVersion }
                    MapBridgeProtocol.rescueSaved(row, state?.state ?: "NOT_UPLOADED", state?.reason)
                }))
            } catch (error: Throwable) {
                result.error(METHOD_ERROR, error.message, null)
            }
        }
    }

    private fun replyRescue(outcome: RescueResult, result: MethodChannel.Result) {
        when (outcome) {
            is RescueResult.Saved -> {
                result.success(MapBridgeProtocol.rescueSaved(outcome.event))
                scope.launch { uploadOwnRescue() }
            }
            is RescueResult.Invalid -> result.error(INVALID_INPUT, outcome.errors.joinToString("; "), null)
            is RescueResult.Conflict -> result.error(CONFLICT, outcome.reason, null)
            is RescueResult.RateLimited ->
                result.error(RATE_LIMITED, "rescue revision cooldown", mapOf("retry_after_seconds" to outcome.retryAfterSeconds))
            is RescueResult.SigningUnavailable -> result.error(SIGNING_UNAVAILABLE, outcome.message, null)
            is RescueResult.StorageUnavailable -> result.error(STORAGE_UNAVAILABLE, outcome.message, null)
        }
    }

    private suspend fun uploadOwnRescue() {
        val base = governmentSync.message()["url"] as? String
        if (base.isNullOrBlank()) return
        runCatching { rescueSync.upload(base, repository.ownRescueChunks()) }
    }

    private fun syncRescueNearby(call: MethodCall, result: MethodChannel.Result) {
        val bbox = ((call.arguments as? Map<*, *>)?.get("bbox") as? List<*>)?.mapNotNull { (it as? Number)?.toDouble() }
        if (bbox == null || bbox.size != 4) {
            result.error(INVALID_INPUT, "syncRescueNearby requires bbox", null)
            return
        }
        val base = governmentSync.message()["url"] as? String
        if (base.isNullOrBlank()) {
            result.error("server_unavailable", "rescue server is not configured", null)
            return
        }
        scope.launch {
            try {
                uploadOwnRescue()
                val downloaded = withContext(Dispatchers.IO) {
                    rescueSync.download(base, bbox) { chunk -> repository.ingestChunk(chunk) is ChunkIngestResult.Applied }
                }
                result.success(mapOf("downloaded" to downloaded))
            } catch (error: Exception) {
                // Offline is normal; never forward raw server bodies or URLs.
                result.error("server_unavailable", "rescue sync unavailable", null)
            }
        }
    }

    private fun getGovernmentDevicePublicKey(result: MethodChannel.Result) {
        scope.launch {
            try { result.success(MapBridgeProtocol.governmentDeviceKeyReply(repository.governmentDevicePublicKey())) }
            catch (error: Throwable) { result.error(SIGNING_UNAVAILABLE, error.message, null) }
        }
    }

    private fun storeGovernmentDeviceCertificate(call: MethodCall, result: MethodChannel.Result) {
        val certificateJson = (call.arguments as? Map<*, *>)?.get("certificate_json") as? String
        if (certificateJson == null) {
            result.error(INVALID_ARGUMENTS, "certificate_json is required", null)
            return
        }
        scope.launch {
            try {
                result.success(MapBridgeProtocol.governmentDeviceAuthorizationReply(
                    repository.storeGovernmentDeviceCertificate(org.json.JSONObject(certificateJson)),
                ))
            } catch (error: Throwable) {
                result.error(INVALID_INPUT, error.message, null)
            }
        }
    }

    private fun getGovernmentDeviceAuthorization(result: MethodChannel.Result) {
        scope.launch {
            try { result.success(MapBridgeProtocol.governmentDeviceAuthorizationReply(repository.governmentDeviceAuthorization())) }
            catch (error: Throwable) { result.error(SIGNING_UNAVAILABLE, error.message, null) }
        }
    }

    private fun createGovernmentWarning(call: MethodCall, result: MethodChannel.Result) {
        val request = MapBridgeProtocol.governmentWarningRequest(call.arguments)
        if (request == null) {
            result.error(INVALID_INPUT, "createGovernmentWarning arguments do not match the contract", null)
            return
        }
        scope.launch {
            when (val created = repository.createGovernmentWarning(request.input, request.eventId)) {
                is GovernmentWarningResult.Created -> {
                    runCatching { GovernmentSyncJob.schedulePendingUpload(appContext) }
                    result.success(MapBridgeProtocol.governmentWarningCreated(
                        created.eventId, created.payloadHash, created.eventJson, created.duplicate,
                    ))
                }
                is GovernmentWarningResult.Invalid -> result.error(INVALID_INPUT, created.errors.joinToString("; "), null)
                is GovernmentWarningResult.Unauthorized -> result.error(DEVICE_NOT_AUTHORIZED, created.message, null)
                is GovernmentWarningResult.SigningUnavailable -> result.error(SIGNING_UNAVAILABLE, created.message, null)
                is GovernmentWarningResult.StorageUnavailable -> result.error(STORAGE_UNAVAILABLE, created.message, null)
            }
        }
    }

    private fun configureGovernmentWarningUpload(call: MethodCall, result: MethodChannel.Result) {
        val baseUrl = (call.arguments as? Map<*, *>)?.get("base_url") as? String
        if (baseUrl.isNullOrBlank()) {
            result.error(INVALID_ARGUMENTS, "configureGovernmentWarningUpload requires base_url", null)
            return
        }
        try {
            governmentSync.configureWarningUploadBaseUrl(baseUrl)
            result.success(mapOf("configured" to true))
        } catch (error: Exception) {
            result.error(INVALID_ARGUMENTS, error.message, null)
        }
    }

    private fun listPendingGovernmentWarningUploads(result: MethodChannel.Result) {
        scope.launch {
            try {
                result.success(repository.pendingGovernmentWarningUploads().map { upload ->
                    mapOf("event_id" to upload.eventId, "payload_hash" to upload.payloadHash,
                        "event_json" to upload.eventJson, "created_at_epoch_millis" to upload.createdAtEpochMillis)
                })
            } catch (error: Throwable) { result.error(STORAGE_UNAVAILABLE, error.message, null) }
        }
    }

    private fun listGovernmentWarningStatuses(result: MethodChannel.Result) {
        scope.launch {
            try {
                result.success(repository.governmentWarningUploadStatuses().map { upload ->
                    mapOf(
                        "event_id" to upload.eventId,
                        "payload_hash" to upload.payloadHash,
                        "event_json" to upload.eventJson,
                        "created_at_epoch_millis" to upload.createdAtEpochMillis,
                        "upload_status" to upload.uploadStatus,
                    )
                })
            } catch (error: Throwable) { result.error(STORAGE_UNAVAILABLE, error.message, null) }
        }
    }

    private fun markGovernmentWarningUploaded(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *>
        val eventId = args?.get("event_id") as? String
        val payloadHash = args?.get("payload_hash") as? String
        if (eventId.isNullOrBlank() || payloadHash.isNullOrBlank()) {
            result.error(INVALID_ARGUMENTS, "event_id and payload_hash are required", null)
            return
        }
        scope.launch {
            try {
                result.success(mapOf("uploaded" to repository.markGovernmentWarningUploaded(eventId, payloadHash)))
            } catch (error: Throwable) { result.error(STORAGE_UNAVAILABLE, error.message, null) }
        }
    }

    private fun markGovernmentWarningExpired(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *>
        val eventId = args?.get("event_id") as? String
        val payloadHash = args?.get("payload_hash") as? String
        if (eventId.isNullOrBlank() || payloadHash.isNullOrBlank()) {
            result.error(INVALID_ARGUMENTS, "event_id and payload_hash are required", null)
            return
        }
        scope.launch {
            try {
                result.success(mapOf("expired" to repository.markGovernmentWarningExpired(eventId, payloadHash)))
            } catch (error: Throwable) { result.error(STORAGE_UNAVAILABLE, error.message, null) }
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
        const val METHOD_SUBMIT_RESCUE_REQUEST = "submitRescueRequest"
        const val METHOD_REVISE_RESCUE_REQUEST = "reviseRescueRequest"
        const val METHOD_GET_OWN_RESCUE_REQUESTS = "getOwnRescueRequests"
        const val CONFLICT = "conflict"
        const val RATE_LIMITED = "rate_limited"
        const val METHOD_CALCULATE_EVACUATION_ROUTE = "calculateEvacuationRoute"
        const val INVALID_INPUT = "invalid_input"
        const val SIGNING_UNAVAILABLE = "signing_unavailable"
        const val DEVICE_NOT_AUTHORIZED = "government_device_not_authorized"
        const val STORAGE_UNAVAILABLE = "storage_unavailable"
        const val ROUTE_ENGINE_ERROR = "route_engine_error"
        const val INVALID_ARGUMENTS = "invalid_arguments"
        const val METHOD_ERROR = "map_bridge_error"
        const val EVENT_OBSERVATION_ERROR = "event_observation_error"
    }
}
