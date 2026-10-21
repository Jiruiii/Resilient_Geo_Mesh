import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';

void main() {
  const point = PointGeometry(
    GeoPoint(longitude: 121.590304, latitude: 25.083506),
  );

  testWidgets(
    'medical details offer walking route button with honest feedback',
    (tester) async {
      const medical = StaticFeature(
        id: 'medical:test',
        kind: 'medical',
        geometry: point,
        fields: <String, dynamic>{'name': '慈安診所'},
        properties: null,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FeatureDetailsSheet.feature(
              feature: medical,
              snapshotAt: null,
              onClose: () {},
            ),
          ),
        ),
      );

      final button = find.byKey(const ValueKey<String>('plan-walking-route'));
      expect(button, findsOneWidget);
      expect(find.text('規劃步行路線'), findsOneWidget);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.text('此地點的步行路線規劃尚未開放'), findsOneWidget);
    },
  );

  for (final eventType in <String>[
    'SUPPLY_STATUS',
    'GOVERNMENT_ANNOUNCEMENT',
  ]) {
    testWidgets('$eventType supply point offers walking route button', (
      tester,
    ) async {
      final event = MeshEvent(
        namespace:
            eventType == 'SUPPLY_STATUS'
                ? 'official.supply'
                : 'official.announcement',
        eventId: 'supply:test',
        eventVersion: 1,
        eventType: eventType,
        severity: 'LOW',
        source: 'GOVERNMENT',
        issuedAt: '2026-10-20T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        applyState: 'CURRENT',
        geometry: point,
        attributes: <String, dynamic>{
          if (eventType == 'GOVERNMENT_ANNOUNCEMENT')
            'category': 'SUPPLY_STATION',
          'name': '物資發放點',
          'status': 'AVAILABLE',
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FeatureDetailsSheet.event(event: event, onClose: () {}),
          ),
        ),
      );

      final button = find.byKey(const ValueKey<String>('plan-walking-route'));
      expect(button, findsOneWidget);
      expect(find.text('規劃步行路線'), findsOneWidget);
      await tester.ensureVisible(button);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.text('此地點的步行路線規劃尚未開放'), findsOneWidget);
    });
  }

  testWidgets('unlocated medical entry has no walking route button', (
    tester,
  ) async {
    const medical = StaticFeature(
      id: 'medical:unlocated',
      kind: 'medical-directory',
      geometry: null,
      fields: <String, dynamic>{'name': '未定位診所'},
      properties: null,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.feature(
            feature: medical,
            snapshotAt: null,
            onClose: () {},
          ),
        ),
      ),
    );

    expect(find.text('規劃步行路線'), findsNothing);
  });
}
