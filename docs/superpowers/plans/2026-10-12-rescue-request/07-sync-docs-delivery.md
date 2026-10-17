# 07 Android 線上同步、文件與交付

> 總覽與 Global Constraints：[README.md](README.md)。Android 有網路時，把自己的 crowd-rescue chunk 上傳到 03 的 API，並下載地圖附近的求救 chunk，經既有 `ingestChunk` 驗證後寫入 Room、再由 mesh 轉傳。這樣 Web 發出的求救能進入 mesh，Android 的求救也能讓 Web 使用者看見。

---

### Task 27: Android 線上同步

**Files:**
- Create: `android/app/src/main/java/com/resilientgeo/mesh/online/RescueServerSync.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt`（`ownRescueChunks()`）
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/bridge/FlutterMapBridge.kt`、`MapBridgeProtocol.kt`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/online/GovernmentSyncManager.kt`
- Test: `android/app/src/test/java/com/resilientgeo/mesh/online/RescueServerSyncTest.kt`

**Interfaces:**
- Consumes: 02 Task 7、Task 8；03 Task 12 的 API；`GovernmentFeedSync.validateBase(url, allowLocal)`
- Produces:
  - `data class RescueHttpResponse(val status: Int, val body: String)`
  - `interface RescueHttp { suspend fun post(url: String, json: String): RescueHttpResponse; suspend fun get(url: String): RescueHttpResponse }`；`object UrlConnectionRescueHttp : RescueHttp`（`HttpURLConnection`，15/20 秒逾時、不跟隨 redirect、回應上限 1 MB；`IOException` 往外丟）
  - `data class RescueUploadState(val version: Int, val state: String, val reason: String?)`；state 為 `WAITING_UPLOAD`、`ACCEPTED`、`REJECTED`
  - `interface RescueUploadStates { fun get(eventId: String): RescueUploadState?; fun put(eventId: String, state: RescueUploadState) }`；`class SharedPreferencesRescueUploadStates(context) : RescueUploadStates`（檔名 `rescue-upload`，值為 JSON）
  - `class RescueServerSync(http: RescueHttp, states: RescueUploadStates) { suspend fun upload(baseUrl: String, chunks: List<JSONObject>); suspend fun download(baseUrl: String, bbox: List<Double>, ingest: suspend (JSONObject) -> Boolean): Int }`
  - `suspend fun MeshRepository.ownRescueChunks(): List<JSONObject>`（自己每個 event_id 最新版本的已快取 chunk）
  - bridge：`getOwnRescueRequests` 的 `server_state` 讀 `RescueUploadStates`（版本相同才採用，否則 `NOT_UPLOADED`），並附 `server_reason`；新增 `syncRescueNearby({ bbox })` → `{ downloaded: Int }`，伺服器網址未設定時錯誤碼 `server_unavailable`；`submitRescueRequest`／`reviseRescueRequest` 成功後在背景觸發一次上傳
  - `GovernmentSyncManager.sync()` 結束前另外嘗試上傳一次（失敗不影響 feed 的錯誤訊息）

上傳狀態對應（與 Web 相同）：

| HTTP | 狀態 |
|---|---|
| 200、201 | `ACCEPTED` |
| 400、409、413 | `REJECTED`，reason 取回應 `reason` 或 `error` |
| 404 | `WAITING_UPLOAD`，`server_unavailable` |
| 429 | `WAITING_UPLOAD`，`rate_limited` |
| 其他或 `IOException` | `WAITING_UPLOAD`，`network_unavailable` |

已是 `ACCEPTED` 或 `REJECTED` 且版本相同的 chunk 不再上傳。下載只接受 `dataset_id == crowd-rescue` 的 chunk，交給 `ingest`（`repository.ingestChunk(chunk) is ChunkIngestResult.Applied`），回傳成功寫入的數量；驗章失敗的 chunk 不會進 Room。

- [ ] **Step 1: 寫失敗的測試**

```kotlin
package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.RescueFixtures
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class RescueServerSyncTest {
    private class MemoryStates : RescueUploadStates {
        val map = mutableMapOf<String, RescueUploadState>()
        override fun get(eventId: String) = map[eventId]
        override fun put(eventId: String, state: RescueUploadState) { map[eventId] = state }
    }

    private class FakeHttp(private val respond: (String) -> RescueHttpResponse) : RescueHttp {
        val posts = mutableListOf<Pair<String, String>>()
        val gets = mutableListOf<String>()
        override suspend fun post(url: String, json: String): RescueHttpResponse { posts += url to json; return respond(url) }
        override suspend fun get(url: String): RescueHttpResponse { gets += url; return respond(url) }
    }

    private val chunk = RescueFixtures.cases("chunk_cases").first().getJSONObject("chunk")
    private val eventId = chunk.getJSONArray("events").getJSONObject(0).getString("event_id")

    @Test
    fun `accepted uploads are remembered per version and not repeated`() = runBlocking {
        val states = MemoryStates()
        val http = FakeHttp { RescueHttpResponse(201, """{"result":"accepted"}""") }
        val sync = RescueServerSync(http, states)
        sync.upload("https://map.example.test/", listOf(chunk))
        sync.upload("https://map.example.test/", listOf(chunk))
        assertEquals(1, http.posts.size)
        assertEquals("https://map.example.test/v1/crowd/rescue-events", http.posts.single().first)
        assertEquals(chunk.getString("chunk_id"), JSONObject(http.posts.single().second).getString("chunk_id"))
        assertEquals(RescueUploadState(1, "ACCEPTED", null), states.get(eventId))
    }

    @Test
    fun `rejections keep the reason and transient failures stay waiting`() = runBlocking {
        val rejected = MemoryStates()
        RescueServerSync(FakeHttp { RescueHttpResponse(409, """{"error":"rejected","reason":"rescue_active_exists"}""") }, rejected)
            .upload("https://map.example.test/", listOf(chunk))
        assertEquals(RescueUploadState(1, "REJECTED", "rescue_active_exists"), rejected.get(eventId))

        val limited = MemoryStates()
        RescueServerSync(FakeHttp { RescueHttpResponse(429, "{}") }, limited).upload("https://map.example.test/", listOf(chunk))
        assertEquals("rate_limited", limited.get(eventId)!!.reason)

        val offline = MemoryStates()
        RescueServerSync(FakeHttp { throw IOException("offline") }, offline).upload("https://map.example.test/", listOf(chunk))
        assertEquals(RescueUploadState(1, "WAITING_UPLOAD", "network_unavailable"), offline.get(eventId))
    }

    @Test
    fun `download ingests only crowd-rescue chunks and counts what was stored`() = runBlocking {
        val body = JSONObject().put("chunks", JSONArray().put(chunk).put(JSONObject().put("dataset_id", "crowd-reports")))
        val http = FakeHttp { RescueHttpResponse(200, body.toString()) }
        val ingested = mutableListOf<String>()
        val count = RescueServerSync(http, MemoryStates()).download(
            "https://map.example.test/",
            listOf(121.57, 25.05, 121.6, 25.08),
        ) { ingested += it.getString("chunk_id"); true }
        assertEquals(1, count)
        assertEquals(listOf(chunk.getString("chunk_id")), ingested)
        assertEquals("https://map.example.test/v1/crowd/rescue-events?bbox=121.57%2C25.05%2C121.6%2C25.08", http.gets.single())
    }
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.resilientgeo.mesh.online.RescueServerSyncTest"`
Expected: 編譯失敗

- [ ] **Step 3: 實作 `RescueServerSync.kt`**

```kotlin
package com.resilientgeo.mesh.online

import android.content.Context
import com.resilientgeo.mesh.trust.RescueContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

data class RescueHttpResponse(val status: Int, val body: String)

interface RescueHttp {
    suspend fun post(url: String, json: String): RescueHttpResponse
    suspend fun get(url: String): RescueHttpResponse
}

data class RescueUploadState(val version: Int, val state: String, val reason: String?)

interface RescueUploadStates {
    fun get(eventId: String): RescueUploadState?
    fun put(eventId: String, state: RescueUploadState)
}

class SharedPreferencesRescueUploadStates(context: Context) : RescueUploadStates {
    private val prefs = context.applicationContext.getSharedPreferences("rescue-upload", Context.MODE_PRIVATE)

    override fun get(eventId: String): RescueUploadState? = prefs.getString(eventId, null)?.let {
        runCatching {
            val json = JSONObject(it)
            RescueUploadState(json.getInt("version"), json.getString("state"), json.optString("reason").takeIf { reason -> reason.isNotEmpty() })
        }.getOrNull()
    }

    override fun put(eventId: String, state: RescueUploadState) {
        prefs.edit().putString(
            eventId,
            JSONObject().put("version", state.version).put("state", state.state).put("reason", state.reason ?: "").toString(),
        ).apply()
    }
}

/**
 * Uploads this device's crowd-rescue chunks and downloads nearby ones. The
 * server relays chunks unchanged, so anything downloaded still goes through
 * the normal chunk verification before it reaches Room or the mesh.
 */
class RescueServerSync(private val http: RescueHttp, private val states: RescueUploadStates) {

    suspend fun upload(baseUrl: String, chunks: List<JSONObject>) {
        val url = endpoint(baseUrl)
        for (chunk in chunks) {
            if (chunk.optString("dataset_id") != RescueContract.DATASET_ID) continue
            val event = chunk.getJSONArray("events").getJSONObject(0)
            val eventId = event.getString("event_id")
            val version = event.getInt("event_version")
            val known = states.get(eventId)
            if (known != null && known.version == version && known.state != WAITING) continue
            val response = try {
                http.post(url, chunk.toString())
            } catch (error: IOException) {
                states.put(eventId, RescueUploadState(version, WAITING, "network_unavailable"))
                continue
            }
            states.put(eventId, stateFor(version, response))
        }
    }

    suspend fun download(baseUrl: String, bbox: List<Double>, ingest: suspend (JSONObject) -> Boolean): Int {
        require(bbox.size == 4) { "bbox must have four values" }
        val query = URLEncoder.encode(bbox.joinToString(",") { formatCoordinate(it) }, StandardCharsets.UTF_8.name())
        val response = http.get("${endpoint(baseUrl)}?bbox=$query")
        if (response.status == 404) throw IOException("server_unavailable")
        if (response.status != 200) throw IOException("rescue feed HTTP ${response.status}")
        val chunks = JSONObject(response.body).optJSONArray("chunks") ?: return 0
        var stored = 0
        for (index in 0 until chunks.length()) {
            val chunk = chunks.optJSONObject(index) ?: continue
            if (chunk.optString("dataset_id") != RescueContract.DATASET_ID) continue
            if (ingest(chunk)) stored += 1
        }
        return stored
    }

    private fun stateFor(version: Int, response: RescueHttpResponse): RescueUploadState = when (response.status) {
        200, 201 -> RescueUploadState(version, ACCEPTED, null)
        400, 409, 413 -> {
            val body = runCatching { JSONObject(response.body) }.getOrNull()
            RescueUploadState(version, REJECTED, body?.optString("reason")?.takeIf { it.isNotEmpty() } ?: body?.optString("error")?.takeIf { it.isNotEmpty() } ?: "http_${response.status}")
        }
        404 -> RescueUploadState(version, WAITING, "server_unavailable")
        429 -> RescueUploadState(version, WAITING, "rate_limited")
        else -> RescueUploadState(version, WAITING, "network_unavailable")
    }

    private fun endpoint(baseUrl: String): String {
        val base = if (baseUrl.endsWith('/')) baseUrl else "$baseUrl/"
        return "${base}v1/crowd/rescue-events"
    }

    /** Doubles print like JS (121.6, not 121.60000000000001) for the values this app produces. */
    private fun formatCoordinate(value: Double): String = java.math.BigDecimal(value).setScale(6, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    companion object {
        const val WAITING = "WAITING_UPLOAD"
        const val ACCEPTED = "ACCEPTED"
        const val REJECTED = "REJECTED"
    }
}

object UrlConnectionRescueHttp : RescueHttp {
    private const val MAX_BYTES = 1024 * 1024

    override suspend fun post(url: String, json: String): RescueHttpResponse = request(url) { connection ->
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(json.toByteArray(StandardCharsets.UTF_8)) }
    }

    override suspend fun get(url: String): RescueHttpResponse = request(url) { it.requestMethod = "GET" }

    private suspend fun request(url: String, configure: (HttpURLConnection) -> Unit): RescueHttpResponse = withContext(Dispatchers.IO) {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-cache")
        try {
            configure(connection)
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val output = ByteArrayOutputStream()
            stream?.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    if (output.size() + size > MAX_BYTES) throw IOException("rescue response too large")
                    output.write(buffer, 0, size)
                }
            }
            RescueHttpResponse(status, output.toString(StandardCharsets.UTF_8.name()))
        } finally {
            connection.disconnect()
        }
    }
}
```

（測試期望的 bbox 編碼 `121.57%2C25.05%2C121.6%2C25.08`：`formatCoordinate(121.6)` 輸出 `121.6`。）

- [ ] **Step 4: Repository、bridge、GovernmentSyncManager**

`MeshRepository`：

```kotlin
    /** Cached crowd-rescue chunk of the latest version of each of this device's requests. */
    suspend fun ownRescueChunks(): List<JSONObject> = withContext(Dispatchers.IO) {
        ownRescueRequests().mapNotNull { entity ->
            cachedChunkJson(
                RescueContract.DATASET_ID,
                RescueContract.NAMESPACE,
                CrowdChunkCodec.chunkIdFor(entity.eventId, RescueContract.NAMESPACE),
            )
        }
    }
```

`FlutterMapBridge`：

- 建構參數加 `private val rescueUploadStates: RescueUploadStates = SharedPreferencesRescueUploadStates(context)`、`private val rescueSync: RescueServerSync = RescueServerSync(UrlConnectionRescueHttp, rescueUploadStates)`。
- `getOwnRescueRequests` 改為：

```kotlin
                val rows = repository.ownRescueRequests()
                result.success(mapOf("requests" to rows.map { row ->
                    val state = rescueUploadStates.get(row.eventId)?.takeIf { it.version == row.eventVersion }
                    MapBridgeProtocol.rescueSaved(row, state?.state ?: "NOT_UPLOADED", state?.reason)
                }))
```

  （`MapBridgeProtocol.rescueSaved` 加第三個參數 `serverReason: String? = null`，放入 `"server_reason"`。）
- `replyRescue` 在 `Saved` 分支回覆後呼叫 `scope.launch { uploadOwnRescue() }`。
- 新增：

```kotlin
    private suspend fun uploadOwnRescue() {
        val base = governmentSync.message()["url"] as? String
        if (base.isNullOrBlank()) return
        runCatching { rescueSync.upload(base, repository.ownRescueChunks()) }
    }
```

- `onMethodCall` 加 `"syncRescueNearby" -> syncRescueNearby(call, result)`：

```kotlin
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
```

`GovernmentSyncManager.sync()` 的 `try { ... }` 區塊之後、`finally` 之前加入一個獨立的嘗試（失敗不改寫 `error`）：

```kotlin
            runCatching {
                val repository = MeshRepository(context)
                RescueServerSync(UrlConnectionRescueHttp, SharedPreferencesRescueUploadStates(context))
                    .upload(url, repository.ownRescueChunks())
            }
```

（放在 `try` 之外、`syncing = false` 之前，讓 feed 失敗時仍會嘗試上傳求救。）

- [ ] **Step 5: 執行測試確認通過**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.resilientgeo.mesh.online.*" --tests "com.resilientgeo.mesh.bridge.*"; .\gradlew.bat assembleDebug`
Expected: PASS；build 成功

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/resilientgeo/mesh/online android/app/src/main/java/com/resilientgeo/mesh/data/MeshRepository.kt android/app/src/main/java/com/resilientgeo/mesh/bridge android/app/src/test/java/com/resilientgeo/mesh/online/RescueServerSyncTest.kt
git commit -m "feat(android): exchange rescue chunks with the server when online"
```

---

### Task 28: 文件

**Files:**
- Modify: `docs/data-contract-v0.md`（新增「求救事件（crowd.rescue）」一節；「群眾回報簽章」補同簽章者規則）
- Modify: `docs/peer-sync-v0.md`（`crowd-rescue` dataset）
- Modify: `README.md`（功能列表新增「需要救援」）
- Modify: `docs/README.md`（索引連到規格與計畫）
- Modify: `docs/mvp-remaining-tasks.md`（隱私段落補求救的位置與描述公開說明）

**Interfaces:**
- Consumes: 規格與本計畫全部任務

- [ ] **Step 1: `docs/data-contract-v0.md`**

在「官方查證事件」之前新增一節，內容（逐條，用既有文件的口吻）：

1. 識別：`crowd.rescue`／`RESCUE_REQUEST`／`CROWD`／`rescue-request-v0`；event_id 內嵌簽章者指紋並在驗章時檢查。
2. attributes 表格（同規格 §2.2）與允許清單。
3. urgency 推導表；`severity` 即 urgency；人數不影響。
4. TTL、延長、72 小時上限；終態沿用 `expires_at`。
5. 驗證階段 `contract`，以及錯誤代碼表（01 Task 1）。
6. 套用規則：所有 `crowd.*` 更新需同一 `signing_key_id`；`crowd.rescue` 的終態、`first_issued_at` 規則。
7. 轉傳單位：crowd-rescue chunk；server 原樣保存與回傳。
8. 三端實作與共用 fixture：`pipeline/lib/rescue-contract.mjs`、`rescue-request.mjs`、Android `trust/RescueContract.kt`、`report/RescueRequestFactory.kt`、Web `flutter/web/rescue_outbox.js`、`fixtures/rescue-requests-v0.json`。

「群眾回報簽章」一節末尾補一句：「同一 `(namespace, event_id)` 的較新版本必須由相同 `signing_key_id` 簽署，否則以 `signer_mismatch` 拒收；既有回報永遠是 v1，不受影響。」

- [ ] **Step 2: `docs/peer-sync-v0.md`**

在「群眾回報分片」之後新增「求救分片」：dataset `crowd-rescue`、manifest `crowd-rescue:none`、chunk_id `crowd-rescue:<event_id>`、新版本沿用同一 chunk_id 以 `chunk_hash` 差異觸發 stale 重拉、他人求救保留 300 筆與淘汰順序、舊版 App 不轉傳此 dataset。

- [ ] **Step 3: `README.md`**

在「民眾回報 + 政府查證」之後新增一點：

```markdown
- **需要救援（求救點）** — 本人或現場人員可建立求救點：類型（需要急救、無法移動、受困、受困於瓦礫、其他）、人數與幾個是非題，急迫程度由規則推導（受困於瓦礫固定為危急），不提供手選。求救以裝置金鑰簽章、標示未經查證，可更新、延長（最多 72 小時）、標記已安全或取消；只有原裝置能修改。Android 經 mesh 轉傳並在有網路時與伺服器交換，Web 以瀏覽器金鑰簽章後上傳；兩端都能看到附近的求救點。受困於瓦礫時首頁會出現「發出定位警報聲」，由使用者按下才播放 60 秒的三短聲（Android 可鎖屏播放），只讓本機發聲，不代表已聯絡 119。
```

- [ ] **Step 4: 其餘文件**

`docs/README.md` 索引加入規格與計畫連結；`docs/mvp-remaining-tasks.md` 隱私段落補：「求救帶精確位置與描述，經 mesh 與伺服器公開給附近的人；伺服器查詢有範圍與頻率限制，資料 7 天後刪除。」

- [ ] **Step 5: Commit**

```bash
git add docs/data-contract-v0.md docs/peer-sync-v0.md README.md docs/README.md docs/mvp-remaining-tasks.md
git commit -m "docs: rescue request contract, relay and product notes"
```

---

### Task 29: 完整驗證與交付

**Files:** 無新增；只執行檢查與整理交付內容。

- [ ] **Step 1: 自動化測試**

依序執行並保存輸出（失敗就停下修正，不得略過）：

```powershell
node --test pipeline/test server/test
cd flutter; flutter analyze; flutter test; flutter build web --release; cd ..
cd android; .\gradlew.bat testDebugUnitTest; .\gradlew.bat assembleDebug; cd ..
```

有裝置或模擬器時：

```powershell
cd android
.\gradlew.bat connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.resilientgeo.mesh.data.RescueRequestRepositoryInstrumentedTest"
.\gradlew.bat connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.resilientgeo.mesh.siren.LocatorSirenServiceInstrumentedTest"
.\gradlew.bat connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.resilientgeo.mesh.data.CrowdReportRepositoryInstrumentedTest"
cd ..
```

- [ ] **Step 2: Android 實機（有裝置時，否則列為人工驗證）**

| 檢查 | 預期 |
|---|---|
| 建立 TRAPPED_DEBRIS 求救 | 首頁出現狀態卡與「發出定位警報聲」；送出後沒有自動播放 |
| 按下警報 | 播放三短聲；顯示「停止警報」與倒數 |
| 60 秒 | 自動停止，出現「再次播放」 |
| 播放中鎖屏、切到別的 App、從最近清單滑掉 App | 持續播放；通知列與鎖屏通知可按「停止警報」 |
| 播放中來電 | 停止並顯示「來電或其他音訊中斷了警報聲」 |
| 鬧鐘音量調到 0 後按下 | 不播放，顯示「鬧鐘音量為 0」 |
| 開啟勿擾（完全靜音） | 顯示「勿擾模式可能讓警報聲無法播放」 |
| 拒絕通知權限後播放 | 顯示「未允許通知：鎖屏時只能回到 App 內停止」 |
| 飛航模式 | 警報可用；建立求救後狀態為「已存於本機，等待附近裝置轉傳；伺服器：等待上傳」 |
| 關閉 App 再開 | 進行中的求救恢復顯示 |
| 標記已安全／取消 | 狀態卡消失，地圖上不再有該求救點 |
| 兩台手機 mesh | 求救點在另一台出現，更新與已安全也會同步 |

- [ ] **Step 3: Chrome（可用時，否則列為人工驗證）**

| 檢查 | 預期 |
|---|---|
| 「需要救援」送出 | 先顯示「等待上傳」，伺服器接受後變「伺服器已接收，仍未經查證」 |
| DevTools 離線後送出 | 保持等待上傳；恢復連線後自動變為已接收 |
| 伺服器回 409（同 key 已有 ACTIVE） | 顯示「未送出：此裝置已有進行中的求救」 |
| 按下定位警報 | 只在點擊後播放；可停止；60 秒自動停止 |
| 網站設定把「音效」設為封鎖 | 顯示「瀏覽器拒絕播放聲音…」，不顯示播放中 |
| 播放中切到其他分頁 | 回來後看到「頁面在背景，瀏覽器可能已暫停聲音」 |
| 清除網站資料 | 舊求救不再能更新（介面不再顯示），已上傳的會在到期後消失 |
| 地圖移到 Android 求救附近 | 看到同樣外觀的求救 marker 與詳情 |

- [ ] **Step 4: 範圍檢查**

```powershell
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

確認：

- `.pub-cache/` 仍是未追蹤、未被修改或刪除。
- diff 只包含本計畫列出的檔案；若出現其他檔案，逐一說明原因或還原該處本功能造成的變動（不得動到非本功能的內容）。
- `grep -rn "定位警報聲尚未啟用" flutter/lib` 無結果。
- log 與回應不輸出描述或座標：`grep -rn "description" server/src/routes/crowd-rescue.mjs` 只出現在註解。

- [ ] **Step 5: 交付報告與 PR（push 與開 PR 前先取得使用者同意）**

交付訊息分成以下段落（PR 描述也用同樣結構，結尾加 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`）：

1. 共用資料契約與後端變更
2. Flutter／Android 變更
3. Web 變更
4. Flutter／Android 驗收結果（附指令與結果）
5. Web 驗收結果（附指令與結果）
6. 未完成項目與平台限制（至少：Web 不保證背景與鎖屏播放、Web 金鑰隨網站資料清除而遺失、舊版 App 不轉傳 `crowd-rescue`、速率限制在多 replica 時為近似值、docker compose 版沒有自動刪除、上架 Google Play 前需在 Play Console 申報 mediaPlayback 前景服務並附操作影片）
7. 未通過、未執行或只能人工驗證的測試（逐項列出）
8. git diff 範圍，並確認未覆蓋使用者原有變更

使用者同意後：

```powershell
git push -u origin feat/rescue-request
gh pr create --base main --head feat/rescue-request --title "需要救援／求救點與本機定位警報" --body-file <交付報告檔>
```
