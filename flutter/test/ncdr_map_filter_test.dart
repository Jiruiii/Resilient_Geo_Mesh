import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/ncdr_map_filter.dart';

void main() {
  test('shows selected NCDR background categories on the map', () {
    final inspection = _event(
      'ncdr:inspection',
      mapVisible: false,
      relevance: 'BACKGROUND',
      categoryLabel: '火災',
    );
    final evacuation = _event(
      'ncdr:evacuation',
      mapVisible: true,
      relevance: 'EVACUATION',
      categoryLabel: '火災',
    );
    final routeChange = _event(
      'ncdr:route-change',
      mapVisible: true,
      relevance: 'ROUTE_CHANGE',
      categoryLabel: '火災',
    );

    expect(
      filterMapEvents(<MeshEvent>[
        inspection,
        evacuation,
        routeChange,
      ]).map((event) => event.eventId),
      <String?>['ncdr:inspection', 'ncdr:evacuation', 'ncdr:route-change'],
    );
  });

  test('hides NCDR other categories from the map but keeps selected types', () {
    final other = _event(
      'ncdr:other',
      mapVisible: true,
      relevance: 'HIGH_IMPACT',
      categoryLabel: '其他 NCDR 事件',
    );
    final fire = _event(
      'ncdr:fire',
      mapVisible: false,
      relevance: 'BACKGROUND',
      categoryLabel: '火災',
    );
    final heat = _event(
      'ncdr:heat',
      mapVisible: false,
      relevance: 'BACKGROUND',
      categoryLabel: '高溫',
    );
    final forest = _event(
      'ncdr:forest',
      mapVisible: false,
      relevance: 'BACKGROUND',
      categoryLabel: '國家森林遊樂區',
    );

    expect(
      filterMapEvents(<MeshEvent>[
        other,
        fire,
        heat,
        forest,
      ]).map((event) => event.eventId),
      <String?>['ncdr:fire', 'ncdr:heat', 'ncdr:forest'],
    );
  });

  test('keeps CWA events without applying NCDR visibility metadata', () {
    final cwa = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.cwa',
      'event_id': 'cwa:earthquake',
      'event_type': 'EARTHQUAKE_INTENSITY',
      'source': 'CWA',
      'issued_at': '2026-09-26T03:00:00Z',
      'expires_at': '2099-01-01T00:00:00Z',
      'attributes': <String, dynamic>{'map_visible': false},
    });

    expect(isAppSupportedEvent(cwa), isTrue);
    expect(filterMapEvents(<MeshEvent>[cwa]), contains(cwa));
  });

  test(
    'recognizes live CWA feed namespaces independently of NCDR metadata',
    () {
      final cwa = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.live.cwa-warning',
        'event_id': 'cwa:warning:rain',
        'event_type': 'RAIN_WARNING',
        'issued_at': '2026-09-26T03:00:00Z',
        'expires_at': '2099-01-01T00:00:00Z',
        'attributes': <String, dynamic>{'map_visible': false},
      });

      expect(isAppSupportedEvent(cwa), isTrue);
      expect(filterMapEvents(<MeshEvent>[cwa]), contains(cwa));
    },
  );

  test(
    'accepts official announcements and attestations while mapping only explicit announcement locations',
    () {
      final noticeWithoutLocation = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.announcement',
        'event_id': 'announcement:1',
        'event_type': 'GOVERNMENT_ANNOUNCEMENT',
        'source': 'GOVERNMENT',
        'attributes': <String, dynamic>{'has_map_location': false},
      });
      final noticeWithLocation = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.announcement',
        'event_id': 'announcement:2',
        'event_type': 'GOVERNMENT_ANNOUNCEMENT',
        'source': 'GOVERNMENT',
        'geometry': <String, dynamic>{
          'type': 'Point',
          'coordinates': <double>[121.5, 25.0],
        },
        'attributes': <String, dynamic>{'has_map_location': true},
      });
      final attestation = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.verified',
        'event_id': 'attest:report:device:1',
        'event_type': 'ATTESTATION',
        'source': 'GOV_ATTEST',
        'attributes': <String, dynamic>{'verdict': 'REFUTED'},
      });

      expect(isAppSupportedEvent(noticeWithoutLocation), isTrue);
      expect(isAppSupportedEvent(attestation), isTrue);
      expect(
        filterMapEvents(<MeshEvent>[
          noticeWithoutLocation,
          noticeWithLocation,
          attestation,
        ]),
        <MeshEvent>[noticeWithLocation],
      );
    },
  );

  test('maps every geolocated government announcement category', () {
    final events = <MeshEvent>[
      for (final category in <String>['SAFETY', 'ROAD', 'SUPPLY_STATION'])
        MeshEvent(
          namespace: 'official.announcement',
          eventId: 'announcement:$category',
          eventVersion: 1,
          eventType: 'GOVERNMENT_ANNOUNCEMENT',
          severity: 'MEDIUM',
          source: 'GOVERNMENT',
          issuedAt: '2026-10-12T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z',
          applyState: null,
          geometry: const PointGeometry(
            GeoPoint(longitude: 121.5, latitude: 25.0),
          ),
          attributes: <String, dynamic>{
            'category': category,
            'has_map_location': true,
          },
        ),
    ];

    expect(filterMapEvents(events), events);
  });

  test(
    'does not map government announcements with invalid or absent points',
    () {
      MeshEvent announcement(MapGeometry? geometry) => MeshEvent(
        namespace: 'official.announcement',
        eventId: 'announcement:invalid',
        eventVersion: 1,
        eventType: 'GOVERNMENT_ANNOUNCEMENT',
        severity: 'MEDIUM',
        source: 'GOVERNMENT',
        issuedAt: '2026-10-12T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        applyState: null,
        geometry: geometry,
        attributes: const <String, dynamic>{'has_map_location': true},
      );

      expect(
        filterMapEvents(<MeshEvent>[
          announcement(
            const PointGeometry(GeoPoint(longitude: 130, latitude: 25)),
          ),
          announcement(null),
        ]),
        isEmpty,
      );
    },
  );
}

MeshEvent _event(
  String id, {
  required bool mapVisible,
  required String relevance,
  String? categoryLabel,
}) => MeshEvent.fromJson(<String, dynamic>{
  'namespace': 'official.ncdr',
  'event_id': id,
  // SAFETY_ALERT is reserved for fire-safety inspections, which are hidden.
  'event_type': 'NCDR_ALERT',
  'source': 'NCDR',
  'issued_at': '2026-09-26T03:00:00Z',
  'expires_at': '2099-01-01T00:00:00Z',
  'attributes': <String, dynamic>{
    'map_visible': mapVisible,
    'operational_relevance': relevance,
    if (categoryLabel != null) 'ncdr_category_label': categoryLabel,
  },
});
