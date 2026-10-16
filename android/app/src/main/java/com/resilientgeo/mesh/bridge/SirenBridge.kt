package com.resilientgeo.mesh.bridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.resilientgeo.mesh.siren.LocatorSirenService
import com.resilientgeo.mesh.siren.SirenPhase
import com.resilientgeo.mesh.siren.SirenStatus
import com.resilientgeo.mesh.siren.SirenStatusHolder
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Flutter access to the locator siren; the service owns playback, this only starts, stops and reports. */
class SirenBridge(
    private val context: Context,
    messenger: BinaryMessenger,
    private val requestNotificationPermission: () -> Unit,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val methodChannel = MethodChannel(messenger, "com.resilientgeo.mesh/siren")
    private val eventChannel = EventChannel(messenger, "com.resilientgeo.mesh/siren-events")
    private var observation: Job? = null

    init {
        methodChannel.setMethodCallHandler(this)
        eventChannel.setStreamHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                SirenStatusHolder.update(SirenStatus(SirenPhase.STARTING))
                try {
                    ContextCompat.startForegroundService(context, LocatorSirenService.intent(context, LocatorSirenService.ACTION_START))
                } catch (error: Exception) {
                    SirenStatusHolder.update(SirenStatus(SirenPhase.FAILED, reason = "foreground_start_blocked"))
                }
                result.success(SirenStatusHolder.status.value.toMessage())
            }
            "stop" -> {
                if (SirenStatusHolder.status.value.phase == SirenPhase.PLAYING) {
                    SirenStatusHolder.update(SirenStatus(SirenPhase.STOPPING))
                    context.startService(LocatorSirenService.intent(context, LocatorSirenService.ACTION_STOP))
                } else {
                    SirenStatusHolder.update(SirenStatus(SirenPhase.IDLE))
                }
                result.success(SirenStatusHolder.status.value.toMessage())
            }
            "status" -> result.success(SirenStatusHolder.status.value.toMessage())
            "notificationPermission" -> result.success(
                when {
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "not_required"
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED -> "granted"
                    else -> "denied"
                },
            )
            "requestNotificationPermission" -> {
                requestNotificationPermission()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        observation?.cancel()
        if (events == null) return
        observation = scope.launch { SirenStatusHolder.status.collect { events.success(it.toMessage()) } }
    }

    override fun onCancel(arguments: Any?) {
        observation?.cancel()
        observation = null
    }

    /** Detaches from the engine only; a playing siren keeps its own 60 s limit. */
    fun close() {
        observation?.cancel()
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        scope.cancel()
    }
}
