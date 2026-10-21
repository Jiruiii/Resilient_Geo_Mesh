import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/cwa_county_warning_overlay.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final now = DateTime.utc(2026, 10, 21, 12);

  test(
    'bundled display boundaries cover all counties and offshore islands',
    () async {
      final counties = await CwaCountyWarningOverlay.load();

      expect(counties, hasLength(22));
      expect(counties['tw.10016']?['geometry']['type'], 'MultiPolygon');
      expect(counties['tw.09020']?['geometry']['type'], 'MultiPolygon');
      expect(counties['tw.09007']?['geometry']['type'], 'MultiPolygon');
    },
    // Flutter's Chrome test asset bundle also hangs on the existing map
    // style asset tests; the built Web asset is checked separately.
    skip: kIsWeb,
  );

  test('only current CWA county warnings produce one mask per area', () {
    final counties = <String, Map<String, dynamic>>{
      for (final areaId in <String>['tw.10016', 'tw.65000'])
        areaId: <String, dynamic>{
          'type': 'Feature',
          'properties': <String, dynamic>{'area_id': areaId},
          'geometry': <String, dynamic>{
            'type': 'Polygon',
            'coordinates': <dynamic>[],
          },
        },
    };
    final events = <MeshEvent>[
      _warning('tw.65000'),
      _warning('tw.65000'),
      _warning('tw.10016'),
      _warning('tw.63000', expiresAt: '2026-10-21T11:00:00Z'),
      _warning('tw.09020', source: 'NCDR'),
      _warning('tw.09007', coverageLevel: 'district'),
    ];

    final collection = CwaCountyWarningOverlay.featureCollection(
      events,
      counties,
      now: now,
    );
    final features = collection['features'] as List<dynamic>;
    final ids = features
        .map((feature) => feature['properties']['area_id'])
        .toList(growable: false);
    expect(ids, <String>['tw.10016', 'tw.65000']);
    expect(
      CwaCountyWarningOverlay.nextExpiry(events, now: now),
      DateTime.utc(2026, 10, 21, 23),
    );
  });

  test(
    'forecast warning already in CWA feed has a county mask before its start',
    () {
      final warning = _warning('tw.10016');
      final reference = DateTime.utc(2026, 10, 20, 9);
      final counties = <String, Map<String, dynamic>>{
        'tw.10016': <String, dynamic>{
          'type': 'Feature',
          'properties': <String, dynamic>{'area_id': 'tw.10016'},
          'geometry': <String, dynamic>{
            'type': 'Polygon',
            'coordinates': <dynamic>[],
          },
        },
      };

      expect(warning.isCurrentAt(reference), isFalse);
      expect(warning.isUpcomingCwaCountyWarningAt(reference), isTrue);
      expect(
        CwaCountyWarningOverlay.currentAreaIds(<MeshEvent>[
          warning,
        ], now: reference),
        <String>{'tw.10016'},
      );
      expect(
        (CwaCountyWarningOverlay.featureCollection(
              <MeshEvent>[warning],
              counties,
              now: reference,
            )['features']
            as List<dynamic>),
        hasLength(1),
      );
    },
  );
}

MeshEvent _warning(
  String areaId, {
  String source = 'CWA',
  String coverageLevel = 'county',
  String expiresAt = '2026-10-21T23:00:00Z',
}) => MeshEvent(
  namespace: 'official.live.cwa-warning',
  eventId:
      'cwa:warning:w-c0033-001:${areaId.substring(3)}:2026-10-21-11:00:00:0',
  eventVersion: 1,
  eventType: 'WEATHER_WARNING',
  severity: 'MEDIUM',
  source: source,
  issuedAt: '2026-10-21T03:00:00Z',
  expiresAt: expiresAt,
  applyState: 'CURRENT',
  geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25.0)),
  attributes: <String, dynamic>{
    'area_id': areaId,
    'coverage_level': coverageLevel,
    'map_location_kind': 'area_reference',
  },
);
