import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_area_hit_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  final now = DateTime.utc(2026, 10, 21, 4);

  test('selects a complete NCDR mask across its polygons and holes', () {
    const warning = MeshEvent(
      namespace: 'official.live.ncdr',
      eventId: 'ncdr:wind:areas',
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T20:37:18Z',
      expiresAt: '2026-10-21T15:00:00Z',
      applyState: null,
      geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 0, latitude: 0),
            GeoPoint(longitude: 10, latitude: 0),
            GeoPoint(longitude: 10, latitude: 10),
            GeoPoint(longitude: 0, latitude: 10),
            GeoPoint(longitude: 0, latitude: 0),
          ],
          <GeoPoint>[
            GeoPoint(longitude: 2, latitude: 2),
            GeoPoint(longitude: 4, latitude: 2),
            GeoPoint(longitude: 4, latitude: 4),
            GeoPoint(longitude: 2, latitude: 4),
            GeoPoint(longitude: 2, latitude: 2),
          ],
        ],
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 20, latitude: 20),
            GeoPoint(longitude: 21, latitude: 20),
            GeoPoint(longitude: 21, latitude: 21),
            GeoPoint(longitude: 20, latitude: 21),
            GeoPoint(longitude: 20, latitude: 20),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 55,
        'area_match_complete': true,
      },
    );

    expect(
      ncdrAreaWarningAtCoordinate(
        <MeshEvent>[warning],
        const GeoPoint(longitude: 1, latitude: 1),
        now: now,
      ),
      warning,
    );
    expect(
      ncdrAreaWarningAtCoordinate(
        <MeshEvent>[warning],
        const GeoPoint(longitude: 3, latitude: 3),
        now: now,
      ),
      isNull,
    );
    expect(
      ncdrAreaWarningAtCoordinate(
        <MeshEvent>[warning],
        const GeoPoint(longitude: 20.5, latitude: 20.5),
        now: now,
      ),
      warning,
    );
    expect(
      ncdrAreaWarningAtCoordinate(
        <MeshEvent>[warning],
        const GeoPoint(longitude: 12, latitude: 12),
        now: now,
      ),
      isNull,
    );
  });

  test('does not select expired or incomplete NCDR masks', () {
    const warning = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:wind:incomplete',
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T20:37:18Z',
      expiresAt: '2026-10-21T15:00:00Z',
      applyState: 'CURRENT',
      geometry: PolygonGeometry(<List<GeoPoint>>[
        <GeoPoint>[
          GeoPoint(longitude: 0, latitude: 0),
          GeoPoint(longitude: 10, latitude: 0),
          GeoPoint(longitude: 10, latitude: 10),
          GeoPoint(longitude: 0, latitude: 10),
          GeoPoint(longitude: 0, latitude: 0),
        ],
      ]),
      attributes: <String, dynamic>{
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 2,
        'area_match_complete': false,
      },
    );

    expect(
      ncdrAreaWarningAtCoordinate(
        <MeshEvent>[warning],
        const GeoPoint(longitude: 1, latitude: 1),
        now: now,
      ),
      isNull,
    );
  });
}
