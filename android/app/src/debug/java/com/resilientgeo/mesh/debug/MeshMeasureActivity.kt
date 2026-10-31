package com.resilientgeo.mesh.debug

import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.room.Room
import com.resilientgeo.mesh.data.AppDatabase
import com.resilientgeo.mesh.data.ChunkIngestResult
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.emergency.SyncStatusStore
import com.resilientgeo.mesh.measure.MeasurementCsv
import com.resilientgeo.mesh.measure.MeasurementPayload
import com.resilientgeo.mesh.measure.MeasurementSigner
import com.resilientgeo.mesh.measure.MeasurementStats
import com.resilientgeo.mesh.measure.MeasurementTrial
import com.resilientgeo.mesh.transport.BleGattTransport
import com.resilientgeo.mesh.transport.MeshTransportSettings
import com.resilientgeo.mesh.transport.NearbyConnectionsTransport
import com.resilientgeo.mesh.transport.PeerTransport
import com.resilientgeo.mesh.transport.WifiDirectTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

/**
 * Field measurement harness for docs/finals-field-test-plan.md: one fixed
 * transport, a fixed payload tier and one CSV row per trial. Like the drill,
 * it uses its own database, cache, node id and trust store (the measurement
 * key only), so nothing here reaches the normal app data. Rows go to
 * `Android/data/<package>/files/measurements/` for `adb pull`.
 */
class MeshMeasureActivity : ComponentActivity() {
    private val signer = MeasurementSigner.shared()
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val settings by lazy { MeshTransportSettings(applicationContext) }
    private var workDir: File? = null
    private var db: AppDatabase? = null
    private var repository: MeshRepository? = null
    private var radio: PeerTransport? = null
    private var engine: AutoPeerSyncEngine? = null
    private var preparedTier: MeasurementPayload? = null
    private var preparedChunks = 0
    private var preparedBytes = 0L
    private var run: Job? = null
    private val results = mutableListOf<MeasurementTrial.Result>()
    private val lock = Any()
    private var trial: MeasurementTrial? = null
    private var senderStartedAt = 0L
    private var senderSessions = 0
    private var senderFailures = 0
    private var radioStartedAt = 0L
    @Volatile private var radioReadyAt: Long? = null

    private lateinit var transportPicker: Spinner
    private lateinit var rolePicker: Spinner
    private lateinit var payloadPicker: Spinner
    private lateinit var environmentPicker: Spinner
    private lateinit var testIdInput: EditText
    private lateinit var distanceInput: EditText
    private lateinit var notesInput: EditText
    private lateinit var timeoutInput: EditText
    private lateinit var repeatInput: EditText
    private lateinit var gapInput: EditText
    private lateinit var keepData: CheckBox
    private lateinit var statusText: TextView
    private lateinit var statsText: TextView
    private lateinit var logText: TextView
    private val actionButtons = mutableListOf<Button>()

    private val transports = listOf(MeshTransportSettings.BLE, MeshTransportSettings.NEARBY, MeshTransportSettings.WIFI_DIRECT)
    private val environments = listOf("室外空曠", "室內走廊", "隔一道牆", "跨一層樓", "口袋或背包", "擁擠環境", "其他")
    private val transport get() = transports[transportPicker.selectedItemPosition]
    private val sender get() = rolePicker.selectedItemPosition == 0
    private val csvFile get() = File(getExternalFilesDir("measurements"), "measure-${LocalDate.now()}-${Build.MODEL.replace(Regex("[^A-Za-z0-9_-]"), "_")}.csv")

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        log(if (granted.values.all { it }) "權限已允許，請再按一次" else "缺少權限：${granted.filterValues { !it }.keys}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        log("裝置 ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} · 紀錄檔 ${csvFile.absolutePath}")
        lifecycleScope.launch {
            while (true) {
                refresh()
                delay(500)
            }
        }
        handleCommand(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCommand(intent)
    }

    /**
     * Unattended runs over adb, through the same fields and actions as the buttons:
     * `am start -n <pkg>/.debug.MeshMeasureActivity --es cmd load|provide|trials|stop
     * [--es transport ble|nearby|wifi_direct] [--es role sender|receiver] [--es tier KB50]
     * [--es test_id x] [--es notes x] [--es distance 1] [--ei timeout 180] [--ei count 5] [--ei gap 10]`.
     * Progress is in logcat (tag MeshMeasure) and the CSV.
     */
    private fun handleCommand(intent: Intent?) {
        val command = intent?.getStringExtra("cmd") ?: return
        intent.getStringExtra("transport")?.let { transports.indexOf(it).takeIf { i -> i >= 0 }?.let(transportPicker::setSelection) }
        intent.getStringExtra("role")?.let { rolePicker.setSelection(if (it == "sender") 0 else 1) }
        intent.getStringExtra("tier")?.let { name ->
            MeasurementPayload.entries.indexOfFirst { it.name == name }.takeIf { it >= 0 }?.let(payloadPicker::setSelection)
        }
        intent.getStringExtra("test_id")?.let(testIdInput::setText)
        intent.getStringExtra("notes")?.let(notesInput::setText)
        intent.getStringExtra("distance")?.let(distanceInput::setText)
        if (intent.hasExtra("timeout")) timeoutInput.setText(intent.getIntExtra("timeout", 180).toString())
        if (intent.hasExtra("gap")) gapInput.setText(intent.getIntExtra("gap", 10).toString())
        log("adb 指令：$command")
        // Spinner changes apply on the next layout pass, so act after it.
        window.decorView.post {
            when (command) {
                "load" -> prepareSender()
                "provide" -> { if (engine != null) toggleSender(); toggleSender() }
                "trials" -> startTrials(intent.getIntExtra("count", 1))
                "stop" -> stopAll("adb")
                else -> log("未知的 adb 指令：$command")
            }
        }
    }

    private fun buildUi(): ScrollView {
        val pad = (12 * resources.displayMetrics.density).toInt()
        fun spinner(items: List<String>) = Spinner(this).apply {
            adapter = ArrayAdapter(this@MeshMeasureActivity, android.R.layout.simple_spinner_dropdown_item, items)
        }
        fun input(hint: String, value: String, number: Boolean) = EditText(this).apply {
            this.hint = hint
            setText(value)
            inputType = if (number) InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL else InputType.TYPE_CLASS_TEXT
        }
        fun label(text: String) = TextView(this).apply { this.text = text; setPadding(0, pad / 2, 0, 0) }
        fun button(text: String, action: () -> Unit) = Button(this).apply {
            this.text = text
            setOnClickListener { action() }
            actionButtons += this
        }
        transportPicker = spinner(listOf("藍牙 BLE", "Nearby", "Wi-Fi Direct")).apply {
            // Statistics only mean something for one transport at a time.
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    val cleared = synchronized(lock) { results.isNotEmpty().also { results.clear() } }
                    if (cleared) log("已換傳輸方式，本次統計已清除")
                }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
        rolePicker = spinner(listOf("發送端（持有資料）", "接收端（量測並寫紀錄）"))
        payloadPicker = spinner(MeasurementPayload.entries.map { it.label })
        environmentPicker = spinner(environments)
        testIdInput = input("測試代號，例如 distance-ble", "", false)
        distanceInput = input("距離（公尺）", "1", true)
        notesInput = input("備註（障礙物、手機擺放）", "", false)
        timeoutInput = input("每次逾時（秒）", "180", true)
        repeatInput = input("連續次數", "5", true)
        gapInput = input("每次間隔（秒）", "10", true)
        keepData = CheckBox(this).apply { text = "保留資料：不清空接收端（再次相遇、三台接力）" }
        statusText = TextView(this).apply { textSize = 16f }
        statsText = TextView(this)
        logText = TextView(this).apply { textSize = 12f; setTextIsSelectable(true) }
        return ScrollView(this).apply {
            // Android 15+ draws edge to edge: keep the header clear of the status bar
            // and the fields clear of the navigation bar and keyboard.
            clipToPadding = false
            ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
            addView(LinearLayout(this@MeshMeasureActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad, pad, pad)
                addView(TextView(this@MeshMeasureActivity).apply {
                    text = "傳輸量測 · 量測專用資料（非真實災情）\n兩台選同一種傳輸；離開本畫面即清除資料。"
                    setBackgroundColor(0xFFFFE3A3.toInt())
                    setTextColor(0xFF3D2E00.toInt())
                    setPadding(pad, pad, pad, pad)
                })
                addView(label("傳輸方式")); addView(transportPicker)
                addView(label("角色")); addView(rolePicker)
                addView(label("資料量（發送端）")); addView(payloadPicker)
                addView(button("發送端：載入資料") { prepareSender() })
                addView(button("發送端：開始提供／停止") { toggleSender() })
                // Prefilled fields hide their hint, so every field also gets a caption.
                addView(label("試驗條件（接收端）"))
                addView(label("測試代號")); addView(testIdInput)
                addView(label("距離（公尺）")); addView(distanceInput)
                addView(label("環境")); addView(environmentPicker)
                addView(label("備註")); addView(notesInput)
                addView(label("每次逾時（秒）")); addView(timeoutInput); addView(keepData)
                addView(button("接收端：開始一次試驗") { startTrials(1) })
                addView(LinearLayout(this@MeshMeasureActivity).apply {
                    addView(LinearLayout(this@MeshMeasureActivity).apply {
                        orientation = LinearLayout.VERTICAL
                        addView(label("連續次數")); addView(repeatInput)
                    }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                    addView(LinearLayout(this@MeshMeasureActivity).apply {
                        orientation = LinearLayout.VERTICAL
                        addView(label("每次間隔（秒）")); addView(gapInput)
                    }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                })
                addView(button("接收端：連續試驗") { startTrials(repeatInput.text.toString().toIntOrNull() ?: 5) })
                addView(button("停止") { stopAll("stopped") })
                addView(button("清除本次統計") { synchronized(lock) { results.clear() } })
                addView(statusText); addView(statsText); addView(logText)
            })
        }
    }

    // --- Setup shared by both roles ---

    private fun readyToRun(): Boolean {
        if (SyncStatusStore(applicationContext).message()["service_running"] == true) {
            log("請先關閉一般 App 的緊急模式，避免兩套同步互搶無線電")
            return false
        }
        val permissions = when (transport) {
            MeshTransportSettings.BLE -> settings.blePermissions()
            MeshTransportSettings.NEARBY -> settings.nearbyPermissions()
            else -> settings.wifiPermissions()
        }
        val missing = permissions.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(missing.toTypedArray())
            return false
        }
        if (!settings.ready(transport)) {
            log(if (transport == MeshTransportSettings.WIFI_DIRECT) settings.wifiNotReadyMessage() ?: "Wi-Fi Direct 尚未就緒"
                else "${transportPicker.selectedItem} 尚未就緒：請開啟藍牙、Wi-Fi 與定位")
            return false
        }
        return true
    }

    private suspend fun openRepository() = withContext(Dispatchers.IO) {
        closeRepository()
        val dir = File(cacheDir, "mesh-measure-${SystemClock.elapsedRealtime()}").apply { mkdirs() }
        // A file database keeps a 39 MB payload out of memory; the folder is deleted on reset.
        val database = Room.databaseBuilder(applicationContext, AppDatabase::class.java, File(dir, "measure.db").absolutePath).build()
        workDir = dir
        db = database
        repository = MeshRepository(applicationContext, database, File(dir, "chunks"), cacheCapBytes = Long.MAX_VALUE,
            trustedKeysJson = signer.trustedKeysJson)
    }

    private fun closeRepository() {
        db?.close()
        workDir?.deleteRecursively()
        db = null; workDir = null; repository = null
        preparedTier = null; preparedChunks = 0; preparedBytes = 0
    }

    private fun startRadio(onTrace: (AutoPeerSyncEngine.Trace) -> Unit) {
        stopRadio()
        val repo = checkNotNull(repository)
        val mode = transport
        val nodeId = "measure-${UUID.randomUUID()}"
        // Fresh radio identity per start, so the other phone treats each trial as a new encounter.
        radioStartedAt = SystemClock.elapsedRealtime()
        // Only Nearby reports when its startup finished; the others count as ready at once.
        radioReadyAt = if (mode == MeshTransportSettings.NEARBY) null else radioStartedAt
        val radio: PeerTransport = when (mode) {
            MeshTransportSettings.NEARBY -> {
                var created: NearbyConnectionsTransport? = null
                // A replaced transport finishing late must not mark the new one ready.
                NearbyConnectionsTransport(applicationContext) {
                    if (this.radio === created) radioReadyAt = SystemClock.elapsedRealtime()
                }.also { created = it }
            }
            MeshTransportSettings.WIFI_DIRECT -> WifiDirectTransport(applicationContext, "resilientgeo-measure")
            else -> BleGattTransport(applicationContext, getSystemService(BluetoothManager::class.java).adapter!!)
        }
        this.radio = radio
        // Same per-transport limits as EmergencyModeService.startLane, so results match the real app.
        engine = AutoPeerSyncEngine(radio, nodeId, { repo.allLocalPeerSummaries(nodeId) },
            { dataset, namespace, id -> repo.cachedChunkJson(dataset, namespace, id) },
            { chunk -> ingest(chunk) }, engineScope,
            maxConcurrentSessions = if (mode == MeshTransportSettings.BLE) 2 else 1,
            connectTimeoutMillis = if (mode == MeshTransportSettings.WIFI_DIRECT) 90_000 else 40_000,
            failureCooldownMillis = if (mode == MeshTransportSettings.BLE) 15_000 else 3_000,
            exchangeTimeoutCapMillis = maxOf(300_000L, timeoutMillis()),
            onLog = { android.util.Log.i(TAG, "[$mode] $it") },
            onTrace = onTrace).also { it.start() }
    }

    private fun stopRadio() {
        engine?.stop(); engine = null
        when (val current = radio) {
            is NearbyConnectionsTransport -> current.teardown()
            is WifiDirectTransport -> current.teardown()
            is BleGattTransport -> current.teardown()
        }
        radio = null
    }

    private suspend fun ingest(chunk: JSONObject): ChunkIngestResult =
        if (chunk.optString("dataset_id") != MeasurementSigner.DATASET_ID) ChunkIngestResult.Rejected("Not measurement data")
        else checkNotNull(repository).ingestChunk(chunk)

    // --- Sender ---

    private fun prepareSender() {
        if (run?.isActive == true || engine != null) return log("請先停止再載入")
        val tier = MeasurementPayload.entries[payloadPicker.selectedItemPosition]
        if (transport == MeshTransportSettings.BLE && !tier.bleAllowed) return log("藍牙約 4 KB/s，最多選到「約 1 MB」")
        run = lifecycleScope.launch {
            setBusy(true)
            try {
                openRepository()
                val ids = tier.chunkIds(JSONObject(asset("${MeasurementPayload.ASSET_DIR}/manifest.json")))
                val now = Instant.now()
                for ((index, id) in ids.withIndex()) {
                    statusText.text = "載入並簽章 ${index + 1}/${ids.size}"
                    val chunk = withContext(Dispatchers.Default) { signer.resign(JSONObject(asset(MeasurementPayload.assetPath(id))), now) }
                    val result = ingest(chunk)
                    check(result is ChunkIngestResult.Applied) { "量測資料驗證失敗：$result" }
                    preparedChunks++
                    // UTF-8 bytes, not characters: the Chinese text is about 3 bytes a character.
                    preparedBytes += chunk.toString().toByteArray(Charsets.UTF_8).size
                }
                preparedTier = tier
                log("發送端已載入 ${tier.label}：$preparedChunks 片、${preparedBytes} bytes")
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                closeRepository()
                log("載入失敗：${error.message}")
            } finally {
                setBusy(false)
            }
        }
    }

    private suspend fun asset(path: String) = withContext(Dispatchers.IO) { assets.open(path).bufferedReader().use { it.readText() } }

    private fun toggleSender() {
        if (engine != null) {
            stopRadio()
            log("發送端已停止：$senderSessions 次成功、$senderFailures 次失敗")
            return
        }
        if (preparedTier == null) return log("請先載入資料")
        if (transport == MeshTransportSettings.BLE && preparedTier?.bleAllowed == false) return log("已載入的資料量太大，藍牙請重新載入 1 MB 以下")
        if (!readyToRun()) return
        senderStartedAt = SystemClock.elapsedRealtime(); senderSessions = 0; senderFailures = 0
        // One row per served session, timed from that session's first step (not from
        // when the sender started); with wall clocks it lines up with the receivers' rows.
        val sessions = HashMap<String, Pair<MeasurementTrial, Instant>>()
        startRadio { trace ->
            val now = SystemClock.elapsedRealtime()
            // Traces arrive on engine threads, so the session map and trials stay under the lock.
            val (result, startedWall) = synchronized(lock) {
                // Discovery repeats in the background, so it does not open a session.
                if (trace is AutoPeerSyncEngine.Trace.PeerSeen && trace.peerId !in sessions) return@startRadio
                val (session, startedWall) = sessions.getOrPut(trace.peerId) { MeasurementTrial(now) to Instant.now() }
                session.on(trace, now)
                if (trace !is AutoPeerSyncEngine.Trace.SessionEnded) return@startRadio
                sessions.remove(trace.peerId)
                if (trace.succeeded) senderSessions++ else senderFailures++
                session.result(now) to startedWall
            }
            lifecycleScope.launch { writeRow(result, trialNumber = 0, startedWall = startedWall) }
        }
        log("發送端開始提供 ${preparedTier?.label}（${transportPicker.selectedItem}）")
    }

    // --- Receiver ---

    private fun startTrials(count: Int) {
        if (run?.isActive == true || (engine != null && preparedTier != null)) return log("請先停止目前的工作")
        if (!readyToRun()) return
        run = lifecycleScope.launch {
            setBusy(true)
            try {
                for (number in 1..count) {
                    if (number > 1) {
                        val gap = gapInput.text.toString().toLongOrNull() ?: 10
                        for (left in gap downTo 1) { statusText.text = "第 $number/$count 次將在 $left 秒後開始"; delay(1_000) }
                    }
                    runTrial(number, count)
                }
            } finally {
                setBusy(false)
            }
        }
    }

    private suspend fun runTrial(number: Int, count: Int) {
        if (!keepData.isChecked || repository == null) {
            stopRadio()
            openRepository()
        }
        val startedAt = SystemClock.elapsedRealtime()
        val startedWall = Instant.now()
        val current = MeasurementTrial(startedAt)
        synchronized(lock) { trial = current }
        val onTrace: (AutoPeerSyncEngine.Trace) -> Unit = { trace -> synchronized(lock) { current.on(trace, SystemClock.elapsedRealtime()) } }
        startRadio(onTrace)
        val timeout = timeoutMillis()
        var stopReason: String? = "timeout"
        var radioRestarts = 0
        try {
            while (SystemClock.elapsedRealtime() - startedAt < timeout) {
                val (done, chunks) = synchronized(lock) { current.done to current.chunksApplied }
                if (done) { stopReason = null; break }
                // Nearby can stall its startup for ~30 s while Play services finishes closing the
                // previous trial's link, and a stalled transport never retries. Restart it; the
                // lost time stays in this trial's timings.
                if (radioReadyAt == null && SystemClock.elapsedRealtime() - radioStartedAt > RADIO_START_GRACE_MILLIS) {
                    radioRestarts++
                    log("第 $number 次：${transportPicker.selectedItem} 啟動逾時，重新啟動（第 $radioRestarts 次）")
                    startRadio(onTrace)
                }
                statusText.text = "第 $number/$count 次 · ${(SystemClock.elapsedRealtime() - startedAt) / 1000} 秒 · 已收 $chunks 片"
                delay(200)
            }
        } catch (error: kotlinx.coroutines.CancellationException) {
            stopReason = "stopped"
            throw error
        } finally {
            val result = synchronized(lock) { trial = null; current.result(SystemClock.elapsedRealtime(), stopReason) }
            // With keep-data the radio stays up so this phone can relay what it received.
            if (!keepData.isChecked) stopRadio()
            synchronized(lock) { results += result }
            writeRow(result, number, startedWall, if (radioRestarts > 0) "[radio-restarts=$radioRestarts]" else "")
            log("第 $number 次：${if (result.succeeded) "成功" else "失敗 ${result.failureReason}"}，" +
                "${result.elapsedMillis} ms，${result.appliedChunks} 片／${result.receivedBytes} bytes")
        }
    }

    private fun stopAll(reason: String) {
        run?.cancel(); run = null
        stopRadio()
        log("已停止（$reason）")
    }

    // --- Output ---

    private fun timeoutMillis() = (timeoutInput.text.toString().toLongOrNull() ?: 180).coerceIn(10, 7_200) * 1000

    private fun writeRow(result: MeasurementTrial.Result, trialNumber: Int, startedWall: Instant, extraNote: String = "") {
        val battery = getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val notes = listOf(notesInput.text.toString(), extraNote).filter { it.isNotBlank() }.joinToString(" ")
        val values = listOf(
            startedWall, Instant.now(), testIdInput.text.toString(), trialNumber, if (sender) "sender" else "receiver",
            transport, "${Build.MANUFACTURER} ${Build.MODEL}", Build.VERSION.RELEASE, distanceInput.text.toString(),
            environments[environmentPicker.selectedItemPosition], notes,
            if (getSystemService(PowerManager::class.java).isInteractive) "on" else "off", keepData.isChecked,
            preparedTier?.name ?: "", result.succeeded, result.failureReason ?: "", result.attempts,
            result.discoverMillis, result.connectMillis, result.helloMillis, result.requestMillis,
            result.firstChunkMillis, result.lastChunkMillis, result.completeMillis, result.elapsedMillis,
            result.requestedChunks, result.requestedBytes, result.appliedChunks, result.receivedBytes,
            result.rejectedChunks, result.bytesPerSecond, result.rssiMin, result.rssiMedian, result.rssiMax, battery,
        )
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching { MeasurementCsv.append(csvFile, CSV_HEADER, values) }
                .onFailure { withContext(Dispatchers.Main) { log("寫入紀錄失敗：${it.message}") } }
        }
    }

    private fun refresh() {
        val (stats, live) = synchronized(lock) { MeasurementStats.of(results) to trial?.let { it.chunksApplied to it.bytesReceived } }
        statsText.text = buildString {
            if (engine != null && trial == null && preparedTier != null)
                append("發送端提供中 · 成功 $senderSessions 次 · 失敗 $senderFailures 次\n")
            live?.let { append("本次已收 ${it.first} 片／${it.second} bytes\n") }
            append("本次統計：${stats.successes}/${stats.trials} 成功")
            stats.completeP50Millis?.let { append(" · 完成 p50 ${it} ms · p95 ${stats.completeP95Millis} ms") }
            stats.medianBytesPerSecond?.let { append(" · 中位數 ${it / 1024} KB/s") }
        }
    }

    private fun setBusy(busy: Boolean) {
        actionButtons.forEach { it.isEnabled = !busy || it.text == "停止" }
        if (!busy) statusText.text = if (engine != null) "無線電運作中" else "待命"
    }

    private fun log(message: String) {
        android.util.Log.i(TAG, message)
        logText.text = "${java.time.LocalTime.now().withNano(0)} $message\n${logText.text}".take(8_000)
    }

    override fun onDestroy() {
        run?.cancel()
        stopRadio()
        engineScope.cancel()
        closeRepository()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "MeshMeasure"
        /** Nearby's own startup gives up at 15 s; past this the trial restarts the radio. */
        const val RADIO_START_GRACE_MILLIS = 20_000L
        val CSV_HEADER = listOf(
            "wall_clock_start", "wall_clock_end", "test_id", "trial", "role", "transport", "device", "android",
            "distance_m", "environment", "notes", "screen", "keep_data", "payload_tier", "success", "failure_reason",
            "attempts", "t_discover_ms", "t_connect_ms", "t_hello_ms", "t_request_ms", "t_first_chunk_ms",
            "t_last_chunk_ms", "t_complete_ms", "elapsed_ms", "requested_chunks", "requested_bytes", "chunks_applied",
            "received_bytes", "rejected_chunks", "bytes_per_second", "rssi_min", "rssi_median", "rssi_max", "battery_pct",
        )
    }
}
