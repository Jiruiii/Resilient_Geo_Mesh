# 06 本機定位警報

> 總覽與 Global Constraints：[README.md](README.md)。警報只讓本機發聲，與求救是否送出、簽章、Room、網路完全無關。播放只能由使用者點擊觸發；每次 60 秒自動停止；不調整系統音量；任何無法播放的情況都回報真實原因。

狀態機（Flutter 共用 `SirenController`；Android 與 Web 回報同一組 phase）：

```
idle ──tap──► starting ──ok──► playing ──60s──► autoStopped ──tap 重播──► starting
                 │               │  ├──tap 停止──► stopping ──► idle
                 │               │  └──失去音訊焦點/來電──► interrupted
                 ▼               ▼
              failed(原因)    failed(原因)
autoStopped／interrupted／failed ──關閉提示──► idle
```

wire 值：`IDLE`、`STARTING`、`PLAYING`、`STOPPING`、`AUTO_STOPPED`、`INTERRUPTED`、`FAILED`。原因代碼：`volume_zero`、`focus_denied`、`focus_lost`、`browser_blocked`、`audio_init_failed`、`unsupported`、`foreground_start_blocked`、`playback_error`。警告代碼：`dnd_may_block`、`notifications_denied`、`page_hidden`。

| 檔案 | 責任 |
|---|---|
| `tools/audio/generate-locator-tone.mjs`（新） | 產生固定 WAV |
| `android/app/src/main/res/raw/locator_siren.wav`、`flutter/web/audio/locator_siren.wav`（產生） | 兩端同一份音檔 |
| `android/.../siren/SirenStatus.kt`（新） | phase、狀態訊息、預檢（純 Kotlin，可 JVM 測試） |
| `android/.../siren/LocatorSirenService.kt`（新） | mediaPlayback 前景服務 |
| `android/.../bridge/SirenBridge.kt`（新） | MethodChannel／EventChannel |
| `android/app/src/main/AndroidManifest.xml`、`MainActivity.kt`（改） | 權限、service、bridge、通知權限 |
| `flutter/web/locator_siren.js`（新） | Web Audio 播放 |
| `flutter/lib/data/siren_controller.dart`、`siren_platform*.dart`（新） | 共用控制與平台實作 |
| `flutter/lib/widgets/siren_panel.dart`（新） | 警報按鍵與狀態 UI |

---

### Task 23: 定位警報音檔

**Files:**
- Create: `tools/audio/generate-locator-tone.mjs`
- Create（產生）：`android/app/src/main/res/raw/locator_siren.wav`、`flutter/web/audio/locator_siren.wav`
- Test: `pipeline/test/locator-tone.test.mjs`

**Interfaces:**
- Produces: `export function locatorToneWav(): Buffer`（22050 Hz、mono、16-bit PCM；一輪 3.3 秒：3 × [0.4 秒 3000 Hz 正弦波（前後各 10 ms 淡入淡出）＋ 0.3 秒靜音] 但最後一聲後接 1.5 秒靜音；振幅 0.8 full scale）

一輪時間：`0.4 + 0.3 + 0.4 + 0.3 + 0.4 + 1.5 = 3.3` 秒。

- [ ] **Step 1: 寫失敗的測試**

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { locatorToneWav } from '../../tools/audio/generate-locator-tone.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Android and Web ship the same generated tone', async () => {
  const generated = locatorToneWav();
  const android = await readFile(path.join(ROOT, 'android/app/src/main/res/raw/locator_siren.wav'));
  const web = await readFile(path.join(ROOT, 'flutter/web/audio/locator_siren.wav'));
  assert.equal(sha(android), sha(generated));
  assert.equal(sha(web), sha(generated));
});

test('the tone is three short 3 kHz beeps then a pause, never a sweep', () => {
  const wav = locatorToneWav();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readUInt16LE(34), 16);
  const samples = (wav.length - 44) / 2;
  assert.equal(samples, Math.round(3.3 * 22050));
  const at = (seconds) => wav.readInt16LE(44 + 2 * Math.round(seconds * 22050));
  const peak = (from, to) => {
    let max = 0;
    for (let s = from; s < to; s += 1 / 22050) max = Math.max(max, Math.abs(at(s)));
    return max;
  };
  for (const start of [0, 0.7, 1.4]) assert.ok(peak(start + 0.05, start + 0.35) > 20000, `beep at ${start}`);
  for (const gap of [0.45, 1.15, 1.9, 2.5, 3.2]) assert.equal(Math.abs(at(gap)), 0, `silence at ${gap}`);
  let crossings = 0;
  for (let s = 0.05; s < 0.35; s += 1 / 22050) {
    if (Math.sign(at(s)) !== Math.sign(at(s + 1 / 22050))) crossings += 1;
  }
  const frequency = crossings / 2 / 0.3;
  assert.ok(Math.abs(frequency - 3000) < 60, `${frequency} Hz`);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/locator-tone.test.mjs`
Expected: FAIL，模組不存在

- [ ] **Step 3: 實作產生器**

```js
#!/usr/bin/env node
// Locator tone for the rescue "定位警報聲": three short 3 kHz beeps and a
// pause, like a rescue whistle. Deliberately not a sweeping siren so it is
// never mistaken for police, fire or ambulance vehicles.
//
//   node tools/audio/generate-locator-tone.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;
const FREQUENCY = 3000;
const AMPLITUDE = 0.8;
const FADE_SECONDS = 0.01;
// [seconds, tone?] segments of one 3.3 s cycle.
const PATTERN = [[0.4, true], [0.3, false], [0.4, true], [0.3, false], [0.4, true], [1.5, false]];

export function locatorToneWav() {
  const pcm = [];
  for (const [seconds, tone] of PATTERN) {
    const count = Math.round(seconds * SAMPLE_RATE);
    const fade = Math.round(FADE_SECONDS * SAMPLE_RATE);
    for (let index = 0; index < count; index += 1) {
      if (!tone) {
        pcm.push(0);
        continue;
      }
      const envelope = Math.min(1, index / fade, (count - 1 - index) / fade);
      pcm.push(Math.round(Math.sin((2 * Math.PI * FREQUENCY * index) / SAMPLE_RATE) * envelope * AMPLITUDE * 32767));
    }
  }
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const wav = locatorToneWav();
  for (const target of ['android/app/src/main/res/raw/locator_siren.wav', 'flutter/web/audio/locator_siren.wav']) {
    const file = path.join(root, target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, wav);
    console.log(`wrote ${target} (${wav.length} bytes)`);
  }
}
```

靜音檢查點（0.45、1.15、1.9、2.5、3.2 秒）都落在靜音段；三聲起點 0、0.7、1.4 秒。

- [ ] **Step 4: 產生音檔並確認測試通過**

Run: `node tools/audio/generate-locator-tone.mjs; node --test pipeline/test/locator-tone.test.mjs`
Expected: 印出兩個寫入路徑；測試 PASS

- [ ] **Step 5: Commit**

```bash
git add tools/audio/generate-locator-tone.mjs android/app/src/main/res/raw/locator_siren.wav flutter/web/audio/locator_siren.wav pipeline/test/locator-tone.test.mjs
git commit -m "feat(siren): generate the shared locator tone"
```

---

### Task 24: Android 背景播放服務

**Files:**
- Create: `android/app/src/main/java/com/resilientgeo/mesh/siren/SirenStatus.kt`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/siren/LocatorSirenService.kt`
- Create: `android/app/src/main/java/com/resilientgeo/mesh/bridge/SirenBridge.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/resilientgeo/mesh/MainActivity.kt`
- Test: `android/app/src/test/java/com/resilientgeo/mesh/siren/SirenStatusTest.kt`
- Test: `android/app/src/androidTest/java/com/resilientgeo/mesh/siren/LocatorSirenServiceInstrumentedTest.kt`

**Interfaces:**
- Produces:
  - `enum class SirenPhase { IDLE, STARTING, PLAYING, STOPPING, AUTO_STOPPED, INTERRUPTED, FAILED }`
  - `data class SirenStatus(phase, reason: String? = null, endsAtEpochMillis: Long? = null, warnings: List<String> = emptyList()) { fun toMessage(): Map<String, Any?> }`；message：`{ phase, reason, ends_at_epoch_ms, warnings }`
  - `object SirenStatusHolder { val status: StateFlow<SirenStatus>; fun update(SirenStatus) }`（process 內共用）
  - `object SirenPreflight { const val INTERRUPTION_FILTER_NONE = 3; const val INTERRUPTION_FILTER_ALARMS = 4; fun failure(alarmVolume: Int): String?; fun warnings(interruptionFilter: Int, notificationsAllowed: Boolean): List<String> }`
  - `LocatorSirenService`：`ACTION_START`、`ACTION_STOP`；`const val PLAY_DURATION_MS = 60_000L`
  - MethodChannel `com.resilientgeo.mesh/siren`：`start` → 回目前 status message；`stop`；`status`；`notificationPermission` → `"granted"|"denied"|"not_required"`；`requestNotificationPermission`
  - EventChannel `com.resilientgeo.mesh/siren-events`：每次 status 變更送出 message

- [ ] **Step 1: 寫 JVM 失敗測試**

```kotlin
package com.resilientgeo.mesh.siren

import org.junit.Assert.assertEquals
import org.junit.Test

class SirenStatusTest {
    @Test
    fun `volume zero is a real failure, do not disturb is a warning`() {
        assertEquals("volume_zero", SirenPreflight.failure(alarmVolume = 0))
        assertEquals(null, SirenPreflight.failure(alarmVolume = 3))
        assertEquals(listOf("dnd_may_block"), SirenPreflight.warnings(SirenPreflight.INTERRUPTION_FILTER_NONE, notificationsAllowed = true))
        assertEquals(listOf("dnd_may_block"), SirenPreflight.warnings(SirenPreflight.INTERRUPTION_FILTER_ALARMS, notificationsAllowed = true))
        assertEquals(emptyList<String>(), SirenPreflight.warnings(1, notificationsAllowed = true))
        assertEquals(listOf("notifications_denied"), SirenPreflight.warnings(1, notificationsAllowed = false))
    }

    @Test
    fun `status messages use the shared wire values`() {
        assertEquals(
            mapOf("phase" to "AUTO_STOPPED", "reason" to null, "ends_at_epoch_ms" to null, "warnings" to emptyList<String>()),
            SirenStatus(SirenPhase.AUTO_STOPPED).toMessage(),
        )
        assertEquals("FAILED", SirenStatus(SirenPhase.FAILED, reason = "focus_denied").toMessage()["phase"])
    }
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.resilientgeo.mesh.siren.SirenStatusTest"`
Expected: 編譯失敗

- [ ] **Step 3: 實作 `SirenStatus.kt`**

```kotlin
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
```

`NotificationManager.INTERRUPTION_FILTER_NONE` 為 3、`INTERRUPTION_FILTER_ALARMS` 為 4；常數寫在這裡是為了讓 JVM 測試不依賴 Android framework。service 內以 `NotificationManager.INTERRUPTION_FILTER_*` 傳值，兩者相同。

- [ ] **Step 4: 實作 `LocatorSirenService.kt`**

```kotlin
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
```

`R.drawable.app_icon_foreground` 是既有 drawable；若通知小圖示需要單色，改用一個新的 vector `ic_stat_siren.xml`（白色喇叭形狀）並在本任務一併加入。

- [ ] **Step 5: 實作 `SirenBridge.kt`**

```kotlin
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
```

- [ ] **Step 6: Manifest 與 MainActivity**

`AndroidManifest.xml` 權限區加入：

```xml
    <!-- Locator siren: user-started alarm tone that keeps playing with the
         screen locked (LocatorSirenService, foregroundServiceType mediaPlayback). -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
```

`<application>` 內 `EmergencyModeService` 之後加入：

```xml
        <service
            android:name=".siren.LocatorSirenService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
```

`MainActivity.kt`：

```kotlin
    private var sirenBridge: SirenBridge? = null
    // configureFlutterEngine() 內，offlineMapAssetBridge 之後：
        sirenBridge?.close()
        sirenBridge = SirenBridge(
            applicationContext,
            flutterEngine.dartExecutor.binaryMessenger,
            requestNotificationPermission = ::requestNotificationPermissionIfNeeded,
        )
    // onDestroy() 內：
        sirenBridge?.close()
        sirenBridge = null
```

`requestNotificationPermissionIfNeeded` 已存在且為 private，同 class 內可直接傳參考。

- [ ] **Step 7: 儀器測試**

`android/app/src/androidTest/java/com/resilientgeo/mesh/siren/LocatorSirenServiceInstrumentedTest.kt`：

```kotlin
package com.resilientgeo.mesh.siren

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Starts and stops the real service. Whether sound is audible is a manual
 * check; this only proves the phases are reported truthfully and nothing is
 * left playing after stop. It never changes the device volume.
 */
@RunWith(AndroidJUnit4::class)
class LocatorSirenServiceInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun waitFor(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(50)
    }

    @Test
    fun startReportsPlayingOrARealFailureAndStopLeavesNothingPlaying() {
        ContextCompat.startForegroundService(context, LocatorSirenService.intent(context, LocatorSirenService.ACTION_START))
        waitFor(3_000) { SirenStatusHolder.status.value.phase in setOf(SirenPhase.PLAYING, SirenPhase.FAILED) }
        val started = SirenStatusHolder.status.value
        assertTrue("unexpected $started", started.phase == SirenPhase.PLAYING || started.reason != null)
        context.startService(LocatorSirenService.intent(context, LocatorSirenService.ACTION_STOP))
        waitFor(3_000) { SirenStatusHolder.status.value.phase !in setOf(SirenPhase.PLAYING, SirenPhase.STARTING) }
        assertEquals(if (started.phase == SirenPhase.PLAYING) SirenPhase.IDLE else SirenPhase.FAILED, SirenStatusHolder.status.value.phase)
    }
}
```

（自 instrumentation 啟動前景服務在 Android 14+ 可能被限制；若遇 `ForegroundServiceStartNotAllowedException`，此測試記為「需在 App 前景手動驗證」，並在交付清單列出。）

- [ ] **Step 8: 執行測試與 build**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.resilientgeo.mesh.siren.*"; .\gradlew.bat assembleDebug`
Expected: PASS；build 成功
Run（有裝置時）: `cd android; .\gradlew.bat connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.resilientgeo.mesh.siren.LocatorSirenServiceInstrumentedTest"`

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main/java/com/resilientgeo/mesh/siren android/app/src/main/java/com/resilientgeo/mesh/bridge/SirenBridge.kt android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/resilientgeo/mesh/MainActivity.kt android/app/src/test/java/com/resilientgeo/mesh/siren android/app/src/androidTest/java/com/resilientgeo/mesh/siren
git commit -m "feat(android): locator siren as a mediaPlayback foreground service"
```

---

### Task 25: Web 播放

**Files:**
- Create: `flutter/web/locator_siren.js`
- Modify: `flutter/web/index.html`（在 `rescue_outbox.js` 之後載入）
- Test: `pipeline/test/locator-siren-web.test.mjs`

**Interfaces:**
- Produces（全域函式；與 rescue 一樣回傳 JSON 信封字串、永不 reject）：
  - `locatorSirenStart()`：**必須在使用者點擊的同步呼叫堆疊中被呼叫**；內部在第一個 `await` 之前就呼叫 `AudioContext.resume()`；回傳 `Promise<string>`，`value` 為 status
  - `locatorSirenStop()`、`locatorSirenStatus()`：回傳 `Promise<string>`
  - `locatorSirenSetListener(callback)`：每次狀態變更以 status JSON 字串呼叫 `callback`
  - status：`{ phase, reason, ends_at_epoch_ms, warnings }`（同 Android）

- [ ] **Step 1: 寫失敗的測試**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = await readFile(path.join(ROOT, 'flutter/web/locator_siren.js'), 'utf8').catch(() => '');

function fakeAudio({ resumeState = 'running', decodeFails = false } = {}) {
  const log = [];
  class FakeContext {
    constructor() { this.state = 'suspended'; this.destination = {}; log.push('new'); }
    resume() { log.push('resume'); this.state = resumeState; return Promise.resolve(); }
    decodeAudioData() { return decodeFails ? Promise.reject(new Error('bad')) : Promise.resolve({ duration: 3.3 }); }
    createBufferSource() {
      const source = { loop: false, connect() {}, disconnect() {}, start() { log.push('start'); }, stop() { log.push('stop'); } };
      return source;
    }
  }
  return { FakeContext, log };
}

function browser({ AudioContext, timers = [], hidden = false } = {}) {
  const listeners = {};
  const context = vm.createContext({
    AudioContext,
    console,
    URL,
    location: { href: 'https://map.example.test/' },
    document: { baseURI: 'https://map.example.test/', hidden, addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    Date,
    globalThis: undefined,
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(script, context);
  return { context, listeners };
}

const call = async (context, name) => {
  const envelope = JSON.parse(await context[name]());
  assert.equal(envelope.ok, true, envelope.error);
  return envelope.value;
};

test('plays after a user gesture, stops, and auto-stops after 60 seconds', async () => {
  const { FakeContext, log } = fakeAudio();
  const timers = [];
  const { context } = browser({ AudioContext: FakeContext, timers });
  const statuses = [];
  context.locatorSirenSetListener((status) => statuses.push(JSON.parse(status).phase));
  const started = await call(context, 'locatorSirenStart');
  assert.equal(started.phase, 'PLAYING');
  assert.deepEqual(log.slice(0, 2), ['new', 'resume']);
  assert.ok(log.includes('start'));
  assert.equal(timers.at(-1).ms, 60_000);
  timers.at(-1).fn();
  assert.equal((await call(context, 'locatorSirenStatus')).phase, 'AUTO_STOPPED');
  assert.deepEqual(statuses, ['STARTING', 'PLAYING', 'AUTO_STOPPED']);
  await call(context, 'locatorSirenStart');
  assert.equal((await call(context, 'locatorSirenStop')).phase, 'IDLE');
});

test('a browser that refuses audio reports failure, never playing', async () => {
  const { FakeContext } = fakeAudio({ resumeState: 'suspended' });
  const { context } = browser({ AudioContext: FakeContext });
  const status = await call(context, 'locatorSirenStart');
  assert.equal(status.phase, 'FAILED');
  assert.equal(status.reason, 'browser_blocked');
});

test('decode errors and missing Web Audio are explicit failures', async () => {
  const broken = fakeAudio({ decodeFails: true });
  assert.equal((await call(browser({ AudioContext: broken.FakeContext }).context, 'locatorSirenStart')).reason, 'audio_init_failed');
  assert.equal((await call(browser({ AudioContext: undefined }).context, 'locatorSirenStart')).reason, 'unsupported');
});

test('a hidden page is flagged while playing, not silently trusted', async () => {
  const { FakeContext } = fakeAudio();
  const { context, listeners } = browser({ AudioContext: FakeContext });
  await call(context, 'locatorSirenStart');
  context.document.hidden = true;
  listeners.visibilitychange();
  assert.deepEqual((await call(context, 'locatorSirenStatus')).warnings, ['page_hidden']);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/locator-siren-web.test.mjs`
Expected: FAIL

- [ ] **Step 3: 實作 `flutter/web/locator_siren.js`**

```js
(function installLocatorSiren(global) {
  // Web half of the locator siren. Browsers only allow audio after a user
  // gesture, so locatorSirenStart() must be called from the tap handler and
  // resumes the AudioContext before its first await. Background tabs and a
  // locked screen may still be throttled; the UI says so and this script
  // flags a hidden page instead of claiming the tone is still audible.
  const PLAY_DURATION_MS = 60 * 1000;
  let audioContext = null;
  let buffer = null;
  let source = null;
  let timer = null;
  let listener = null;
  let status = { phase: 'IDLE', reason: null, ends_at_epoch_ms: null, warnings: [] };

  function emit(next) {
    status = { phase: next.phase, reason: next.reason ?? null, ends_at_epoch_ms: next.ends_at_epoch_ms ?? null, warnings: next.warnings ?? [] };
    if (listener) listener(JSON.stringify(status));
    return status;
  }

  function release() {
    if (timer !== null) global.clearTimeout(timer);
    timer = null;
    if (source) {
      try { source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* not connected */ }
    }
    source = null;
  }

  async function loadBuffer() {
    if (buffer) return buffer;
    const url = new URL('audio/locator_siren.wav', global.document?.baseURI ?? global.location.href);
    const response = await global.fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('audio_init_failed');
    buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    return buffer;
  }

  function start() {
    if (status.phase === 'PLAYING' || status.phase === 'STARTING') return Promise.resolve(status);
    const AudioContextClass = global.AudioContext ?? global.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve(emit({ phase: 'FAILED', reason: 'unsupported' }));
    emit({ phase: 'STARTING' });
    let resumed;
    try {
      audioContext ??= new AudioContextClass();
      resumed = audioContext.resume(); // still inside the user's tap
    } catch {
      return Promise.resolve(emit({ phase: 'FAILED', reason: 'audio_init_failed' }));
    }
    return (async () => {
      try {
        await resumed;
        if (audioContext.state !== 'running') return emit({ phase: 'FAILED', reason: 'browser_blocked' });
        const tone = await loadBuffer();
        release();
        source = audioContext.createBufferSource();
        source.buffer = tone;
        source.loop = true;
        source.connect(audioContext.destination);
        source.start();
        timer = global.setTimeout(() => {
          release();
          emit({ phase: 'AUTO_STOPPED' });
        }, PLAY_DURATION_MS);
        return emit({ phase: 'PLAYING', ends_at_epoch_ms: Date.now() + PLAY_DURATION_MS, warnings: global.document?.hidden ? ['page_hidden'] : [] });
      } catch (error) {
        release();
        const reason = error?.message === 'browser_blocked' ? 'browser_blocked' : 'audio_init_failed';
        return emit({ phase: 'FAILED', reason });
      }
    })();
  }

  function stop() {
    release();
    return emit({ phase: 'IDLE' });
  }

  global.document?.addEventListener?.('visibilitychange', () => {
    if (status.phase !== 'PLAYING') return;
    const warnings = global.document.hidden ? ['page_hidden'] : [];
    emit({ ...status, warnings });
  });

  const exported = (run) => async (...args) => {
    try {
      return JSON.stringify({ ok: true, value: await run(...args) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
    }
  };

  // Not async: start() must reach AudioContext.resume() synchronously.
  global.locatorSirenStart = (...args) => exported(start)(...args);
  global.locatorSirenStop = exported(stop);
  global.locatorSirenStatus = exported(() => status);
  global.locatorSirenSetListener = (callback) => { listener = typeof callback === 'function' ? callback : null; };
})(globalThis);
```

（`exported(start)` 回傳的 async 函式在第一個 `await` 前同步執行 `start()`，因此 `resume()` 仍在手勢堆疊內。）

`index.html` 加入 `<script src="locator_siren.js"></script>`（在 `rescue_outbox.js` 之後）。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test pipeline/test/locator-siren-web.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add flutter/web/locator_siren.js flutter/web/index.html pipeline/test/locator-siren-web.test.mjs
git commit -m "feat(web): locator siren with Web Audio and honest failure states"
```

---

### Task 26: Flutter 警報控制、面板與整合

**Files:**
- Create: `flutter/lib/data/siren_controller.dart`
- Create: `flutter/lib/data/siren_platform.dart`、`siren_platform_web_stub.dart`、`siren_platform_web.dart`
- Create: `flutter/lib/widgets/siren_panel.dart`
- Modify: `flutter/lib/screens/map_screen.dart`（`_openSirenOnly`）
- Modify: `flutter/lib/main.dart`
- Test: `flutter/test/siren_controller_test.dart`
- Test: `flutter/test/siren_panel_test.dart`

**Interfaces:**
- Consumes: Task 24 的 channel、Task 25 的 JS 函式、05 Task 22 的 `sirenPanelBuilder`
- Produces:
  - `enum SirenPhase { idle, starting, playing, stopping, autoStopped, interrupted, failed }`
  - `final class SirenStatus { phase, reason, endsAt, warnings }`；`factory SirenStatus.fromMessage(Map)`
  - `abstract class SirenPlatform { bool get isWeb; Stream<SirenStatus> get statuses; Future<SirenStatus> start(); Future<SirenStatus> stop(); Future<SirenStatus> current(); Future<String> notificationPermission(); Future<void> requestNotificationPermission(); static SirenPlatform forPlatform({bool? isWeb}); }`
  - `AndroidSirenPlatform`、`WebSirenPlatform`
  - `class SirenController extends ChangeNotifier { SirenController(SirenPlatform); SirenStatus status; String? notificationPermission; void start(); Future<void> stop(); void dismiss(); Future<void> ensureNotificationPermissionRequested(); String? reasonText(); List<String> warningTexts(); }`
  - `class SirenPanel extends StatelessWidget { SirenPanel({required SirenController controller, DateTime Function()? clock}) }`；keys：`siren-start`、`siren-stop`、`siren-replay`、`siren-dismiss`

文案：

| 代碼 | 文字 |
|---|---|
| `volume_zero` | 鬧鐘音量為 0，請調高音量後再試 |
| `focus_denied` | 其他程式正在使用音訊，無法播放 |
| `focus_lost` | 來電或其他音訊中斷了警報聲 |
| `browser_blocked` | 瀏覽器拒絕播放聲音，請再點一次或檢查網站音效設定 |
| `audio_init_failed` | 音訊初始化失敗，無法播放 |
| `unsupported` | 此環境不支援播放警報聲 |
| `foreground_start_blocked` | 系統不允許啟動警報，請回到 App 畫面後再試 |
| `playback_error` | 播放時發生錯誤 |
| 警告 `dnd_may_block` | 勿擾模式可能讓警報聲無法播放 |
| 警告 `notifications_denied` | 未允許通知：鎖屏時只能回到 App 內停止 |
| 警告 `page_hidden` | 頁面在背景，瀏覽器可能已暫停聲音 |
| 固定 | 此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。 |
| Web 固定 | 瀏覽器在背景分頁或鎖屏時不保證持續播放；無法偵測系統音量，請確認裝置未靜音。 |

- [ ] **Step 1: 寫失敗的測試**

`flutter/test/support/fake_siren_platform.dart`：

```dart
import 'dart:async';

import 'package:resilientgeo_flutter/data/siren_controller.dart';

class FakeSirenPlatform implements SirenPlatform {
  FakeSirenPlatform({this.isWeb = false, this.startResult});

  @override
  final bool isWeb;
  SirenStatus? startResult;
  final controller = StreamController<SirenStatus>.broadcast();
  int starts = 0;
  int stops = 0;
  int permissionRequests = 0;
  String permission = 'denied';

  @override
  Stream<SirenStatus> get statuses => controller.stream;

  @override
  Future<SirenStatus> start() async {
    starts += 1;
    return startResult ?? const SirenStatus(phase: SirenPhase.playing);
  }

  @override
  Future<SirenStatus> stop() async {
    stops += 1;
    return const SirenStatus(phase: SirenPhase.idle);
  }

  @override
  Future<SirenStatus> current() async => const SirenStatus(phase: SirenPhase.idle);

  @override
  Future<String> notificationPermission() async => permission;

  @override
  Future<void> requestNotificationPermission() async => permissionRequests += 1;
}
```

`flutter/test/siren_controller_test.dart`：

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/siren_controller.dart';

import 'support/fake_siren_platform.dart';

void main() {
  test('start goes through starting and reports what the platform says', () async {
    final platform = FakeSirenPlatform();
    final controller = SirenController(platform);
    controller.start();
    expect(controller.status.phase, SirenPhase.starting);
    await Future<void>.delayed(Duration.zero);
    expect(controller.status.phase, SirenPhase.playing);
    platform.controller.add(const SirenStatus(phase: SirenPhase.autoStopped));
    await Future<void>.delayed(Duration.zero);
    expect(controller.status.phase, SirenPhase.autoStopped);
    controller.dispose();
  });

  test('failures are explained, never shown as playing', () async {
    final controller = SirenController(FakeSirenPlatform(startResult: const SirenStatus(phase: SirenPhase.failed, reason: 'volume_zero')));
    controller.start();
    await Future<void>.delayed(Duration.zero);
    expect(controller.status.phase, SirenPhase.failed);
    expect(controller.reasonText(), '鬧鐘音量為 0，請調高音量後再試');
    controller.dispose();
  });

  test('a second tap while starting does not start twice', () async {
    final platform = FakeSirenPlatform();
    final controller = SirenController(platform);
    controller
      ..start()
      ..start();
    await Future<void>.delayed(Duration.zero);
    expect(platform.starts, 1);
    controller.dispose();
  });

  test('notification permission is asked once per app run on Android only', () async {
    final android = FakeSirenPlatform();
    final controller = SirenController(android);
    await controller.ensureNotificationPermissionRequested();
    await controller.ensureNotificationPermissionRequested();
    expect(android.permissionRequests, 1);
    final web = FakeSirenPlatform(isWeb: true);
    final webController = SirenController(web);
    await webController.ensureNotificationPermissionRequested();
    expect(web.permissionRequests, 0);
    controller.dispose();
    webController.dispose();
  });
}
```

`flutter/test/siren_panel_test.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/siren_controller.dart';
import 'package:resilientgeo_flutter/widgets/siren_panel.dart';

import 'support/fake_siren_platform.dart';

void main() {
  testWidgets('idle shows the explicit start button and the 119 disclaimer', (tester) async {
    final controller = SirenController(FakeSirenPlatform());
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    expect(find.byKey(const ValueKey<String>('siren-start')), findsOneWidget);
    expect(find.text('發出定位警報聲'), findsOneWidget);
    expect(find.text('此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('playing shows a full-width stop button', (tester) async {
    final platform = FakeSirenPlatform();
    final controller = SirenController(platform);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    await tester.tap(find.byKey(const ValueKey<String>('siren-start')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('siren-stop')), findsOneWidget);
    expect(find.text('停止警報'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('siren-stop')));
    await tester.pump();
    expect(platform.stops, 1);
    controller.dispose();
  });

  testWidgets('the web build states its background limitation', (tester) async {
    final controller = SirenController(FakeSirenPlatform(isWeb: true));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    expect(find.text('瀏覽器在背景分頁或鎖屏時不保證持續播放；無法偵測系統音量，請確認裝置未靜音。'), findsOneWidget);
    controller.dispose();
  });
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/siren_controller_test.dart test/siren_panel_test.dart`
Expected: 編譯失敗

- [ ] **Step 3: 實作 `siren_controller.dart`**

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'siren_platform.dart';

export 'siren_platform.dart';

const _reasonTexts = <String, String>{
  'volume_zero': '鬧鐘音量為 0，請調高音量後再試',
  'focus_denied': '其他程式正在使用音訊，無法播放',
  'focus_lost': '來電或其他音訊中斷了警報聲',
  'browser_blocked': '瀏覽器拒絕播放聲音，請再點一次或檢查網站音效設定',
  'audio_init_failed': '音訊初始化失敗，無法播放',
  'unsupported': '此環境不支援播放警報聲',
  'foreground_start_blocked': '系統不允許啟動警報，請回到 App 畫面後再試',
  'playback_error': '播放時發生錯誤',
};

const _warningTexts = <String, String>{
  'dnd_may_block': '勿擾模式可能讓警報聲無法播放',
  'notifications_denied': '未允許通知：鎖屏時只能回到 App 內停止',
  'page_hidden': '頁面在背景，瀏覽器可能已暫停聲音',
};

/// Shared siren state for Android and Web. It only reflects what the
/// platform reports: it never assumes a tone is playing.
class SirenController extends ChangeNotifier {
  SirenController(this._platform) {
    _subscription = _platform.statuses.listen((next) {
      status = next;
      _notify();
    });
    unawaited(_platform.current().then((value) {
      status = value;
      _notify();
    }).catchError((Object _) {}));
  }

  final SirenPlatform _platform;
  late final StreamSubscription<SirenStatus> _subscription;
  bool _disposed = false;
  bool _permissionAsked = false;
  SirenStatus status = const SirenStatus(phase: SirenPhase.idle);
  String? notificationPermission;

  bool get isWeb => _platform.isWeb;

  /// Must be called directly from the tap handler: on the web the browser
  /// only allows audio inside the user's gesture.
  void start() {
    if (status.phase == SirenPhase.starting || status.phase == SirenPhase.playing) return;
    status = const SirenStatus(phase: SirenPhase.starting);
    _notify();
    unawaited(_platform.start().then((next) {
      status = next;
      _notify();
    }).catchError((Object _) {
      status = const SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');
      _notify();
    }));
  }

  Future<void> stop() async {
    status = const SirenStatus(phase: SirenPhase.stopping);
    _notify();
    try {
      status = await _platform.stop();
    } on Object {
      status = const SirenStatus(phase: SirenPhase.idle);
    }
    _notify();
  }

  void dismiss() {
    if (status.phase == SirenPhase.playing || status.phase == SirenPhase.starting) return;
    status = const SirenStatus(phase: SirenPhase.idle);
    _notify();
  }

  Future<void> ensureNotificationPermissionRequested() async {
    if (isWeb || _permissionAsked) return;
    _permissionAsked = true;
    try {
      notificationPermission = await _platform.notificationPermission();
      if (notificationPermission == 'denied') {
        await _platform.requestNotificationPermission();
        notificationPermission = await _platform.notificationPermission();
      }
    } on Object {
      notificationPermission = null;
    }
    _notify();
  }

  String? reasonText() => status.reason == null ? null : (_reasonTexts[status.reason] ?? '無法播放警報聲');

  List<String> warningTexts() => <String>[
    for (final warning in status.warnings) _warningTexts[warning] ?? warning,
    if (!isWeb && notificationPermission == 'denied' && !status.warnings.contains('notifications_denied'))
      _warningTexts['notifications_denied']!,
  ];

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Detaches from the platform only. On Android a playing tone keeps its own
  /// 60 s limit and notification stop action even if this UI goes away.
  @override
  void dispose() {
    _disposed = true;
    unawaited(_subscription.cancel());
    super.dispose();
  }
}
```

- [ ] **Step 4: 實作平台層**

`flutter/lib/data/siren_platform.dart`：

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'siren_platform_web_stub.dart'
    if (dart.library.js_interop) 'siren_platform_web.dart'
    as web;

enum SirenPhase { idle, starting, playing, stopping, autoStopped, interrupted, failed }

final class SirenStatus {
  const SirenStatus({required this.phase, this.reason, this.endsAt, this.warnings = const <String>[]});

  factory SirenStatus.fromMessage(Object? message) {
    if (message is! Map) return const SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');
    final phase = switch (message['phase']) {
      'IDLE' => SirenPhase.idle,
      'STARTING' => SirenPhase.starting,
      'PLAYING' => SirenPhase.playing,
      'STOPPING' => SirenPhase.stopping,
      'AUTO_STOPPED' => SirenPhase.autoStopped,
      'INTERRUPTED' => SirenPhase.interrupted,
      _ => SirenPhase.failed,
    };
    final ends = message['ends_at_epoch_ms'];
    final warnings = message['warnings'];
    return SirenStatus(
      phase: phase,
      reason: message['reason'] is String ? message['reason'] as String : (phase == SirenPhase.failed ? 'unsupported' : null),
      endsAt: ends is num ? DateTime.fromMillisecondsSinceEpoch(ends.toInt()) : null,
      warnings: warnings is List ? warnings.whereType<String>().toList(growable: false) : const <String>[],
    );
  }

  final SirenPhase phase;
  final String? reason;
  final DateTime? endsAt;
  final List<String> warnings;
}

abstract class SirenPlatform {
  bool get isWeb;
  Stream<SirenStatus> get statuses;
  Future<SirenStatus> start();
  Future<SirenStatus> stop();
  Future<SirenStatus> current();
  Future<String> notificationPermission();
  Future<void> requestNotificationPermission();

  static SirenPlatform forPlatform({bool? isWeb}) =>
      (isWeb ?? kIsWeb) ? web.createWebSirenPlatform() : AndroidSirenPlatform();
}

final class AndroidSirenPlatform implements SirenPlatform {
  AndroidSirenPlatform({MethodChannel? methodChannel, EventChannel? eventChannel})
    : _methods = methodChannel ?? const MethodChannel('com.resilientgeo.mesh/siren'),
      _events = eventChannel ?? const EventChannel('com.resilientgeo.mesh/siren-events');

  final MethodChannel _methods;
  final EventChannel _events;

  @override
  bool get isWeb => false;

  @override
  Stream<SirenStatus> get statuses => _events.receiveBroadcastStream().map(SirenStatus.fromMessage);

  Future<SirenStatus> _call(String method) async {
    try {
      return SirenStatus.fromMessage(await _methods.invokeMethod<Object?>(method));
    } on MissingPluginException {
      return const SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');
    } on PlatformException {
      return const SirenStatus(phase: SirenPhase.failed, reason: 'audio_init_failed');
    }
  }

  @override
  Future<SirenStatus> start() => _call('start');

  @override
  Future<SirenStatus> stop() => _call('stop');

  @override
  Future<SirenStatus> current() => _call('status');

  @override
  Future<String> notificationPermission() async {
    try {
      return await _methods.invokeMethod<String>('notificationPermission') ?? 'not_required';
    } on MissingPluginException {
      return 'not_required';
    }
  }

  @override
  Future<void> requestNotificationPermission() async {
    try {
      await _methods.invokeMethod<void>('requestNotificationPermission');
    } on MissingPluginException {
      // Nothing to request on this host.
    }
  }
}
```

`flutter/lib/data/siren_platform_web_stub.dart`：

```dart
import 'siren_platform.dart';

/// Non-web hosts never take the web branch; this keeps the import resolvable.
SirenPlatform createWebSirenPlatform() => _UnsupportedSirenPlatform();

final class _UnsupportedSirenPlatform implements SirenPlatform {
  static const _failed = SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');

  @override
  bool get isWeb => true;

  @override
  Stream<SirenStatus> get statuses => const Stream<SirenStatus>.empty();

  @override
  Future<SirenStatus> start() async => _failed;

  @override
  Future<SirenStatus> stop() async => const SirenStatus(phase: SirenPhase.idle);

  @override
  Future<SirenStatus> current() async => const SirenStatus(phase: SirenPhase.idle);

  @override
  Future<String> notificationPermission() async => 'not_required';

  @override
  Future<void> requestNotificationPermission() async {}
}
```

`flutter/lib/data/siren_platform_web.dart`：

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'siren_platform.dart';

@JS('locatorSirenStart')
external JSPromise<JSString> _start();

@JS('locatorSirenStop')
external JSPromise<JSString> _stop();

@JS('locatorSirenStatus')
external JSPromise<JSString> _status();

@JS('locatorSirenSetListener')
external void _setListener(JSFunction callback);

SirenPlatform createWebSirenPlatform() => _WebSirenPlatform();

final class _WebSirenPlatform implements SirenPlatform {
  _WebSirenPlatform() {
    try {
      _setListener(((JSString message) {
        _statuses.add(SirenStatus.fromMessage(jsonDecode(message.toDart)));
      }).toJS);
    } on Object {
      _available = false;
    }
  }

  final _statuses = StreamController<SirenStatus>.broadcast();
  bool _available = true;

  @override
  bool get isWeb => true;

  @override
  Stream<SirenStatus> get statuses => _statuses.stream;

  /// Calls straight into JS without awaiting first, so the browser still sees
  /// the user's tap when AudioContext.resume() runs.
  Future<SirenStatus> _call(JSPromise<JSString> Function() run) async {
    if (!_available) return const SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');
    final JSPromise<JSString> promise;
    try {
      promise = run();
    } on Object {
      return const SirenStatus(phase: SirenPhase.failed, reason: 'unsupported');
    }
    final envelope = jsonDecode((await promise.toDart).toDart);
    if (envelope is! Map || envelope['ok'] != true) {
      return const SirenStatus(phase: SirenPhase.failed, reason: 'audio_init_failed');
    }
    return SirenStatus.fromMessage(envelope['value']);
  }

  @override
  Future<SirenStatus> start() => _call(_start);

  @override
  Future<SirenStatus> stop() => _call(_stop);

  @override
  Future<SirenStatus> current() => _call(_status);

  @override
  Future<String> notificationPermission() async => 'not_required';

  @override
  Future<void> requestNotificationPermission() async {}
}
```

- [ ] **Step 5: 實作 `siren_panel.dart`**

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../data/siren_controller.dart';
import 'map_layers.dart';

const sirenDisclaimer = '此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。';
const sirenWebLimitation = '瀏覽器在背景分頁或鎖屏時不保證持續播放；無法偵測系統音量，請確認裝置未靜音。';

class SirenPanel extends StatefulWidget {
  const SirenPanel({super.key, required this.controller, this.clock});

  final SirenController controller;
  final DateTime Function()? clock;

  @override
  State<SirenPanel> createState() => _SirenPanelState();
}

class _SirenPanelState extends State<SirenPanel> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    unawaited(widget.controller.ensureNotificationPermissionRequested());
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.controller.status.phase == SirenPhase.playing) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final status = controller.status;
    final theme = Theme.of(context);
    final error = theme.colorScheme.error;
    final playing = status.phase == SirenPhase.playing || status.phase == SirenPhase.starting;
    final remaining = status.endsAt == null
        ? null
        : status.endsAt!.difference(widget.clock?.call() ?? DateTime.now()).inSeconds.clamp(0, 60);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (playing)
          SizedBox(
            height: 64,
            child: FilledButton.icon(
              key: const ValueKey<String>('siren-stop'),
              style: FilledButton.styleFrom(backgroundColor: error, textStyle: theme.textTheme.titleLarge),
              onPressed: status.phase == SirenPhase.playing ? controller.stop : null,
              icon: const Icon(Icons.stop_circle_outlined, size: 32),
              label: Text(status.phase == SirenPhase.starting ? '啟動中…' : '停止警報'),
            ),
          )
        else
          SizedBox(
            height: 64,
            child: FilledButton.icon(
              key: ValueKey<String>(status.phase == SirenPhase.idle ? 'siren-start' : 'siren-replay'),
              style: FilledButton.styleFrom(textStyle: theme.textTheme.titleLarge),
              onPressed: controller.start,
              icon: const Icon(MapIconCatalog.locatorSound, size: 30),
              label: Text(status.phase == SirenPhase.idle ? '發出定位警報聲' : '再次播放'),
            ),
          ),
        const SizedBox(height: 6),
        if (status.phase == SirenPhase.playing && remaining != null) Text('播放中，$remaining 秒後自動停止'),
        if (status.phase == SirenPhase.autoStopped) const Text('已播放 60 秒並自動停止'),
        if (controller.reasonText() != null)
          Text(controller.reasonText()!, style: TextStyle(color: error, fontWeight: FontWeight.w600)),
        for (final warning in controller.warningTexts()) Text(warning, style: TextStyle(color: error)),
        const Text(sirenDisclaimer, style: TextStyle(fontWeight: FontWeight.w600)),
        if (controller.isWeb) Text(sirenWebLimitation, style: theme.textTheme.bodySmall),
        if (status.phase == SirenPhase.failed || status.phase == SirenPhase.interrupted || status.phase == SirenPhase.autoStopped)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(key: const ValueKey<String>('siren-dismiss'), onPressed: controller.dismiss, child: const Text('關閉提示')),
          ),
      ],
    );
  }
}
```

- [ ] **Step 5b: 整合**

`main.dart` 的 `_ResilientGeoAppState`：

```dart
  late final SirenController _siren;

  @override
  void initState() {
    super.initState();
    _controller = MapAppController()..load();
    _siren = SirenController(SirenPlatform.forPlatform());
  }

  @override
  void dispose() {
    _siren.dispose();
    _controller.dispose();
    super.dispose();
  }
```

`_MapAppHome` 改為接收 `siren`，`MapScreen(...)` 加入：

```dart
                  sirenPanelBuilder: (context, _) => SirenPanel(controller: siren),
```

`map_screen.dart` 的 `_openSirenOnly`（取代 05 Task 22 的暫時版本）：

```dart
  void _openSirenOnly() {
    final builder = widget.sirenPanelBuilder;
    if (builder == null) {
      _showMessage('此環境不支援播放警報聲');
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: PointerInterceptor(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: builder(context, _rescue),
          ),
        ),
      ),
    );
  }
```

確認 `grep -n "定位警報聲尚未啟用" flutter/lib` 沒有任何結果。

- [ ] **Step 6: 執行測試確認通過**

Run: `cd flutter; flutter test test/siren_controller_test.dart test/siren_panel_test.dart test/rescue_flow_test.dart; flutter analyze`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add flutter/lib/data/siren_controller.dart flutter/lib/data/siren_platform.dart flutter/lib/data/siren_platform_web_stub.dart flutter/lib/data/siren_platform_web.dart flutter/lib/widgets/siren_panel.dart flutter/lib/screens/map_screen.dart flutter/lib/main.dart flutter/test/support/fake_siren_platform.dart flutter/test/siren_controller_test.dart flutter/test/siren_panel_test.dart
git commit -m "feat(flutter): locator siren control shared by Android and Web"
```
