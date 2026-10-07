package com.resilientgeo.mesh.data

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPInputStream

/** Downloads signed per-county doorplate indexes into app-private storage. */
class OfflineAddressPackStore(
    context: Context,
    private val serviceBase: () -> URL,
) {
    private val appContext = context.applicationContext
    private val directory = File(appContext.filesDir, "address-packs")
    private val progress = AtomicReference<Map<String, Any?>>(progressState("idle"))
    private val searchDatabase: SQLiteDatabase by lazy {
        appContext.openOrCreateDatabase("offline-address-packs.sqlite", Context.MODE_PRIVATE, null).also { db ->
            db.execSQL("CREATE TABLE IF NOT EXISTS address_entries (pack_hash TEXT NOT NULL, county_code TEXT NOT NULL, address_id TEXT NOT NULL, search_key TEXT NOT NULL, address TEXT NOT NULL, region TEXT, longitude REAL NOT NULL, latitude REAL NOT NULL, PRIMARY KEY(pack_hash,address_id,search_key))")
            db.execSQL("CREATE INDEX IF NOT EXISTS address_entries_prefix ON address_entries(pack_hash,search_key)")
        }
    }
    private val trustedKeys: TrustedKeyStore by lazy {
        appContext.assets.open("trust/trusted-keys.json").bufferedReader().use {
            TrustedKeyStore.fromJson(it.readText())
        }
    }

    @Synchronized
    fun catalogJson(): String {
        val currentFile = File(directory, CURRENT_FILE)
        val previous = readCurrent(currentFile)
        val catalog = try {
            if (!hasNetwork()) throw IllegalStateException("network unavailable")
            val response = fetchText(URL(serviceBase(), CATALOG_PATH))
            JSONObject(response).also(::verifyCatalog)
        } catch (error: Throwable) {
            val cached = previous?.optJSONObject("catalog")
                ?: throw IllegalStateException("門牌索引目錄目前無法取得", error)
            verifyCatalog(cached)
            cached
        }
        val next = previous ?: JSONObject()
        next.put("catalog", catalog)
        next.put("updated_at", java.time.Instant.now().toString())
        writeAtomically(currentFile, next.toString())
        return catalog.toString()
    }

    @Synchronized
    fun installedPacksJson(): String {
        val current = readCurrent(File(directory, CURRENT_FILE))
            ?: return JSONObject().put("counties", JSONArray()).put("records", JSONArray()).toString()
        val catalog = current.optJSONObject("catalog") ?: return JSONObject()
            .put("counties", JSONArray()).put("records", JSONArray()).toString()
        verifyCatalog(catalog)
        val installed = current.optJSONObject("installed") ?: JSONObject()
        val counties = JSONArray()
        for (countyCode in installed.keys()) {
            runCatching {
                val county = findCounty(catalog, countyCode) ?: return@runCatching
                val entry = installed.getJSONObject(countyCode)
                val manifest = entry.getJSONObject("manifest")
                verifyManifest(manifest, county, county.optString("manifest_sha256"))
                val fileName = manifest.getString("data_file")
                require(entry.optString("filename") == fileName)
                require(File(directory, fileName).isFile) { "門牌資料檔案不存在" }
                counties.put(countyCode)
            }
        }
        return JSONObject().put("counties", counties).toString()
    }

    @Synchronized
    fun searchPacksJson(query: String): String {
        val normalized = normalizeAddress(query)
        if (normalized.length < 2) return JSONObject().put("results", JSONArray()).toString()
        val current = readCurrent(File(directory, CURRENT_FILE))
            ?: return JSONObject().put("results", JSONArray()).toString()
        val installed = current.optJSONObject("installed") ?: return JSONObject().put("results", JSONArray()).toString()
        val results = JSONArray()
        val seen = mutableSetOf<String>()
        for (countyCode in installed.keys()) {
            val manifest = runCatching { installed.getJSONObject(countyCode).getJSONObject("manifest") }.getOrNull() ?: continue
            val packHash = manifest.optString("sha256")
            if (!SHA256.matches(packHash)) continue
            searchDatabase.rawQuery(
                "SELECT address_id,address,region,longitude,latitude FROM address_entries WHERE pack_hash=? AND search_key>=? AND search_key<? GROUP BY address_id ORDER BY length(address),address LIMIT 8",
                arrayOf(packHash, normalized, "$normalized\uffff"),
            ).use { cursor ->
                while (cursor.moveToNext() && results.length() < 8) {
                    val id = cursor.getString(0)
                    if (!seen.add(id)) continue
                    results.put(JSONObject()
                        .put("id", id)
                        .put("name", cursor.getString(1))
                        .put("aliases", JSONArray())
                        .put("kind", "address")
                        .put("region", cursor.getString(2))
                        .put("coordinate", JSONArray().put(cursor.getDouble(3)).put(cursor.getDouble(4)))
                        .put("address", cursor.getString(1))
                        .put("search_key", normalized))
                }
            }
        }
        return JSONObject().put("results", results).toString()
    }

    @Synchronized
    fun downloadCounty(countyCode: String, allowMobileData: Boolean): String {
        require(COUNTY_CODE.matches(countyCode)) { "縣市代碼無效" }
        progress.set(progressState("checking", countyCode = countyCode))
        val base = serviceBase()
        if (!hasNetwork()) return status("waiting_network", "目前離線；有網路後再下載門牌索引。")
        if (!allowMobileData && !hasWifi()) {
            return status("waiting_wifi", "請連上 Wi-Fi，或明確允許使用行動網路下載。")
        }
        val directoryReady = directory.mkdirs() || directory.isDirectory
        check(directoryReady) { "無法建立門牌資料儲存空間" }
        val currentFile = File(directory, CURRENT_FILE)
        val current = readCurrent(currentFile) ?: JSONObject()
        val previousEntry = current.optJSONObject("installed")?.optJSONObject(countyCode)
        val catalog = JSONObject(catalogJson())
        val county = findCounty(catalog, countyCode) ?: error("找不到該縣市的門牌索引")
        if (county.optString("coverage_status") == "unavailable") {
            return status("unavailable", "${county.optString("county_name")} 尚無門牌資料涵蓋。")
        }

        try {
            val manifestUrl = URL(base, county.getString("manifest_url"))
            require(manifestUrl.host == base.host && manifestUrl.protocol == base.protocol) {
                "門牌資料清單必須來自同一個可信服務"
            }
            val manifest = JSONObject(fetchText(manifestUrl))
            verifyManifest(manifest, county, county.getString("manifest_sha256"))
            val fileName = manifest.getString("data_file")
            val partial = File(directory, "$fileName.partial")
            downloadFile(URL(base, "address-packs/$fileName"), partial, manifest.getLong("size_bytes"), countyCode)
            progress.set(progressState("verifying", partial.length(), partial.length(), countyCode = countyCode))
            try {
                readAndIndexAddressPack(partial, manifest)
            } catch (error: Throwable) {
                partial.delete()
                throw error
            }
            val destination = File(directory, fileName)
            if (destination.exists()) destination.delete()
            check(partial.renameTo(destination)) { "無法安裝已驗證的門牌資料" }

            val savedManifest = JSONObject(manifest.toString())
            val nextInstalled = current.optJSONObject("installed") ?: JSONObject()
            nextInstalled.put(countyCode, JSONObject().put("filename", fileName).put("manifest", savedManifest))
            current.put("catalog", catalog)
            current.put("installed", nextInstalled)
            current.put("updated_at", java.time.Instant.now().toString())
            writeAtomically(currentFile, current.toString())
            runCatching {
                previousEntry?.let { entry ->
                    val oldName = entry.optString("filename")
                    if (oldName.isNotBlank() && oldName != fileName) File(directory, oldName).delete()
                    val oldHash = entry.optJSONObject("manifest")?.optString("sha256")
                    if (!oldHash.isNullOrBlank() && oldHash != manifest.optString("sha256")) {
                        searchDatabase.delete("address_entries", "county_code=? AND pack_hash=?", arrayOf(countyCode, oldHash))
                    }
                }
            }
            progress.set(progressState("ready", destination.length(), destination.length(), countyCode = countyCode))
            return JSONObject().put("status", "ready").put("county_code", countyCode).toString()
        } catch (error: Throwable) {
            progress.set(progressState("failed", message = error.message ?: "門牌資料下載或驗證失敗。", countyCode = countyCode))
            throw error
        }
    }

    fun progressState(): Map<String, Any?> = progress.get()

    private fun verifyCatalog(catalog: JSONObject) {
        require(catalog.optString("schema_version") == "address-pack-catalog-v1") { "門牌目錄格式無效" }
        require(catalog.optString("signature_algorithm") == "Ed25519") { "門牌目錄簽章演算法無效" }
        val counties = catalog.optJSONArray("counties") ?: error("門牌目錄缺少縣市")
        require(counties.length() == 22) { "門牌目錄必須列出 22 個縣市" }
        val codes = mutableSetOf<String>()
        for (index in 0 until counties.length()) {
            val county = counties.getJSONObject(index)
            val code = county.optString("county_code")
            require(COUNTY_CODE.matches(code) && codes.add(code)) { "門牌目錄縣市代碼重複或無效" }
            require(county.optString("coverage_status") in COVERAGE_STATES) { "門牌目錄涵蓋狀態無效" }
            if (county.optString("coverage_status") == "unavailable") {
                require(county.isNull("manifest_url") && county.isNull("manifest_sha256")) {
                    "未涵蓋縣市不能提供下載連結"
                }
            }
        }
        verifySignature(catalog)
    }

    private fun verifyManifest(manifest: JSONObject, county: JSONObject, pinnedHash: String) {
        require(manifest.optString("schema_version") == "address-pack-manifest-v1") { "門牌清單格式無效" }
        require(manifest.optString("county_code") == county.optString("county_code")) { "門牌縣市不符" }
        require(manifest.optString("coverage_status") == county.optString("coverage_status")) { "門牌涵蓋狀態不符" }
        require(manifest.optString("signature_algorithm") == "Ed25519") { "門牌清單簽章演算法無效" }
        require(manifest.optString("data_format") == "application/x-ndjson") { "門牌資料格式不支援" }
        require(DATA_FILE.matches(manifest.optString("data_file"))) { "門牌資料檔名無效" }
        require(manifest.optLong("size_bytes") > 0L) { "門牌資料大小無效" }
        require(SHA256.matches(manifest.optString("sha256"))) { "門牌資料 SHA-256 格式無效" }
        for (key in listOf("source_count", "located_count", "unlocated_count", "excluded_count")) {
            require(manifest.optLong(key) == county.optLong(key)) { "門牌清單筆數與目錄不符" }
        }
        require(manifest.getLong("source_count") == manifest.getLong("located_count") +
            manifest.getLong("unlocated_count") + manifest.getLong("excluded_count")) { "門牌涵蓋筆數加總不符" }
        require(Canonical.sha256Canonical(manifest) == pinnedHash) { "門牌清單 SHA-256 驗證失敗" }
        verifySignature(manifest)
    }

    private fun verifySignature(value: JSONObject) {
        val keyId = value.optString("signing_key_id")
        val signature = value.optString("signature")
        val publicKey = trustedKeys.publicKeyFor(keyId) ?: error("未信任的門牌資料簽章金鑰")
        val unsigned = JSONObject()
        for (key in value.keys()) if (key != "signature") unsigned.put(key, value.get(key))
        require(Ed25519Verifier.verify(Canonical.canonicalize(unsigned), signature, publicKey)) {
            "門牌資料簽章驗證失敗"
        }
    }

    private fun readAndIndexAddressPack(file: File, manifest: JSONObject) {
        require(file.isFile && file.length() == manifest.getLong("size_bytes")) { "門牌資料大小驗證失敗" }
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).buffered(BUFFER_SIZE).use { input ->
            val buffer = ByteArray(BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val actual = "sha256:" + digest.digest().joinToString("") { "%02x".format(it) }
        require(actual == manifest.getString("sha256")) { "門牌資料 SHA-256 驗證失敗" }
        val db = searchDatabase
        var count = 0L
        var header: JSONObject? = null
        db.beginTransaction()
        try {
            GZIPInputStream(FileInputStream(file).buffered(BUFFER_SIZE)).bufferedReader().useLines { lines ->
                lines.filter { it.isNotBlank() }.forEach { line ->
                    val row = JSONObject(line)
                    if (header == null) {
                        header = row
                        require(row.optString("schema_version") == "address-pack-ndjson-v1") { "門牌資料格式無效" }
                        require(row.optString("county_code") == manifest.optString("county_code")) { "門牌資料縣市不符" }
                        require(row.optJSONObject("summary")?.optLong("located_count") == manifest.getLong("located_count")) {
                            "門牌資料摘要筆數不符"
                        }
                        return@forEach
                    }
                    val coordinate = row.optJSONArray("coordinate") ?: error("門牌座標欄位無效")
                    require(coordinate.length() == 2) { "門牌座標順序無效" }
                    val longitude = coordinate.getDouble(0)
                    val latitude = coordinate.getDouble(1)
                    require(longitude in 118.0..122.2 && latitude in 21.8..26.5) { "門牌座標超出台灣範圍" }
                    require(row.optString("county_code") == manifest.optString("county_code")) { "門牌記錄縣市不符" }
                    indexAddressRecord(db, manifest.getString("sha256"), manifest.getString("county_code"), row, longitude, latitude)
                    count += 1
                }
            }
            require(header != null && count == manifest.getLong("located_count")) { "門牌已定位筆數不符" }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun indexAddressRecord(
        db: SQLiteDatabase,
        packHash: String,
        countyCode: String,
        record: JSONObject,
        longitude: Double,
        latitude: Double,
    ) {
        val address = record.optString("address", record.optString("name"))
        val id = record.optString("id")
        require(address.isNotBlank() && id.isNotBlank()) { "門牌記錄缺少地址或 ID" }
        val region = record.optString("region").takeIf { it.isNotBlank() }
        val searchKeys = linkedSetOf(normalizeAddress(record.optString("search_key")), normalizeAddress(address))
        val aliases = record.optJSONArray("aliases")
        if (aliases != null) for (index in 0 until aliases.length()) searchKeys.add(normalizeAddress(aliases.optString(index)))
        searchKeys.filter { it.isNotBlank() }.forEach { searchKey ->
            val values = ContentValues().apply {
                put("pack_hash", packHash)
                put("county_code", countyCode)
                put("address_id", id)
                put("search_key", searchKey)
                put("address", address)
                put("region", region)
                put("longitude", longitude)
                put("latitude", latitude)
            }
            db.insertWithOnConflict("address_entries", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        }
    }

    private fun normalizeAddress(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC)
        .replace("台", "臺")
        .replace(Regex("[\\s\\u3000]+"), "")
        .replace(Regex("[，,、]"), "")
        .lowercase(Locale.ROOT)

    private fun downloadFile(url: URL, partial: File, expectedSize: Long, countyCode: String) {
        require(url.host == serviceBase().host && url.protocol == serviceBase().protocol) { "門牌資料必須來自同一個可信服務" }
        var start = partial.length().coerceAtMost(expectedSize)
        if (partial.length() > expectedSize) {
            partial.delete()
            start = 0
        }
        if (start == expectedSize) return
        val connection = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept-Encoding", "identity")
            if (start > 0) setRequestProperty("Range", "bytes=$start-")
        }
        try {
            val status = connection.responseCode
            val append = when {
                start > 0 && status == HttpURLConnection.HTTP_PARTIAL &&
                    connection.getHeaderField("Content-Range")?.startsWith("bytes $start-") == true -> true
                status == HttpURLConnection.HTTP_OK -> false
                else -> error("門牌資料下載失敗 ($status)")
            }
            if (!append) start = 0
            progress.set(progressState("downloading", start, expectedSize, countyCode = countyCode))
            connection.inputStream.buffered(BUFFER_SIZE).use { input ->
                FileOutputStream(partial, append).buffered(BUFFER_SIZE).use { output ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        start += count
                        progress.set(progressState("downloading", start, expectedSize, countyCode = countyCode))
                    }
                    output.flush()
                }
            }
            require(partial.length() == expectedSize) { "門牌資料不完整；稍後可續傳。" }
        } finally {
            connection.disconnect()
        }
    }

    private fun fetchText(url: URL): String {
        require(url.protocol == "https" || isDebuggable()) { "門牌資料服務必須使用 HTTPS" }
        val connection = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Encoding", "identity")
        }
        try {
            require(connection.responseCode == HttpURLConnection.HTTP_OK) {
                "門牌索引更新失敗 (${connection.responseCode})"
            }
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun findCounty(catalog: JSONObject, code: String): JSONObject? {
        val counties = catalog.getJSONArray("counties")
        for (index in 0 until counties.length()) {
            val county = counties.getJSONObject(index)
            if (county.optString("county_code") == code) return county
        }
        return null
    }

    private fun readCurrent(file: File): JSONObject? = runCatching { JSONObject(file.readText()) }.getOrNull()

    private fun writeAtomically(destination: File, value: String) {
        directory.mkdirs()
        val temporary = File(directory, "${destination.name}.pending")
        FileOutputStream(temporary).bufferedWriter().use { it.write(value) }
        check(temporary.renameTo(destination) || temporary.copyTo(destination, overwrite = true).let { temporary.delete(); true }) {
            "無法寫入門牌資料版本指標"
        }
    }

    private fun hasNetwork(): Boolean {
        val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = manager.activeNetwork ?: return false
        return manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    private fun hasWifi(): Boolean {
        val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = manager.activeNetwork ?: return false
        return manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }

    private fun isDebuggable(): Boolean = appContext.applicationInfo.flags and
        android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun status(state: String, message: String): String {
        progress.set(progressState(state, message = message))
        return JSONObject().put("status", state).put("message", message).toString()
    }

    private fun progressState(
        state: String,
        loaded: Long = 0,
        total: Long = 0,
        message: String = "",
        countyCode: String? = null,
    ): Map<String, Any?> = mapOf(
        "state" to state,
        "loaded" to loaded,
        "total" to total,
        "message" to message,
        "county_code" to countyCode,
    )

    private companion object {
        const val CURRENT_FILE = "current.json"
        const val CATALOG_PATH = "/address-packs/catalog.json"
        const val BUFFER_SIZE = 128 * 1024
        const val CONNECT_TIMEOUT_MS = 20_000
        const val READ_TIMEOUT_MS = 120_000
        val COUNTY_CODE = Regex("^\\d{5}$")
        val DATA_FILE = Regex("^address-\\d{5}-[a-f0-9]{16}\\.ndjson\\.gz$")
        val SHA256 = Regex("^sha256:[a-f0-9]{64}$")
        val COVERAGE_STATES = setOf("complete", "partial", "unavailable")
    }
}
