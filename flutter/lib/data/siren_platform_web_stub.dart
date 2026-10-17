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
