import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  test(
    'disaster filtering retains unknown shelters and excludes known mismatches',
    () {
      StaticFeature shelter(String id, List<String>? types) => StaticFeature(
        id: id,
        kind: 'shelter',
        geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
        fields: {if (types != null) 'disaster_types': types},
        properties: null,
      );
      final flood = shelter('flood', ['水災']);
      final earthquake = shelter('earthquake', ['震災']);
      final unknown = shelter('unknown', []);
      final missing = shelter('missing', null);
      expect(
        shelterDisasterEligibility(flood, DisasterType.flood),
        ShelterDisasterEligibility.compatible,
      );
      expect(
        shelterDisasterEligibility(earthquake, DisasterType.flood),
        ShelterDisasterEligibility.incompatible,
      );
      expect(
        shelterDisasterEligibility(unknown, DisasterType.flood),
        ShelterDisasterEligibility.unknown,
      );
      expect(
        shortlistShelterCandidates(
          const GeoPoint(longitude: 121.5, latitude: 25),
          [flood, earthquake, unknown, missing],
          disasterType: DisasterType.flood,
        ).map((c) => c.id),
        ['flood', 'missing', 'unknown'],
      );
      expect(
        shortlistShelterCandidates(
          const GeoPoint(longitude: 121.5, latitude: 25),
          [flood, earthquake],
        ).length,
        2,
      );
    },
  );
  test('parses an ok route in lon-lat order with warnings', () {
    final route = EvacuationRouteResult.fromMessage(<String, dynamic>{
      'status': 'ok',
      'polyline': <dynamic>[
        <dynamic>[121.59, 25.08],
        <dynamic>[121.60, 25.09],
      ],
      'distance_m': 1200,
      'duration_s': 900,
      'graph_version': 'taiwan-walk-test',
      'event_snapshot_at': '2026-09-25T08:30:00Z',
      'warnings': <dynamic>[
        <String, dynamic>{
          'code': 'UNVERIFIED_CROWD_REPORT',
          'event_id': 'report:test',
          'message': '附近有未驗證警示，請現場確認',
        },
      ],
      'blocked_event_ids': <dynamic>['road:closed'],
    });

    expect(route.status, EvacuationRouteStatus.ok);
    expect(route.polyline, hasLength(2));
    expect(route.polyline.first.longitude, 121.59);
    expect(route.polyline.first.latitude, 25.08);
    expect(route.distanceM, 1200);
    expect(route.durationS, 900);
    expect(route.graphVersion, 'taiwan-walk-test');
    expect(route.warnings.single.code, 'UNVERIFIED_CROWD_REPORT');
    expect(route.blockedEventIds, <String>['road:closed']);
  });

  test('parses every non-success status without retaining a route line', () {
    for (final status in <String>[
      'no_route',
      'graph_unavailable',
      'invalid_input',
    ]) {
      final route = EvacuationRouteResult.fromMessage(<String, dynamic>{
        'status': status,
        'polyline': <dynamic>[
          <dynamic>[121.59, 25.08],
          <dynamic>[121.60, 25.09],
        ],
        'distance_m': 1200,
        'duration_s': 900,
        'graph_version': 'ignored',
        'event_snapshot_at': '2026-09-25T08:30:00Z',
        'warnings': <dynamic>[],
        'blocked_event_ids': <dynamic>[],
      });

      expect(route.status.wireValue, status);
      expect(route.polyline, isEmpty);
      expect(route.distanceM, isNull);
      expect(route.durationS, isNull);
    }
  });

  test('rejects malformed ok routes', () {
    final base = <String, dynamic>{
      'status': 'ok',
      'polyline': <dynamic>[
        <dynamic>[121.59, 25.08],
      ],
      'distance_m': 1200,
      'duration_s': 900,
      'graph_version': 'graph',
      'event_snapshot_at': 'snapshot',
      'warnings': <dynamic>[],
      'blocked_event_ids': <dynamic>[],
    };

    expect(
      () => EvacuationRouteResult.fromMessage(base),
      throwsFormatException,
    );

    final negativeDistance =
        <String, dynamic>{...base}
          ..['polyline'] = <dynamic>[
            <dynamic>[121.59, 25.08],
            <dynamic>[121.60, 25.09],
          ]
          ..['distance_m'] = -1;
    expect(
      () => EvacuationRouteResult.fromMessage(negativeDistance),
      throwsFormatException,
    );
  });

  test('serializes a shelter route candidate', () {
    const candidate = ShelterRouteCandidate(
      id: 'shelter:test',
      location: GeoPoint(longitude: 121.5908, latitude: 25.0609),
    );

    expect(candidate.toChannelArguments(), <String, Object?>{
      'id': 'shelter:test',
      'lon': 121.5908,
      'lat': 25.0609,
      'kind': 'shelter',
    });
  });

  group('route focus bounds', () {
    EvacuationRouteResult route(List<GeoPoint> polyline) =>
        EvacuationRouteResult(
          status: EvacuationRouteStatus.ok,
          polyline: polyline,
          distanceM: 10,
          durationS: 10,
          graphVersion: 'g',
          eventSnapshotAt: 't',
          warnings: const <RouteWarning>[],
          blockedEventIds: const <String>[],
        );

    test('cover every route point', () {
      final bounds =
          routeFocusBounds(
            route(const <GeoPoint>[
              GeoPoint(longitude: 121.50, latitude: 25.00),
              GeoPoint(longitude: 121.56, latitude: 25.08),
              GeoPoint(longitude: 121.53, latitude: 24.98),
            ]),
          )!;
      expect(bounds.southwest.longitude, 121.50);
      expect(bounds.southwest.latitude, 24.98);
      expect(bounds.northeast.longitude, 121.56);
      expect(bounds.northeast.latitude, 25.08);
    });

    test('widen a very short route around its centre', () {
      final bounds =
          routeFocusBounds(
            route(const <GeoPoint>[
              GeoPoint(longitude: 121.5, latitude: 25.0),
              GeoPoint(longitude: 121.5, latitude: 25.0),
            ]),
          )!;
      expect(
        bounds.northeast.longitude - bounds.southwest.longitude,
        closeTo(0.002, 1e-12),
      );
      expect(
        bounds.northeast.latitude - bounds.southwest.latitude,
        closeTo(0.002, 1e-12),
      );
    });

    test('ignore failed routes', () {
      expect(
        routeFocusBounds(
          const EvacuationRouteResult(
            status: EvacuationRouteStatus.noRoute,
            polyline: <GeoPoint>[],
            distanceM: null,
            durationS: null,
            graphVersion: null,
            eventSnapshotAt: null,
            warnings: <RouteWarning>[],
            blockedEventIds: <String>[],
          ),
        ),
        isNull,
      );
    });
  });

  group('walking route destinations', () {
    const point = PointGeometry(GeoPoint(longitude: 121.59, latitude: 25.08));

    StaticFeature feature(String kind, {String? id = 'f:1', MapGeometry? at}) =>
        StaticFeature(
          id: id,
          kind: kind,
          geometry: at,
          fields: const <String, dynamic>{'name': '設施'},
          properties: null,
        );

    test('located medical facilities route as medical destinations', () {
      final destination =
          RouteDestination.fromFeature(
            feature('medical', at: point),
            name: '慈安診所',
          )!;

      expect(destination.kind, RouteDestinationKind.medical);
      expect(destination.isShelter, isFalse);
      expect(destination.name, '慈安診所');
      expect(destination.supplyKey, isNull);
      expect(destination.candidate.toChannelArguments(), <String, Object?>{
        'id': 'f:1',
        'lon': 121.59,
        'lat': 25.08,
        'kind': 'medical',
      });
    });

    test('features without an id, point or routable kind are rejected', () {
      expect(
        RouteDestination.fromFeature(feature('medical'), name: 'x'),
        isNull,
      );
      expect(
        RouteDestination.fromFeature(
          feature('medical', id: null, at: point),
          name: 'x',
        ),
        isNull,
      );
      expect(
        RouteDestination.fromFeature(
          feature('medical-directory', at: point),
          name: 'x',
        ),
        isNull,
      );
      expect(
        RouteDestination.fromFeature(
          feature('shelter', at: point),
          name: 'x',
        )?.kind,
        RouteDestinationKind.shelter,
      );
    });

    test('supply points and supply station announcements are routable', () {
      final supply = _supply();
      final station = _supply(
        namespace: 'official.announcement',
        eventType: 'GOVERNMENT_ANNOUNCEMENT',
        attributes: const <String, dynamic>{
          'category': 'SUPPLY_STATION',
          'has_map_location': true,
        },
      );
      final destination = RouteDestination.fromSupplyEvent(supply, name: '站')!;

      expect(destination.kind, RouteDestinationKind.supply);
      expect(destination.supplyKey, supplyEventKey(supply));
      expect(destination.candidate.toChannelArguments()['kind'], 'supply');
      expect(isRoutableSupplyEvent(station), isTrue);
    });

    test('area-only supply data and other announcements are not routable', () {
      expect(isRoutableSupplyEvent(_supply(geometry: null)), isFalse);
      expect(
        isRoutableSupplyEvent(
          _supply(
            namespace: 'official.announcement',
            eventType: 'GOVERNMENT_ANNOUNCEMENT',
            attributes: const <String, dynamic>{'category': 'EVACUATION'},
          ),
        ),
        isFalse,
      );
      expect(isRoutableSupplyEvent(_supply(eventType: 'ROAD_STATUS')), isFalse);
      expect(
        isRoutableSupplyEvent(
          _supply(
            namespace: 'official.announcement',
            eventType: 'GOVERNMENT_ANNOUNCEMENT',
            attributes: const <String, dynamic>{
              'category': 'SUPPLY_STATION',
              'has_map_location': false,
            },
          ),
        ),
        isFalse,
      );
    });

    test('the latest version of a supply point is found across versions', () {
      final first = _supply(version: 1);
      final second = _supply(version: 2);
      final key = supplyEventKey(first);

      expect(supplyEventKey(second), key);
      expect(latestSupplyEvent(<MeshEvent>[second, first], key), same(second));
      expect(latestSupplyEvent(<MeshEvent>[_supply(id: 'other')], key), isNull);
      final retracted = _supply(
        version: 3,
        attributes: const <String, dynamic>{'publication_retracted': true},
      );
      expect(latestSupplyEvent(<MeshEvent>[second, retracted], key), isNull);
    });

    test('supply status becomes a warning instead of removing the route', () {
      final now = DateTime.utc(2030);
      List<String> codes(MeshEvent event) =>
          supplyRouteWarnings(
            event,
            now,
          ).map((warning) => warning.code).toList();

      expect(codes(_supply(status: 'AVAILABLE')), isEmpty);
      expect(codes(_supply(status: 'PAUSED')), <String>['SUPPLY_PAUSED']);
      expect(codes(_supply(status: 'EXHAUSTED')), <String>['SUPPLY_EXHAUSTED']);
      expect(codes(_supply(status: 'CLOSED')), <String>['SUPPLY_CLOSED']);
      expect(codes(_supply(status: null)), <String>['SUPPLY_STATUS_UNKNOWN']);
      expect(
        codes(_supply(status: 'AVAILABLE', expiresAt: '2029-12-31T00:00:00Z')),
        <String>['SUPPLY_STATUS_EXPIRED'],
      );
      expect(
        codes(
          _supply(
            namespace: 'official.announcement',
            eventType: 'GOVERNMENT_ANNOUNCEMENT',
            attributes: const <String, dynamic>{
              'category': 'SUPPLY_STATION',
              'has_map_location': true,
            },
          ),
        ),
        isEmpty,
      );
    });
  });

  test('shortlists at most five point shelters by air distance then id', () {
    const origin = GeoPoint(longitude: 121.5, latitude: 25.0);
    final shelters = <StaticFeature>[
      _shelter('shelter:far', 121.9, 25.4),
      _shelter('shelter:near-b', 121.51, 25.01),
      _shelter('shelter:near-a', 121.51, 25.01),
      _shelter('shelter:3', 121.52, 25.02),
      _shelter('shelter:4', 121.53, 25.03),
      _shelter('shelter:5', 121.54, 25.04),
      _shelter('shelter:6', 121.55, 25.05),
      _shelter('shelter:7', 121.56, 25.06),
      const StaticFeature(
        id: 'medical:not-shelter',
        kind: 'medical',
        geometry: PointGeometry(
          GeoPoint(longitude: 121.5001, latitude: 25.0001),
        ),
        fields: <String, dynamic>{'name': '醫療院所'},
        properties: null,
      ),
      const StaticFeature(
        id: null,
        kind: 'shelter',
        geometry: PointGeometry(
          GeoPoint(longitude: 121.5002, latitude: 25.0002),
        ),
        fields: <String, dynamic>{'name': '沒有編號'},
        properties: null,
      ),
    ];

    final candidates = shortlistShelterCandidates(origin, shelters);

    expect(candidates, hasLength(5));
    expect(candidates.map((candidate) => candidate.id).toList(), <String>[
      'shelter:near-a',
      'shelter:near-b',
      'shelter:3',
      'shelter:4',
      'shelter:5',
    ]);
    expect(candidates, everyElement(isA<ShelterRouteCandidate>()));
  });

  test('expanded shortlist can reach the sixth shelter', () {
    final candidates = shortlistShelterCandidates(
      const GeoPoint(longitude: 121.5, latitude: 25.0),
      List<StaticFeature>.generate(
        8,
        (index) => _shelter('shelter:$index', 121.5 + index / 1000, 25.0),
      ),
      limit: 99,
    );

    expect(candidates, hasLength(8));
  });

  test(
    'shortlist excludes shelters beyond the search radius and caps at fifty',
    () {
      const origin = GeoPoint(longitude: 121.5, latitude: 25.0);
      final candidates = shortlistShelterCandidates(
        origin,
        List.generate(
          60,
          (index) => _shelter('shelter:$index', 121.5 + index / 10000, 25.0),
        ),
        limit: 99,
        maxDistanceM: 20000,
      );
      expect(candidates, hasLength(50));
      expect(
        shortlistShelterCandidates(
          origin,
          [_shelter('far', 121.9, 25.4)],
          limit: 50,
          maxDistanceM: 20000,
        ),
        isEmpty,
      );
    },
  );
}

StaticFeature _shelter(String id, double longitude, double latitude) =>
    StaticFeature(
      id: id,
      kind: 'shelter',
      geometry: PointGeometry(
        GeoPoint(longitude: longitude, latitude: latitude),
      ),
      fields: const <String, dynamic>{'name': '測試避難所'},
      properties: null,
    );

MeshEvent _supply({
  String id = 'supply:1',
  int version = 1,
  String namespace = 'official.supply',
  String eventType = 'SUPPLY_STATUS',
  MapGeometry? geometry = const PointGeometry(
    GeoPoint(longitude: 121.59, latitude: 25.08),
  ),
  String? status = 'AVAILABLE',
  String expiresAt = '2099-01-01T00:00:00Z',
  Map<String, dynamic>? attributes,
}) => MeshEvent(
  namespace: namespace,
  eventId: id,
  eventVersion: version,
  eventType: eventType,
  severity: 'LOW',
  source: 'GOVERNMENT',
  issuedAt: '2026-10-20T00:00:00Z',
  expiresAt: expiresAt,
  applyState: 'CURRENT',
  geometry: geometry,
  attributes:
      attributes ??
      <String, dynamic>{'name': '物資發放點', if (status != null) 'status': status},
);
