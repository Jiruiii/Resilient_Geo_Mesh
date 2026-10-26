import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/bridge_failure.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  test(
    'sends the selected disaster through the native bridge',
    () async {
      const channel = MethodChannel('test/sync-and-disaster');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      MethodCall? received;
      messenger.setMockMethodCallHandler(channel, (call) async {
        received = call;
        return _okRouteMessage();
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      await MapBridge(methodChannel: channel).calculateEvacuationRoute(
        origin: const GeoPoint(longitude: 121.5, latitude: 25),
        destination: const ShelterRouteCandidate(
          id: 'shelter:test',
          location: GeoPoint(longitude: 121.5, latitude: 25),
        ),
        disasterType: DisasterType.tsunami,
      );
      expect((received!.arguments as Map)['disaster_type'], 'tsunami');
    },
  );
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'serializes the crowd report request on the existing method channel',
    () async {
      const channel = MethodChannel('test/map-bridge/crowd-report');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      MethodCall? received;
      messenger.setMockMethodCallHandler(channel, (call) async {
        received = call;
        return <String, dynamic>{
          'event_id': 'report:test',
          'apply_state': 'UNVERIFIED',
          'delivery_state': 'PENDING',
        };
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      const draft = CrowdReportDraft(
        category: CrowdReportCategory.roadBlockage,
        location: GeoPoint(longitude: 121.590304, latitude: 25.083506),
        locationSource: CrowdReportLocationSource.currentLocation,
        description: '道路有落石',
      );

      final result = await MapBridge(
        methodChannel: channel,
      ).submitCrowdReport(draft);

      expect(received?.method, 'submitCrowdReport');
      expect(received?.arguments, <String, Object?>{
        'category': 'ROAD_BLOCKAGE',
        'location': <String, Object?>{
          'lon': 121.590304,
          'lat': 25.083506,
          'source': 'CURRENT_LOCATION',
        },
        'description': '道路有落石',
      });
      expect(result.eventId, 'report:test');
    },
  );

  test('serializes the route request with the explicit walk mode', () async {
    const channel = MethodChannel('test/map-bridge/route');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    MethodCall? received;
    messenger.setMockMethodCallHandler(channel, (call) async {
      received = call;
      return _okRouteMessage();
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    final result = await MapBridge(
      methodChannel: channel,
    ).calculateEvacuationRoute(
      origin: const GeoPoint(longitude: 121.590304, latitude: 25.083506),
      destination: const ShelterRouteCandidate(
        id: 'shelter:test',
        location: GeoPoint(longitude: 121.5908, latitude: 25.0609),
      ),
    );

    expect(received?.method, 'calculateEvacuationRoute');
    expect(received?.arguments, <String, Object?>{
      'origin': <String, Object?>{'lon': 121.590304, 'lat': 25.083506},
      'destination': <String, Object?>{
        'id': 'shelter:test',
        'lon': 121.5908,
        'lat': 25.0609,
        'kind': 'shelter',
      },
      'mode': 'walk',
    });
    expect(result.status, EvacuationRouteStatus.ok);
  });

  test('rejects non-map and malformed native responses', () async {
    const reportChannel = MethodChannel('test/map-bridge/report-invalid');
    const routeChannel = MethodChannel('test/map-bridge/route-invalid');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      reportChannel,
      (call) async => 'invalid',
    );
    messenger.setMockMethodCallHandler(
      routeChannel,
      (call) async => <String, dynamic>{'status': 'ok'},
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(reportChannel, null);
      messenger.setMockMethodCallHandler(routeChannel, null);
    });

    const draft = CrowdReportDraft(
      category: CrowdReportCategory.other,
      location: GeoPoint(longitude: 121.5, latitude: 25),
      locationSource: CrowdReportLocationSource.mapPick,
      description: '',
    );
    final bridge = MapBridge(methodChannel: reportChannel);
    await expectLater(bridge.submitCrowdReport(draft), throwsFormatException);

    final routeBridge = MapBridge(methodChannel: routeChannel);
    await expectLater(
      routeBridge.calculateEvacuationRoute(
        origin: const GeoPoint(longitude: 121.5, latitude: 25),
        destination: const ShelterRouteCandidate(
          id: 'shelter:test',
          location: GeoPoint(longitude: 121.6, latitude: 25.1),
        ),
      ),
      throwsFormatException,
    );
  });

  test('normalizes platform, missing-plugin, and unknown errors', () async {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final entry
        in <String, BridgeFailureCode>{
          'signing_unavailable': BridgeFailureCode.signingUnavailable,
          'storage_unavailable': BridgeFailureCode.storageUnavailable,
          'route_engine_error': BridgeFailureCode.routeEngineError,
          'not_known': BridgeFailureCode.unknown,
        }.entries) {
      final channel = MethodChannel('test/map-bridge/error/${entry.key}');
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => throw PlatformException(code: entry.key),
      );
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      final bridge = MapBridge(methodChannel: channel);
      await expectLater(
        bridge.submitCrowdReport(_draft()),
        throwsA(
          isA<BridgeFailure>().having(
            (failure) => failure.code,
            'code',
            entry.value,
          ),
        ),
      );
    }

    const missingPluginChannel = MethodChannel(
      'test/map-bridge/missing-plugin',
    );
    final bridge = MapBridge(methodChannel: missingPluginChannel);
    await expectLater(
      bridge.submitCrowdReport(_draft()),
      throwsA(
        isA<BridgeFailure>().having(
          (failure) => failure.code,
          'code',
          BridgeFailureCode.unavailable,
        ),
      ),
    );
  });
}

CrowdReportDraft _draft() => const CrowdReportDraft(
  category: CrowdReportCategory.other,
  location: GeoPoint(longitude: 121.5, latitude: 25),
  locationSource: CrowdReportLocationSource.mapPick,
  description: '',
);

Map<String, dynamic> _okRouteMessage() => <String, dynamic>{
  'status': 'ok',
  'polyline': <dynamic>[
    <dynamic>[121.590304, 25.083506],
    <dynamic>[121.5908, 25.0609],
  ],
  'distance_m': 1200,
  'duration_s': 900,
  'graph_version': 'graph-test',
  'event_snapshot_at': '2026-09-25T08:30:00Z',
  'warnings': <dynamic>[],
  'blocked_event_ids': <dynamic>[],
};
