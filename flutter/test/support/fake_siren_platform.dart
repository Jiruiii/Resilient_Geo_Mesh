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
