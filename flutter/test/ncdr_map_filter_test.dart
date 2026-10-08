import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/ncdr_map_filter.dart';

void main() {
  test('hides NCDR background events but keeps actionable events', () {
    final inspection = _event(
      'ncdr:inspection',
      mapVisible: false,
      relevance: 'BACKGROUND',
    );
    final evacuation = _event(
      'ncdr:evacuation',
      mapVisible: true,
      relevance: 'EVACUATION',
    );
    final routeChange = _event(
      'ncdr:route-change',
      mapVisible: true,
      relevance: 'ROUTE_CHANGE',
    );

    expect(
      filterMapEvents(<MeshEvent>[
        inspection,
        evacuation,
        routeChange,
      ]).map((event) => event.eventId),
      <String?>['ncdr:evacuation', 'ncdr:route-change'],
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
}

MeshEvent _event(
  String id, {
  required bool mapVisible,
  required String relevance,
}) => MeshEvent.fromJson(<String, dynamic>{
  'namespace': 'official.ncdr',
  'event_id': id,
  'event_type': 'SAFETY_ALERT',
  'source': 'NCDR',
  'issued_at': '2026-09-26T03:00:00Z',
  'expires_at': '2099-01-01T00:00:00Z',
  'attributes': <String, dynamic>{
    'map_visible': mapVisible,
    'operational_relevance': relevance,
  },
});
