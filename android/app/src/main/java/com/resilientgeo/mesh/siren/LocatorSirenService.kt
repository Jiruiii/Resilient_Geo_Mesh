package com.resilientgeo.mesh.siren

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import com.resilientgeo.mesh.MainActivity
import com.resilientgeo.mesh.R

/**
 * Plays the locator tone for 60 s as a mediaPlayback foreground service so it
 * keeps sounding with the screen locked or the app in the background. Started
 * only from a user tap while the app is visible (Android 12+/14+ rules). It
 * never changes the system volume; a muted alarm stream is reported as a
 * failure. Separate from EmergencyModeService on purpose: different FGS type
 * and a different stop condition.
 */
class LocatorSirenService : Service(), AudioManager.OnAudioFocusChangeListener {

    private val handler = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var focusRequest: AudioFocusRequest? = null
    private val audioManager by lazy { getSystemService(AudioManager::class.java) }
    private val autoStop = Runnable { finish(SirenStatus(SirenPhase.AUTO_STOPPED)) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> finish(SirenStatus(SirenPhase.IDLE))
            ACTION_START -> start()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun start() {
        // Promote to foreground first: startForegroundService() requires it within seconds.
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
            )
        } catch (error: Exception) {
            finish(SirenStatus(SirenPhase.FAILED, reason = "foreground_start_blocked"))
            return
        }
        releasePlayer()
        val notificationsAllowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
        val warnings = SirenPreflight.warnings(
            getSystemService(NotificationManager::class.java).currentInterruptionFilter,
            notificationsAllowed,
        )
        SirenPreflight.failure(audioManager.getStreamVolume(AudioManager.STREAM_ALARM))?.let {
            finish(SirenStatus(SirenPhase.FAILED, reason = it, warnings = warnings))
            return
        }
        if (!requestFocus()) {
            finish(SirenStatus(SirenPhase.FAILED, reason = "focus_denied", warnings = warnings))
            return
        }
        try {
            val media = MediaPlayer()
            media.setAudioAttributes(ALARM_ATTRIBUTES)
            resources.openRawResourceFd(R.raw.locator_siren).use { media.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            media.isLooping = true
            media.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK)
            media.setOnErrorListener { _, _, _ ->
                finish(SirenStatus(SirenPhase.FAILED, reason = "playback_error"))
                true
            }
            media.prepare()
            media.start()
            player = media
        } catch (error: Exception) {
            finish(SirenStatus(SirenPhase.FAILED, reason = "audio_init_failed", warnings = warnings))
            return
        }
        handler.removeCallbacks(autoStop)
        handler.postDelayed(autoStop, PLAY_DURATION_MS)
        SirenStatusHolder.update(
            SirenStatus(SirenPhase.PLAYING, endsAtEpochMillis = System.currentTimeMillis() + PLAY_DURATION_MS, warnings = warnings),
        )
    }

    private fun requestFocus(): Boolean {
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(ALARM_ATTRIBUTES)
                .setOnAudioFocusChangeListener(this, handler)
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(this, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    override fun onAudioFocusChange(focusChange: Int) {
        // A call or another app took the audio: stop and say so instead of
        // silently ducking a locator tone someone may be relying on.
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            finish(SirenStatus(SirenPhase.INTERRUPTED, reason = "focus_lost"))
        }
    }

    /** The task being swiped away does not stop the tone; the 60 s limit and the notification still apply. */
    override fun onTaskRemoved(rootIntent: Intent?) = Unit

    private fun finish(status: SirenStatus) {
        handler.removeCallbacks(autoStop)
        releasePlayer()
        abandonFocus()
        SirenStatusHolder.update(status)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releasePlayer() {
        player?.let {
            runCatching { it.stop() }
            it.release()
        }
        player = null
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(this)
        }
        focusRequest = null
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoStop)
        releasePlayer()
        abandonFocus()
        if (SirenStatusHolder.status.value.phase == SirenPhase.PLAYING) SirenStatusHolder.update(SirenStatus(SirenPhase.IDLE))
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "定位警報", NotificationManager.IMPORTANCE_LOW).apply {
                description = "本機定位警報聲播放中"
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(null, null)
            },
        )
        val stop = PendingIntent.getService(
            this, 0, Intent(this, LocatorSirenService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.app_icon_foreground)
            .setContentTitle("定位警報聲播放中")
            .setContentText("只會讓本機發聲，不代表已聯絡 119 或救援單位")
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setContentIntent(open)
            .addAction(0, "停止警報", stop)
            .build()
    }

    companion object {
        const val ACTION_START = "com.resilientgeo.mesh.siren.START"
        const val ACTION_STOP = "com.resilientgeo.mesh.siren.STOP"
        const val PLAY_DURATION_MS = 60_000L
        private const val CHANNEL_ID = "locator-siren"
        private const val NOTIFICATION_ID = 4107
        private val ALARM_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        fun intent(context: Context, action: String): Intent = Intent(context, LocatorSirenService::class.java).setAction(action)
    }
}
