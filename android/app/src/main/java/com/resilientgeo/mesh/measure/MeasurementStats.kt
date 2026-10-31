package com.resilientgeo.mesh.measure

/** Summary shown on the measurement screen; percentiles use nearest rank like the routing profile docs. */
data class MeasurementStats(
    val trials: Int,
    val successes: Int,
    val completeP50Millis: Long?,
    val completeP95Millis: Long?,
    val medianBytesPerSecond: Long?,
) {
    companion object {
        fun of(results: List<MeasurementTrial.Result>): MeasurementStats {
            val succeeded = results.filter { it.succeeded }
            val complete = succeeded.mapNotNull { it.completeMillis }.sorted()
            val throughput = succeeded.mapNotNull { it.bytesPerSecond }.sorted()
            return MeasurementStats(
                trials = results.size,
                successes = succeeded.size,
                completeP50Millis = percentile(complete, 0.50),
                completeP95Millis = percentile(complete, 0.95),
                medianBytesPerSecond = percentile(throughput, 0.50),
            )
        }

        fun percentile(sorted: List<Long>, p: Double): Long? {
            if (sorted.isEmpty()) return null
            val rank = kotlin.math.ceil(p * sorted.size).toInt().coerceIn(1, sorted.size)
            return sorted[rank - 1]
        }
    }
}
