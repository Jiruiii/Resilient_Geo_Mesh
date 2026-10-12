import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/location_controller.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';

import 'support/fake_rescue_service.dart';

void main() {
  testWidgets('submits a TRAPPED_DEBRIS request and shows the active card', (tester) async {
    final service = FakeRescueService();
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);

    await tester.tap(find.bySemanticsLabel('需要救援'));
    await tester.pump();
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    await tester.ensureVisible(find.text('使用目前位置'));
    await tester.tap(find.text('使用目前位置'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-confirm')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-confirm')));
    await tester.pump();
    expect(find.text('送出後為未經查證的求救，不代表已派遣救援'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();

    expect(service.submitCalls, 1);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsOneWidget);
    expect(find.text('求救已建立：未經查證'), findsOneWidget);
  });

  testWidgets('a failed submit keeps the form and never shows the card', (tester) async {
    final service = FakeRescueService()
      ..submitError = const RescueFailure(code: RescueFailureCode.signingUnavailable, message: 'x');
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    await _openAndConfirm(tester);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();
    expect(find.text('裝置安全簽署不可用，求救未送出'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
    expect(find.byKey(const ValueKey<String>('rescue-submit')), findsOneWidget);
  });

  testWidgets('an ACTIVE request is restored on start and can be marked safe', (tester) async {
    final service = FakeRescueService()..initialSessions = <RescueSession>[fakeSession()];
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-resolve')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();
    expect(service.revisions.single.$2, RescueAction.resolve);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
  });

  testWidgets('an expired request offers to file it again instead of extending', (tester) async {
    final service = FakeRescueService()
      ..initialSessions = <RescueSession>[fakeSession(issuedAt: '2026-10-11T00:00:00Z', expiresAt: DateTime.now().toUtc().subtract(const Duration(minutes: 5)).toIso8601String())];
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
    expect(find.byKey(const ValueKey<String>('rescue-expired-banner')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-recreate')));
    await tester.pump();
    expect(find.text('需要救援'), findsWidgets);
    expect(find.byKey(const ValueKey<String>('rescue-confirm')), findsOneWidget);
  });

  testWidgets('duplicate submits are ignored while one is in flight', (tester) async {
    final service = FakeRescueService()..pendingSubmit = Completer<RescueSession>();
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    await _openAndConfirm(tester);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')), warnIfMissed: false);
    expect(service.submitCalls, 1);
    service.pendingSubmit!.complete(fakeSession());
    await tester.pump();
  });
}

Future<void> _openAndConfirm(WidgetTester tester) async {
  await tester.tap(find.bySemanticsLabel('需要救援'));
  await tester.pump();
  await tester.ensureVisible(find.text('使用目前位置'));
  await tester.tap(find.text('使用目前位置'));
  await tester.pump();
  await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-confirm')));
  await tester.tap(find.byKey(const ValueKey<String>('rescue-confirm')));
  await tester.pump();
  await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-submit')));
}

Future<void> _finishLoad(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Widget _app(FakeRescueService service) => MaterialApp(
  home: MapScreen(
    key: UniqueKey(),
    staticFeatures: const StaticFeatureCollection(schemaVersion: 'test', datasetId: 'test', snapshotAt: null, features: <StaticFeature>[]),
    initialState: const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false),
    bridge: _FakeMapBridge(),
    rescueService: service,
    locationController: _FakeLocationController(const GeoPoint(longitude: 121.5, latitude: 25)),
  ),
);

class _FakeMapBridge extends MapBridge {
  _FakeMapBridge() : super(methodChannel: const MethodChannel('test/rescue-flow'));

  @override
  Future<MapInitialState> getInitialState() async =>
      const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false);

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();
}

class _FakeLocationController extends LocationController {
  _FakeLocationController(this.result);

  final GeoPoint? result;

  @override
  Stream<GeoPoint> get locations => const Stream<GeoPoint>.empty();

  @override
  Future<GeoPoint?> requestCurrentLocation() async => result;
}
