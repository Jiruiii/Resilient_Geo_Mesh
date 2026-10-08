package com.resilientgeo.mesh.data

private val cwaLiveFeedNamespaces = setOf(
    "official.live.cwa-earthquake",
    "official.live.cwa-warning",
    "official.live.cwa-typhoon",
)
private val supportedOfficialFeedDatasetIds = setOf(
    "ncdr", "cwa-earthquake", "cwa-warning", "cwa-typhoon",
)

internal fun supportsOfficialFeedDataset(sourceId: String): Boolean =
    sourceId in supportedOfficialFeedDatasetIds

internal fun supportsOfficialEvent(namespace: String, source: String?): Boolean = when {
    isNcdrNamespace(namespace) -> source.equals("NCDR", ignoreCase = true)
    isCwaNamespace(namespace) -> source.equals("CWA", ignoreCase = true)
    else -> !namespace.startsWith("official.")
}

internal fun supportsOfficialNamespace(namespace: String): Boolean =
    !namespace.startsWith("official.") || isNcdrNamespace(namespace) || isCwaNamespace(namespace)

private fun isNcdrNamespace(namespace: String): Boolean =
    namespace == "official.ncdr" || namespace.startsWith("official.ncdr.") ||
        namespace == "official.live.ncdr" || namespace.startsWith("official.live.ncdr.")

private fun isCwaNamespace(namespace: String): Boolean =
    namespace == "official.cwa" || namespace.startsWith("official.cwa.") ||
        namespace == "official.live.cwa" || namespace.startsWith("official.live.cwa.") ||
        namespace in cwaLiveFeedNamespaces
