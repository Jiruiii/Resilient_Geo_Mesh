import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';

void main() {
  testWidgets('government announcement details show impact area names', (
    tester,
  ) async {
    final directory = TaiwanAdministrativeAreaDirectory.fromJson(
      <String, dynamic>{
        'schema_version': 'taiwan-area-directory-v1',
        'coverage': 'TW',
        'target_coordinate_system': 'EPSG:4326',
        'source_version': 'sha256:${'a' * 64}',
        'area_count': 2,
        'areas': <Map<String, dynamic>>[
          <String, dynamic>{
            'area_id': 'tw.65000',
            'level': 'county',
            'parent_area_id': null,
            'county_name': '新北市',
            'town_name': null,
          },
          <String, dynamic>{
            'area_id': 'tw.65000040',
            'level': 'town',
            'parent_area_id': 'tw.65000',
            'county_name': '新北市',
            'town_name': '永和區',
          },
        ],
      },
    );
    final event = MeshEvent(
      namespace: 'official.announcement',
      eventId: 'announcement:detail-area',
      eventVersion: 1,
      eventType: 'GOVERNMENT_ANNOUNCEMENT',
      severity: 'MEDIUM',
      source: 'GOVERNMENT',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: null,
      geometry: null,
      attributes: const <String, dynamic>{
        'title': '避難收容資訊',
        'category': 'SHELTER',
        'area_id': 'tw.national',
        'affected_area_ids': <String>['tw.65000040'],
        'content': '前往指定收容處所',
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: FeatureDetailsSheet.event(
              event: event,
              areaDirectory: directory,
              onClose: () {},
            ),
          ),
        ),
      ),
    );

    expect(find.textContaining('影響範圍：新北市 永和區'), findsOneWidget);
  });
}
