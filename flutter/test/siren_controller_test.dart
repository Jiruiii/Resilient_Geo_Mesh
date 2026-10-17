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
