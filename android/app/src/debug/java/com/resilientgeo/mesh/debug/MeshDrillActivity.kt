package com.resilientgeo.mesh.debug

import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.room.Room
import com.resilientgeo.mesh.bridge.MapBridgeProtocol
import com.resilientgeo.mesh.bridge.OfflineMapAssetBridge
import com.resilientgeo.mesh.data.*
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.emergency.SyncStatusStore
import com.resilientgeo.mesh.routing.EvacuationRouteService
import com.resilientgeo.mesh.transport.*
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Exercise-only Room, trust anchor, DNS service, and Flutter entrypoint.
 * Never writes the normal database or downloads any key for production use.
 */
class MeshDrillActivity : FlutterFragmentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var db: AppDatabase? = null
    private var repository: MeshRepository? = null
    private var keys: String? = null
    private var observer: Job? = null
    private var engine: AutoPeerSyncEngine? = null
    private var radio: WifiDirectTransport? = null
    private var sink: EventChannel.EventSink? = null
    private var assets: OfflineMapAssetBridge? = null
    private var route: EvacuationRouteService? = null
    private var startedAt = 0L
    private val nodeId = "exercise-${java.util.UUID.randomUUID()}"
    private val timeline = ArrayDeque<String>()
    private val cache by lazy { File(cacheDir, "mesh-drill-${SystemClock.elapsedRealtime()}") }
    override fun getDartEntrypointFunctionName() = "meshDrillMain"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    private fun record(message: String) {
        val line = "${if (startedAt == 0L) 0 else SystemClock.elapsedRealtime() - startedAt}ms $message"
        if (timeline.size >= 100) timeline.removeFirst()
        timeline.addLast(line)
        android.util.Log.i("MeshDrill", line)
    }
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        assets = OfflineMapAssetBridge(applicationContext, messenger)
        EventChannel(messenger, "com.resilientgeo.mesh/drill/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events; scope.launch { publish() } }
            override fun onCancel(arguments: Any?) { sink = null }
        })
        MethodChannel(messenger, "com.resilientgeo.mesh/drill").setMethodCallHandler { call, result ->
            scope.launch {
                try {
                    when (call.method) {
                        "prepare" -> {
                            check(engine == null) { "請先停止演練同步再載入" }
                            val role = (call.arguments as? Map<*, *>)?.get("role") as? String
                            require(role in setOf("sender", "receiver"))
                            val bundle = withContext(Dispatchers.IO) { loadBundle() }
                            check(bundle.optBoolean("exercise")) { "只接受演練資料" }
                            val incomingKeys = bundle.getJSONObject("trusted_keys")
                            check(incomingKeys.length() == 1 && incomingKeys.has("exercise-local-v1")) { "不是演練金鑰" }
                            check(keys == null || JSONObject(keys!!).getString("exercise-local-v1") == incomingKeys.getString("exercise-local-v1")) { "演練金鑰已更換，請先重設演練" }
                            if (repository == null) {
                                keys = incomingKeys.toString()
                                val database = Room.inMemoryDatabaseBuilder(applicationContext, AppDatabase::class.java).build()
                                db = database
                                repository = MeshRepository(applicationContext, database, cache, trustedKeysJson = keys)
                                observer = scope.launch { repository!!.observeEvents().collect { publish() } }
                            }
                            if (role == "sender") {
                                val chunks = bundle.getJSONArray("chunks")
                                for (i in 0 until chunks.length()) check(ingest(chunks.getJSONObject(i)) !is ChunkIngestResult.Rejected) { "演練資料驗證失敗" }
                            }
                            record(if (role == "sender") "載入發布端第 ${bundle.getInt("version")} 版" else "接收端已準備（只載入演練公鑰，沒有事件）")
                            publish(); result.success(status())
                        }
                        "start" -> {
                            check(repository != null) { "請先準備演練角色" }
                            check(SyncStatusStore(applicationContext).message()["service_running"] != true) { "請先關閉一般 App 的緊急模式" }
                            MeshTransportSettings(applicationContext).wifiNotReadyMessage()?.let { error("$it。請先在一般 App 授予權限並開啟 Wi-Fi 與定位服務") }
                            if (engine == null) {
                                val repo = repository!!
                                val transport = WifiDirectTransport(applicationContext, "resilientgeo-drill")
                                radio = transport
                                startedAt = SystemClock.elapsedRealtime()
                                engine = AutoPeerSyncEngine(transport, nodeId,
                                    { repo.allLocalPeerSummaries(nodeId) },
                                    { dataset, namespace, id -> repo.cachedChunkJson(dataset, namespace, id) },
                                    { ingest(it) }, scope, maxConcurrentSessions = 1, connectTimeoutMillis = 90000,
                                    failureCooldownMillis = 3000,
                                    onLog = { line -> scope.launch { record(line) } })
                                engine!!.start(); record("演練搜尋啟動")
                            }
                            result.success(status())
                        }
                        "stop" -> { stopRadio(); result.success(status()) }
                        "reset" -> {
                            stopRadio(); observer?.cancelAndJoin(); observer = null
                            route = null; repository = null; keys = null
                            withContext(Dispatchers.IO) { db?.close(); cache.deleteRecursively() }
                            db = null; timeline.clear(); publish(); result.success(status())
                        }
                        "status" -> result.success(status())
                        "getInitialState" -> result.success(MapBridgeProtocol.initialState(repository?.allEventsSnapshot() ?: emptyList(), false))
                        "calculateEvacuationRoute" -> {
                            val request = requireNotNull(MapBridgeProtocol.routeRequest(call.arguments))
                            val service = route ?: EvacuationRouteService(EvacuationRouteService.assetGraphLoader(applicationContext),
                                { repository?.allEventsSnapshot()?.map { it.eventJson } ?: emptyList() }).also { route = it }
                            val answer = withContext(Dispatchers.Default) { service.calculate(request) }
                            record("路線重算 ${request.destinationId}: ${answer.status}")
                            result.success(MapBridgeProtocol.routeResult(answer))
                        }
                        else -> result.notImplemented()
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    record("操作未完成：${error.message}")
                    result.error("drill_error", error.message, null)
                }
            }
        }
    }
    private suspend fun ingest(chunk: JSONObject): ChunkIngestResult {
        if (chunk.optString("namespace") != "drill.exercise" || chunk.optString("dataset_id") != "exercise-local")
            return ChunkIngestResult.Rejected("Not an exercise dataset")
        return repository!!.ingestChunk(chunk)
    }
    private fun loadBundle(): JSONObject {
        // Both devices use adb reverse while online. No arbitrary cleartext URL,
        // remote control, production publishing, or runtime production trust.
        val connection = URL("http://127.0.0.1:8788/api/bundle").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.instanceFollowRedirects = false
            check(connection.responseCode == 200) { "無法連接電腦的演練工作台" }
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (output.size() <= 1024 * 1024) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            check(bytes.size <= 1024 * 1024) { "演練資料過大" }
            return JSONObject(bytes.toString(Charsets.UTF_8))
        } finally { connection.disconnect() }
    }
    private suspend fun publish() { sink?.success(MapBridgeProtocol.eventSnapshot(repository?.allEventsSnapshot() ?: emptyList())) }
    private suspend fun status(): Map<String, Any?> = mapOf("running" to (engine != null),
        "events" to (repository?.allEventsSnapshot()?.size ?: 0), "timeline" to timeline.toList(),
        "received" to (engine?.stats()?.chunksApplied ?: 0), "prepared" to (repository != null))
    private fun stopRadio() { engine?.stop(); engine = null; radio?.teardown(); radio = null }
    override fun onDestroy() {
        stopRadio(); observer?.cancel(); scope.cancel(); assets?.close(); sink = null; route = null
        // Activity-local database and cache contain exercise data only.
        db?.close(); cache.deleteRecursively()
        super.onDestroy()
    }
}
