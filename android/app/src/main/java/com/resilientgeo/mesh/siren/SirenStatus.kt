package com.resilientgeo.mesh.siren

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class SirenPhase { IDLE, STARTING, PLAYING, STOPPING, AUTO_STOPPED, INTERRUPTED, FAILED }

data class SirenStatus(
    val phase: SirenPhase,
    val reason: String? = null,
    val endsAtEpochMillis: Long? = null,
    val warnings: List<String> = emptyList(),
) {
    fun toMessage(): Map<String, Any?> = mapOf(
        "phase" to phase.name,
        "reason" to reason,
        "ends_at_epoch_ms" to endsAtEpochMillis,
        "warnings" to warnings,
    )
}

/** One status for the whole process: the service writes it, the Flutter bridge reads it. */
object SirenStatusHolder {
    private val state = MutableStateFlow(SirenStatus(SirenPhase.IDLE))
    val status: StateFlow<SirenStatus> = state.asStateFlow()

    fun update(next: SirenStatus) {
        state.value = next
    }
}

/** Pure checks so the decisions are JVM-testable; the service supplies the system values. */
object SirenPreflight {
    const val INTERRUPTION_FILTER_NONE = 3
    const val INTERRUPTION_FILTER_ALARMS = 4

    /** A muted alarm stream would play silently; report it instead of pretending. */
    fun failure(alarmVolume: Int): String? = if (alarmVolume <= 0) "volume_zero" else null

    fun warnings(interruptionFilter: Int, notificationsAllowed: Boolean): List<String> = buildList {
        if (interruptionFilter == INTERRUPTION_FILTER_NONE || interruptionFilter == INTERRUPTION_FILTER_ALARMS) add("dnd_may_block")
        if (!notificationsAllowed) add("notifications_denied")
    }
}
