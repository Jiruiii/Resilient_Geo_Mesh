import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/rescue_flow_controller.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/widgets/rescue_request_sheet.dart';

import 'support/fake_rescue_service.dart';

void main() {
  var now = DateTime.parse('2026-10-12T04:00:00Z');
  late FakeRescueService service;
  late RescueFlowController controller;

  setUp(() {
    now = DateTime.parse('2026-10-12T04:00:00Z');
    service = FakeRescueService();
    controller = RescueFlowController(service: service, clock: () => now);
  });

  tearDown(() => controller.dispose());

  RescueDraft located() => RescueDraft.initial().copyWith(
    location: const GeoPoint(longitude: 121.5, latitude: 25.0),
    locationSource: CrowdReportLocationSource.currentLocation,
  );

  test('restores an ACTIVE request after the app restarts', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    expect(controller.activeSession, isNotNull);
    expect(controller.showsSirenShortcut, isTrue);
  });

  test('ended or expired requests are not treated as in progress', () async {
    service.initialSessions = <RescueSession>[fakeSession(status: 'RESOLVED')];
    await controller.load();
    expect(controller.activeSession, isNull);
    service.initialSessions = <RescueSession>[fakeSession(expiresAt: '2026-10-12T03:59:00Z')];
    await controller.load();
    expect(controller.activeSession, isNull);
  });

  test('submit is single-flight and failures keep the sheet open', () async {
    await controller.load();
    controller
      ..startNew()
      ..updateDraft(located())
      ..showConfirmation();
    service.pendingSubmit = Completer<RescueSession>();
    final first = controller.submit();
    final second = controller.submit();
    expect(service.submitCalls, 1);
    service.pendingSubmit!.complete(fakeSession());
    await Future.wait(<Future<void>>[first, second]);
    expect(controller.step, isNull);
    expect(controller.activeSession, isNotNull);
    expect(controller.consumeNotice(), '求救已建立：未經查證');

    controller
      ..startNew()
      ..updateDraft(located())
      ..showConfirmation();
    service
      ..pendingSubmit = null
      ..submitError = const RescueFailure(code: RescueFailureCode.conflict, message: 'rescue_active_exists');
    await controller.submit();
    expect(controller.step, RescueSheetStep.confirm);
    expect(controller.errorMessage, '此裝置已有進行中的求救，請先更新或結束它');
  });

  test('resolve, cancel and extend go through the service with the right action', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    await controller.extend();
    await controller.resolve();
    expect(service.revisions.map((entry) => entry.$2), <RescueAction>[RescueAction.extend, RescueAction.resolve]);
    expect(controller.activeSession, isNull);
  });

  test('the expiry reminder appears 30 minutes before expiry', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    expect(controller.expiryReminderDue, isFalse);
    now = DateTime.parse('2026-10-12T08:31:00Z');
    expect(controller.expiryReminderDue, isTrue);
  });

  test('after expiry the request can only be re-created as a new one, prefilled', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    now = DateTime.parse('2026-10-12T09:30:00Z');
    expect(controller.activeSession, isNull);
    expect(controller.expiredSession, isNotNull);
    controller.startRecreate();
    expect(controller.editingEventId, isNull);
    expect(controller.draft!.type, RescueRequestType.trappedDebris);
    expect(controller.step, RescueSheetStep.edit);
    now = DateTime.parse('2026-10-13T10:00:00Z');
    expect(controller.expiredSession, isNull);
  });
}
