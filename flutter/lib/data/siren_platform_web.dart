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
