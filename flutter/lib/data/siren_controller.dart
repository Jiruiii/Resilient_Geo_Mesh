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
