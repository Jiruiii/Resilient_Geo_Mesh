import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('multi-area NCDR bounds cover every affected island', () {
    const warning = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:wind',
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: '2026-10-21T00:00:00Z',
      applyState: 'CURRENT',
      geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 119, latitude: 26),
            GeoPoint(longitude: 120, latitude: 26),
            GeoPoint(longitude: 119, latitude: 26),
          ],
        ],
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 122, latitude: 22),
            GeoPoint(longitude: 122, latitude: 23),
            GeoPoint(longitude: 122, latitude: 22),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 55,
        'area_match_complete': true,
      },
    );

    expect(warning.isNcdrMultiAreaWarning, isTrue);
    expect(warning.hasCompleteNcdrAreaMask, isTrue);
    final bounds = meshEventBounds(warning)!;
    expect(bounds.southwest, const GeoPoint(longitude: 119, latitude: 22));
    expect(bounds.northeast, const GeoPoint(longitude: 122, latitude: 26));
  });

  test('parses a static LineString feature with its exact coordinates', () {
    final feature = StaticFeature.fromJson(<String, dynamic>{
      'id': 'osm:way:1014301596',
      'kind': 'road',
      'geometry': <String, dynamic>{
        'type': 'LineString',
        'coordinates': <dynamic>[
          <dynamic>[121.6154878, 25.1006944],
          <dynamic>[121.6155328, 25.1006142],
        ],
      },
      'properties': null,
    });

    expect(feature.id, 'osm:way:1014301596');
    expect(feature.kind, 'road');
    expect(feature.properties, isNull);
    expect(feature.geometry, isA<LineStringGeometry>());
    final geometry = feature.geometry! as LineStringGeometry;
    expect(geometry.points, hasLength(2));
    expect(geometry.points.first.longitude, 121.6154878);
    expect(geometry.points.last.latitude, 25.1006142);
  });

  test('parses Point, LineString, and Polygon event geometries', () {
    final point = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.fire',
      'event_id': 'shelter:wende-01',
      'event_version': 1,
      'event_type': 'SHELTER_STATUS',
      'severity': 'HIGH',
      'geometry': <String, dynamic>{
        'type': 'Point',
        'coordinates': <dynamic>[121.5849, 25.0786],
      },
    });
    final line = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.tdx',
      'event_id': 'road:dahu-01',
      'event_version': 2,
      'event_type': 'ROAD_STATUS',
      'severity': 'HIGH',
      'geometry': <String, dynamic>{
        'type': 'LineString',
        'coordinates': <dynamic>[
          <dynamic>[121.5993, 25.0825],
          <dynamic>[121.6053, 25.085],
        ],
      },
    });
    final polygon = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.cwa',
      'event_id': 'flood:neihu-0901-001',
      'event_version': 1,
      'event_type': 'FLOOD_WARNING',
      'severity': 'CRITICAL',
      'geometry': <String, dynamic>{
        'type': 'Polygon',
        'coordinates': <dynamic>[
          <dynamic>[
            <dynamic>[121.565, 25.065],
            <dynamic>[121.615, 25.065],
            <dynamic>[121.615, 25.09],
            <dynamic>[121.565, 25.065],
          ],
        ],
      },
    });

    expect(point.geometry, isA<PointGeometry>());
    expect((point.geometry! as PointGeometry).point.latitude, 25.0786);
    expect(line.geometry, isA<LineStringGeometry>());
    expect(
      (line.geometry! as LineStringGeometry).points.last.longitude,
      121.6053,
    );
    expect(polygon.geometry, isA<PolygonGeometry>());
    expect((polygon.geometry! as PolygonGeometry).rings.single, hasLength(4));
  });

  test(
    'keeps an island warning MultiPolygon and focuses its largest island',
    () {
      final warning = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.cwa',
        'event_id': 'wind:islands',
        'event_type': 'WEATHER_WARNING',
        'geometry': <String, dynamic>{
          'type': 'MultiPolygon',
          'coordinates': <dynamic>[
            <dynamic>[
              <dynamic>[
                <dynamic>[120.0, 23.0],
                <dynamic>[120.1, 23.0],
                <dynamic>[120.1, 23.1],
                <dynamic>[120.0, 23.0],
              ],
            ],
            <dynamic>[
              <dynamic>[
                <dynamic>[119.0, 23.0],
                <dynamic>[119.8, 23.0],
                <dynamic>[119.8, 23.8],
                <dynamic>[119.0, 23.8],
                <dynamic>[119.0, 23.0],
              ],
            ],
          ],
        },
      });

      expect(warning.geometry, isA<MultiPolygonGeometry>());
      expect(
        (warning.geometry! as MultiPolygonGeometry).polygons,
        hasLength(2),
      );
      expect(
        meshEventFocusPoint(warning),
        const GeoPoint(longitude: 119.4, latitude: 23.4),
      );
    },
  );

  test('preserves nullable event fields and flags expired events', () {
    final event = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'crowd.reports',
      'event_id': 'road:dahu-01',
      'event_version': null,
      'event_type': null,
      'severity': null,
      'source': null,
      'issued_at': null,
      'expires_at': '2020-01-01T00:00:00Z',
      'apply_state': 'EXPIRED',
      'geometry': null,
      'attributes': null,
    });

    expect(event.eventVersion, isNull);
    expect(event.eventType, isNull);
    expect(event.severity, isNull);
    expect(event.source, isNull);
    expect(event.issuedAt, isNull);
    expect(event.attributes, isNull);
    expect(event.geometry, isNull);
    expect(event.applyState, 'EXPIRED');
    expect(event.isExpired, isTrue);
  });

  test('expired timestamps override a stale stored CURRENT state', () {
    final event = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.tdx',
      'event_id': 'road:dahu-01',
      'event_version': 2,
      'event_type': 'ROAD_STATUS',
      'severity': 'HIGH',
      'expires_at': '2020-01-01T00:00:00Z',
      'apply_state': 'CURRENT',
    });

    expect(event.expiresAt, '2020-01-01T00:00:00Z');
    expect(event.applyState, 'CURRENT');
    expect(event.isExpired, isTrue);
    expect(event.effectiveApplyState, 'EXPIRED');
  });

  test(
    'treats an event without Android state as current from its time window',
    () {
      final current = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.ncdr',
        'event_id': 'ncdr:current',
        'event_version': 1,
        'issued_at': '2026-09-26T03:00:00Z',
        'expires_at': '2026-09-26T05:00:00Z',
      });
      final expired = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.ncdr',
        'event_id': 'ncdr:expired',
        'event_version': 1,
        'issued_at': '2026-09-26T01:00:00Z',
        'expires_at': '2026-09-26T02:00:00Z',
      });

      final now = DateTime.utc(2026, 9, 26, 4);

      expect(current.isCurrentAt(now), isTrue);
      expect(expired.isCurrentAt(now), isFalse);
    },
  );

  test('does not treat an event issued in the future as current', () {
    final event = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.ncdr',
      'event_id': 'ncdr:future',
      'event_version': 1,
      'issued_at': '2026-09-26T05:00:00Z',
      'expires_at': '2026-09-26T06:00:00Z',
    });

    expect(event.isCurrentAt(DateTime.utc(2026, 9, 26, 4)), isFalse);
  });

  test(
    'labels a future time window as upcoming even when Android state is current',
    () {
      final start = DateTime.now().toUtc().add(const Duration(days: 1));
      final event = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.live.cwa-warning',
        'event_id': 'cwa:warning:future',
        'event_version': 1,
        'event_type': 'WEATHER_WARNING',
        'issued_at': start.toIso8601String(),
        'expires_at': start.add(const Duration(hours: 12)).toIso8601String(),
        'apply_state': 'CURRENT',
      });

      expect(event.effectiveApplyState, 'UPCOMING');
      expect(event.isCurrentAt(), isFalse);
    },
  );

  test('preserves real shelter root metadata and nullable availability', () {
    final shelter = StaticFeature.fromJson(<String, dynamic>{
      'id': 'shelter:5427',
      'kind': 'shelter',
      'name': '潭美國小',
      'address': '內湖區新明路22號',
      'capacity': 81,
      'available_count': null,
      'disaster_types': <String>['水災', '震災'],
      'facility_type': null,
      'geometry': <String, dynamic>{
        'type': 'Point',
        'coordinates': <double>[121.5908, 25.0609],
      },
      'properties': null,
    });

    expect(shelter.fields['name'], '潭美國小');
    expect(shelter.fields['address'], '內湖區新明路22號');
    expect(shelter.fields['capacity'], 81);
    expect(shelter.fields['available_count'], isNull);
    expect(shelter.fields['disaster_types'], <String>['水災', '震災']);
    expect(shelter.fields['facility_type'], isNull);
    expect(shelter.details['available_count'], isNull);
    expect(shelter.details['name'], '潭美國小');
  });

  test('rejects a non-map getInitialState reply', () async {
    const channel = MethodChannel('test/map-bridge/non-map');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async => 'not a map');
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    await expectLater(
      MapBridge(methodChannel: channel).getInitialState(),
      throwsA(isA<FormatException>()),
    );
  });

  test('rejects a getInitialState reply missing emergency state', () async {
    const channel = MethodChannel('test/map-bridge/missing-emergency');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => <String, dynamic>{'events': <dynamic>[]},
    );
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    await expectLater(
      MapBridge(methodChannel: channel).getInitialState(),
      throwsA(isA<FormatException>()),
    );
  });

  test('rejects a fixture summary reply missing a required count', () async {
    const channel = MethodChannel('test/map-bridge/missing-summary');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => <String, dynamic>{
        'processed': 2,
        'inserted': 1,
        'updated': 1,
      },
    );
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    await expectLater(
      MapBridge(methodChannel: channel).loadBundledFixture(),
      throwsA(isA<FormatException>()),
    );
  });

  test('rejects an emergency reply missing enabled', () async {
    const channel = MethodChannel('test/map-bridge/missing-enabled');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => <String, dynamic>{},
    );
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    await expectLater(
      MapBridge(methodChannel: channel).setEmergencyMode(enabled: true),
      throwsA(isA<FormatException>()),
    );
  });
}
