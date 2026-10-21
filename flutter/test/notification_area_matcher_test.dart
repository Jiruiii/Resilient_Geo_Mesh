import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/notification_area_matcher.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';

void main() {
  final directory = _directory();

  test('county and town scopes match both administrative levels', () {
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{
          'affected_area_ids': <String>['tw.63000050'],
        }),
        <String>{'tw.63000'},
        directory,
      ),
      isTrue,
    );
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{
          'affected_area_ids': <String>['tw.63000'],
        }),
        <String>{'tw.63000050'},
        directory,
      ),
      isTrue,
    );
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{
          'affected_area_ids': <String>['tw.63000050'],
        }),
        <String>{'tw.63000060'},
        directory,
      ),
      isFalse,
    );
  });

  test(
    'nationwide notices match every selection and national selection matches all',
    () {
      final national = _event(<String, dynamic>{
        'affected_area_ids': <String>['tw.national'],
      });
      expect(
        eventMatchesNotificationAreas(national, <String>{
          'tw.65000',
        }, directory),
        isTrue,
      );
      expect(
        eventMatchesNotificationAreas(
          _event(<String, dynamic>{
            'affected_area_ids': <String>['tw.65000010'],
          }),
          <String>{'tw.national'},
          directory,
        ),
        isTrue,
      );
    },
  );

  test('legacy area_id is used when affected_area_ids is absent', () {
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{'area_id': 'tw.63000'}),
        <String>{'tw.63000050'},
        directory,
      ),
      isTrue,
    );
  });

  test('events with no resolvable area stay visible', () {
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{
          'affected_area_ids': <String>['tw.99999'],
        }),
        <String>{'tw.63000'},
        directory,
      ),
      isTrue,
    );
    expect(
      eventMatchesNotificationAreas(_event(const <String, dynamic>{}), <String>{
        'tw.63000',
      }, directory),
      isTrue,
    );
  });

  test('events with any unknown target area stay visible', () {
    expect(
      eventMatchesNotificationAreas(
        _event(<String, dynamic>{
          'affected_area_ids': <String>['tw.65000010', 'tw.99999'],
        }),
        <String>{'tw.63000050'},
        directory,
      ),
      isTrue,
    );
  });
}

TaiwanAdministrativeAreaDirectory _directory() =>
    TaiwanAdministrativeAreaDirectory.fromJson(<String, dynamic>{
      'schema_version': 'taiwan-area-directory-v1',
      'coverage': 'TW',
      'target_coordinate_system': 'EPSG:4326',
      'source_version': 'sha256:${'a' * 64}',
      'area_count': 5,
      'areas': <Map<String, dynamic>>[
        _area('tw.63000', 'county', '新北市', null, null),
        _area('tw.63000050', 'town', '新北市', '板橋區', 'tw.63000'),
        _area('tw.63000060', 'town', '新北市', '永和區', 'tw.63000'),
        _area('tw.65000', 'county', '高雄市', null, null),
        _area('tw.65000010', 'town', '高雄市', '鹽埕區', 'tw.65000'),
      ],
    });

Map<String, dynamic> _area(
  String id,
  String level,
  String county,
  String? town,
  String? parent,
) => <String, dynamic>{
  'area_id': id,
  'level': level,
  'parent_area_id': parent,
  'county_name': county,
  'town_name': town,
};

MeshEvent _event(Map<String, dynamic> attributes) => MeshEvent(
  namespace: 'official.announcement',
  eventId: 'notice:test',
  eventVersion: 1,
  eventType: 'GOVERNMENT_ANNOUNCEMENT',
  severity: 'MEDIUM',
  source: 'GOVERNMENT',
  issuedAt: '2026-10-21T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  applyState: null,
  geometry: null,
  attributes: attributes,
);
