import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/maplibre_overlay.dart';

void main() {
  test('NCDR mask publishes only complete current multi-area boundaries', () {
    MeshEvent warning(String id, bool complete, String expiresAt) => MeshEvent(
      namespace: 'official.ncdr',
      eventId: id,
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: expiresAt,
      applyState: 'CURRENT',
      geometry: const MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 120, latitude: 23),
            GeoPoint(longitude: 121, latitude: 23),
            GeoPoint(longitude: 121, latitude: 24),
            GeoPoint(longitude: 120, latitude: 23),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 55,
        'area_match_complete': complete,
      },
    );
    final collection =
        MapLibreOverlayData.ncdrAreaFeatureCollection(<MeshEvent>[
          warning('complete', true, '2026-10-21T00:00:00Z'),
          warning('partial', false, '2026-10-21T00:00:00Z'),
          warning('expired', true, '2026-10-19T00:00:00Z'),
        ], now: DateTime.utc(2026, 10, 20, 12));
    final features = collection['features'] as List<dynamic>;
    expect(features, hasLength(1));
    expect(
      (features.single as Map<String, dynamic>)['geometry'],
      containsPair('type', 'MultiPolygon'),
    );
  });

  test(
    'event area rendering is disabled while the area UI is being redesigned',
    () {
      expect(MapLibreOverlayData.showEventAreaOverlay, isFalse);
    },
  );

  test(
    'converts event lines and polygons to GeoJSON while omitting points',
    () {
      const line = MeshEvent(
        namespace: 'test',
        eventId: 'line-1',
        eventVersion: 1,
        eventType: 'ROAD_BLOCKAGE',
        severity: 'HIGH',
        source: 'fixture',
        issuedAt: null,
        expiresAt: null,
        applyState: 'CURRENT',
        geometry: LineStringGeometry(<GeoPoint>[
          GeoPoint(longitude: 121.5, latitude: 25.0),
          GeoPoint(longitude: 121.6, latitude: 25.1),
        ]),
        attributes: null,
      );
      const polygon = MeshEvent(
        namespace: 'test',
        eventId: 'polygon-1',
        eventVersion: 2,
        eventType: 'FLOOD',
        severity: 'CRITICAL',
        source: 'fixture',
        issuedAt: null,
        expiresAt: null,
        applyState: 'EXPIRED',
        geometry: PolygonGeometry(<List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 121.4, latitude: 24.9),
            GeoPoint(longitude: 121.5, latitude: 24.9),
            GeoPoint(longitude: 121.5, latitude: 25.0),
            GeoPoint(longitude: 121.4, latitude: 24.9),
          ],
        ]),
        attributes: null,
      );
      const point = MeshEvent(
        namespace: 'test',
        eventId: 'point-1',
        eventVersion: 1,
        eventType: 'ALERT',
        severity: 'LOW',
        source: 'fixture',
        issuedAt: null,
        expiresAt: null,
        applyState: 'CURRENT',
        geometry: PointGeometry(GeoPoint(longitude: 121.5, latitude: 25.0)),
        attributes: null,
      );
      const multiPolygon = MeshEvent(
        namespace: 'test',
        eventId: 'multi-polygon-1',
        eventVersion: 1,
        eventType: 'WEATHER_WARNING',
        severity: 'LOW',
        source: 'CWA',
        issuedAt: null,
        expiresAt: null,
        applyState: 'CURRENT',
        geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
          <List<GeoPoint>>[
            <GeoPoint>[
              GeoPoint(longitude: 119.5, latitude: 23.5),
              GeoPoint(longitude: 119.6, latitude: 23.5),
              GeoPoint(longitude: 119.6, latitude: 23.6),
              GeoPoint(longitude: 119.5, latitude: 23.5),
            ],
          ],
        ]),
        attributes: null,
      );

      final collection = MapLibreOverlayData.eventFeatureCollection(<MeshEvent>[
        line,
        polygon,
        multiPolygon,
        point,
      ]);
      final features = collection['features']! as List<Object?>;

      expect(features, hasLength(3));
      expect(
        (features[0] as Map<String, dynamic>)['geometry'],
        containsPair('type', 'LineString'),
      );
      expect(
        (features[1] as Map<String, dynamic>)['geometry'],
        containsPair('type', 'Polygon'),
      );
      expect(
        ((features[1] as Map<String, dynamic>)['properties']
            as Map<String, dynamic>)['expired'],
        isTrue,
      );
      expect(
        (features[2] as Map<String, dynamic>)['geometry'],
        <String, dynamic>{
          'type': 'MultiPolygon',
          'coordinates': <List<List<List<double>>>>[
            <List<List<double>>>[
              <List<double>>[
                <double>[119.5, 23.5],
                <double>[119.6, 23.5],
                <double>[119.6, 23.6],
                <double>[119.5, 23.5],
              ],
            ],
          ],
        },
      );
    },
  );

  test('converts an ok route to a lon-lat GeoJSON line', () {
    final route = EvacuationRouteResult.fromMessage(<String, dynamic>{
      'status': 'ok',
      'polyline': <List<double>>[
        <double>[121.5, 25.0],
        <double>[121.6, 25.1],
      ],
      'distance_m': 1200,
      'duration_s': 900,
      'graph_version': 'taiwan-walk-test',
      'event_snapshot_at': '2026-09-25T00:00:00Z',
      'warnings': <Object?>[],
      'blocked_event_ids': <String>[],
    });

    expect(routeFeatureCollection(route), <String, dynamic>{
      'type': 'FeatureCollection',
      'features': <Map<String, dynamic>>[
        <String, dynamic>{
          'type': 'Feature',
          'properties': <String, dynamic>{},
          'geometry': <String, dynamic>{
            'type': 'LineString',
            'coordinates': <List<double>>[
              <double>[121.5, 25.0],
              <double>[121.6, 25.1],
            ],
          },
        },
      ],
    });
  });

  test('does not expose a route line for null or non-success results', () {
    final noRoute = EvacuationRouteResult.fromMessage(<String, dynamic>{
      'status': 'no_route',
      'polyline': <Object?>[
        <double>[121.5, 25.0],
        <double>[121.6, 25.1],
      ],
      'distance_m': 1200,
      'duration_s': 900,
      'graph_version': 'ignored',
      'event_snapshot_at': 'ignored',
      'warnings': <Object?>[],
      'blocked_event_ids': <String>[],
    });

    expect(routeFeatureCollection(null)['features'], isEmpty);
    expect(routeFeatureCollection(noRoute)['features'], isEmpty);
  });
}
