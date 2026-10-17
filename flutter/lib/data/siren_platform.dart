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
