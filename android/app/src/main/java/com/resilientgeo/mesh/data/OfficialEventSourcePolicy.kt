package com.resilientgeo.mesh.data

import org.json.JSONArray
import org.json.JSONObject

private val cwaLiveFeedNamespaces = setOf(
    "official.live.cwa-earthquake",
    "official.live.cwa-warning",
    "official.live.cwa-typhoon",
)
private val supportedOfficialFeedDatasetIds = setOf(
    "ncdr", "cwa-earthquake", "cwa-warning", "cwa-typhoon",
    "government-announcements", "government-attestations", "government-device-announcements",
    "government-device-revocations",
)

internal val visibleNcdrCategoryCodes = setOf(
    "typhoon", "earthquake", "tsunami", "flood", "debris_landslide", "rainfall",
    "road_closed", "air_defense", "thunderstorm", "infectious_disease", "low_temperature",
    "strong_wind", "fog", "fire", "wildfire_risk", "diversion_alarm", "evacuation",
    "radiation", "high_temperature", "volcano", "ramp_connector_flood", "wind_control_road",
    "railway_accident", "urgent_clinic", "highway_condition", "landslide_dam_warning",
    "national_park_admission", "local_government_report", "public_natural_gas_report",
    "national_forest_recreation", "flood_sensor", "giant_wave",
)

private val ncdrCategoryCodesByLabel = mapOf(
    "颱風" to "typhoon", "地震" to "earthquake", "海嘯" to "tsunami", "淹水" to "flood",
    "土石流及大規模崩塌" to "debris_landslide", "降雨" to "rainfall", "道路封閉" to "road_closed",
    "防空" to "air_defense", "雷雨" to "thunderstorm", "傳染病" to "infectious_disease",
    "低溫" to "low_temperature", "強風" to "strong_wind", "濃霧" to "fog", "火災" to "fire",
    "林火危險度預警" to "wildfire_risk", "分洪警報" to "diversion_alarm", "疏散避難" to "evacuation",
    "輻射災害" to "radiation", "高溫" to "high_temperature", "火山" to "volcano",
    "交流道下地方連絡道淹水" to "ramp_connector_flood", "強風管制路段" to "wind_control_road",
    "鐵路事故" to "railway_accident", "急門診通報" to "urgent_clinic", "高速公路路況事件" to "highway_condition",
    "堰塞湖警戒" to "landslide_dam_warning", "國家公園入園示警" to "national_park_admission",
    "各直轄市縣市政府災情通報" to "local_government_report", "公用天然氣事業災情通報" to "public_natural_gas_report",
    "國家森林遊樂區" to "national_forest_recreation", "淹水感測" to "flood_sensor", "巨浪" to "giant_wave",
)

private val ncdrSourceCategoryRules = listOf(
    "ramp_connector_flood" to Regex("交流道.{0,12}地方連絡道.{0,8}淹水|ramp.{0,20}connector.{0,20}flood"),
    "flood_sensor" to Regex("淹水感測|flood.{0,12}sensor"),
    "landslide_dam_warning" to Regex("堰塞湖|landslide.?dam"),
    "debris_landslide" to Regex("土石流|大規模崩塌|debris.?flow|landslide"),
    "national_forest_recreation" to Regex("國家森林遊樂區|forest.?recreation|facilityclos"),
    "wildfire_risk" to Regex("林火危險度|森林火災危險度|wildfire(?:.?risk)?"),
    "wind_control_road" to Regex("強風管制路段|強風.{0,8}管制.{0,8}路段|wind.{0,12}control.{0,12}road"),
    "highway_condition" to Regex("高速公路路況事件|國道.{0,8}路況|highway.{0,12}(?:condition|incident)"),
    "railway_accident" to Regex("鐵路事故|railway.?accident"),
    "urgent_clinic" to Regex("急門診通報|急診.{0,8}門診|hospitalreport|urgent.?clinic"),
    "public_natural_gas_report" to Regex("公用天然氣事業災情通報|天然氣.{0,8}災情通報|natural.?gas.{0,12}incident"),
    "local_government_report" to Regex("各直轄市縣市政府災情通報|地方政府災情通報|local.?government.{0,12}disaster.?report"),
    "national_park_admission" to Regex("國家公園入園示警|國家公園.{0,8}入園|national.?park.{0,12}admission"),
    "giant_wave" to Regex("巨浪|長浪|giant.?wave|large.?wave"),
    "tsunami" to Regex("海嘯|tsunami"),
    "typhoon" to Regex("颱風|typhoon"),
    "earthquake" to Regex("地震|earthquake"),
    "road_closed" to Regex("道路封閉|封閉道路|路段封閉|road.?clos(?:ed|ure)"),
    "air_defense" to Regex("防空|air.?defen[cs]e|air.?raid"),
    "thunderstorm" to Regex("雷雨|雷暴|thunderstorm"),
    "infectious_disease" to Regex("傳染病|感染症|infectious.?disease"),
    "low_temperature" to Regex("低溫|寒流|low.?temperature"),
    "strong_wind" to Regex("強風|strong.?wind"),
    "fog" to Regex("濃霧|fog"),
    "fire" to Regex("火災|\\bfire(?:_warning)?\\b"),
    "diversion_alarm" to Regex("分洪警報|分洪|洩洪警報|diversion.?alarm"),
    "evacuation" to Regex("疏散避難|疏散|避難|撤離|evacuation"),
    "radiation" to Regex("輻射災害|輻射|radiation"),
    "high_temperature" to Regex("高溫|heat(?:_warning)?"),
    "volcano" to Regex("火山|volcano"),
    "flood" to Regex("淹水|積水|洪水|flood"),
    "rainfall" to Regex("降雨|雨量|大雨|豪雨|rainfall|heavy.?rain|\\brain\\b"),
)

/** Unknown and excluded NCDR records fail closed so they are neither cached nor relayed. */
internal fun ncdrCategoryCode(event: JSONObject): String {
    val attributes = event.optJSONObject("attributes") ?: JSONObject()
    val sourceRecord = attributes.optJSONObject("source_record")
    val sourceRecordText = sourceRecord?.toString().orEmpty().lowercase()
    val sourceType = attributes.optString("ncdr_source_event_type").takeIf(String::isNotBlank)
        ?: sourceEventField(sourceRecord, "event", "Event", "phenomenon", "Phenomenon", "event_type", "EventType", "hazard_type", "HazardType")
    val sourceCode = attributes.optString("ncdr_source_event_code").takeIf(String::isNotBlank)
        ?: sourceEventCode(sourceRecord)
    val normalizedType = event.optString("event_type").lowercase()
    val exclusionText = listOf(sourceType.orEmpty(), sourceCode.orEmpty(), normalizedType, sourceRecordText)
        .joinToString(" ").lowercase()
    if (exclusionText.contains("消防安全檢查") || exclusionText.contains("重大不合格場所") ||
        exclusionText.contains("dangerfield") || exclusionText.contains("海洋污染") ||
        exclusionText.contains("marinepollution") || exclusionText.contains("marine pollution") ||
        exclusionText.contains("停水") || exclusionText.contains("供水") ||
        exclusionText.contains("water supply") || exclusionText.contains("watersupply") ||
        exclusionText.contains("wateroutage") || exclusionText.contains("safety_alert") ||
        exclusionText.contains("water_supply_alert") || exclusionText.contains("marine_pollution_alert")) return "other"

    val categoryCode = attributes.optString("ncdr_category_code").takeIf(String::isNotBlank)
    if (categoryCode != null) return categoryCode
    val categoryLabel = attributes.optString("ncdr_category_label").trim()
    ncdrCategoryCodesByLabel[categoryLabel]?.let { return it }

    val classificationText = sourceType ?: sourceCode ?: normalizedType
    if ((sourceType != null || sourceCode != null) && sourceCategory(classificationText) == null) return "other"
    return sourceCategory(classificationText) ?: "other"
}

internal fun isVisibleNcdrEvent(event: JSONObject): Boolean =
    ncdrCategoryCode(event) in visibleNcdrCategoryCodes

private fun sourceEventField(record: JSONObject?, vararg keys: String): String? {
    if (record == null) return null
    fun find(obj: JSONObject?): String? = obj?.let { value ->
        keys.asSequence().mapNotNull { key -> value.optString(key).takeIf(String::isNotBlank) }.firstOrNull()
    }
    val direct = find(record)
    if (direct != null) return direct
    val rawInfo = record.opt("info") ?: record.opt("Info")
    val infos = when (rawInfo) {
        is JSONArray -> (0 until rawInfo.length()).mapNotNull { rawInfo.optJSONObject(it) }
        is JSONObject -> listOf(rawInfo)
        is String -> runCatching {
            val parsed = JSONObject(rawInfo)
            listOf(parsed)
        }.getOrElse { runCatching { JSONArray(rawInfo).let { array -> (0 until array.length()).mapNotNull(array::optJSONObject) } }.getOrDefault(emptyList()) }
        else -> emptyList()
    }
    return infos.asSequence().mapNotNull(::find).firstOrNull()
}

private fun sourceEventCode(record: JSONObject?): String? {
    if (record == null) return null
    val direct = sequenceOf("capCode", "CapCode", "event_code", "EventCode", "eventCode")
        .mapNotNull { key -> record.optString(key).takeIf(String::isNotBlank) }
        .firstOrNull()
    if (direct != null) return direct
    val infoEventCode = sourceEventField(record, "eventCode", "EventCode") ?: return null
    return infoEventCode
}

private fun sourceCategory(value: String): String? {
    val text = value.lowercase()
    return ncdrSourceCategoryRules.firstOrNull { (_, pattern) -> pattern.containsMatchIn(text) }?.first
}

internal fun officialFeedNamespace(sourceId: String): String = when (sourceId) {
    "government-announcements" -> "official.announcement"
    "government-attestations" -> "official.verified"
    "government-device-announcements" -> "official.announcement"
    "government-device-revocations" -> "official.device-revocation"
    else -> "official.live.$sourceId"
}

internal fun supportsOfficialFeedDataset(sourceId: String): Boolean =
    sourceId in supportedOfficialFeedDatasetIds

internal fun supportsOfficialEvent(namespace: String, source: String?): Boolean = when {
    namespace == "official.announcement" -> source.equals("GOVERNMENT", ignoreCase = true)
    namespace == "official.verified" -> source.equals("GOV_ATTEST", ignoreCase = true)
    namespace == "official.device-revocation" -> source.equals("GOVERNMENT", ignoreCase = true)
    isNcdrNamespace(namespace) -> source.equals("NCDR", ignoreCase = true)
    isCwaNamespace(namespace) -> source.equals("CWA", ignoreCase = true)
    else -> !namespace.startsWith("official.")
}

internal fun supportsOfficialNamespace(namespace: String): Boolean =
    !namespace.startsWith("official.") || namespace in setOf("official.announcement", "official.verified", "official.device-revocation") ||
        isNcdrNamespace(namespace) || isCwaNamespace(namespace)

internal fun isInternalOfficialMetadata(namespace: String, attributes: org.json.JSONObject?): Boolean =
    namespace == "official.device-revocation" || attributes?.optBoolean("internal_only", false) == true

internal fun isNcdrNamespace(namespace: String): Boolean =
    namespace == "official.ncdr" || namespace.startsWith("official.ncdr.") ||
        namespace == "official.live.ncdr" || namespace.startsWith("official.live.ncdr.")

private fun isCwaNamespace(namespace: String): Boolean =
    namespace == "official.cwa" || namespace.startsWith("official.cwa.") ||
        namespace == "official.live.cwa" || namespace.startsWith("official.live.cwa.") ||
        namespace in cwaLiveFeedNamespaces
