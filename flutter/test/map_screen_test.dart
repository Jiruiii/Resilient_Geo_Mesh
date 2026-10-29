import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';
import 'package:resilientgeo_flutter/widgets/map_canvas.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart'
    show MapIconCatalog;
import 'package:resilientgeo_flutter/widgets/map_zoom_controls.dart';

void main() {
  testWidgets(
    'verified warning area masks remain available while static data verifies',
    (tester) async {
      const warning = MeshEvent(
        namespace: 'official.ncdr',
        eventId: 'ncdr:wind:multi-area',
        eventVersion: 1,
        eventType: 'NCDR_HAZARD',
        severity: 'MEDIUM',
        source: 'NCDR',
        issuedAt: '2026-10-20T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        applyState: 'CURRENT',
        geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
          <List<GeoPoint>>[
            <GeoPoint>[
              GeoPoint(longitude: 120, latitude: 23),
              GeoPoint(longitude: 121, latitude: 23),
              GeoPoint(longitude: 120, latitude: 23),
            ],
          ],
        ]),
        attributes: <String, dynamic>{
          'geometry_source': 'administrative_boundary',
          'affected_area_count': 55,
          'area_match_complete': true,
          'map_visible': true,
          'ncdr_category_code': 'strong_wind',
          'ncdr_category_label': '強風',
        },
      );

      await tester.pumpWidget(
        _testApp(pending: true, events: const <MeshEvent>[warning]),
      );
      await tester.pump();

      final map = tester.widget<MapCanvas>(find.byType(MapCanvas));
      expect(map.visibleEvents, isEmpty);
      expect(map.areaWarnings, <MeshEvent>[warning]);
      expect(map.showCountyWarningAreas, isTrue);
    },
  );

  test('does not bundle the old static point snapshot', () async {
    await expectLater(
      rootBundle.loadString('assets/data/taiwan/static-features.json'),
      throwsA(isA<FlutterError>()),
    );
  });

  test('bundles the all-Taiwan offline road search asset', () async {
    // Decoding the whole 42 MB index as a string times out on CI runners;
    // the identity and attribution fields sit at the start of the file.
    final bytes = await rootBundle.load('assets/map/search/taiwan-roads.json');
    final header = utf8.decode(
      bytes.buffer.asUint8List(
        bytes.offsetInBytes,
        bytes.lengthInBytes < 1024 ? bytes.lengthInBytes : 1024,
      ),
      allowMalformed: true,
    );

    expect(bytes.lengthInBytes, greaterThan(1024 * 1024));
    expect(header, contains('"dataset_id":"taiwan-roads"'));
    expect(header, contains('"attribution":"© OpenStreetMap contributors"'));
  });

  testWidgets(
    'initial screen shows the latest verified update time without facility totals',
    (tester) async {
      await tester.pumpWidget(_testApp());
      await tester.pump();

      final updateText = find.text('資料更新：2026/09/3 10:00:32');
      expect(updateText, findsOneWidget);
      final statusPanel =
          find
              .ancestor(of: updateText, matching: find.byType(DecoratedBox))
              .first;
      expect(
        tester.getRect(statusPanel).width - tester.getRect(updateText).width,
        lessThan(48),
      );
      expect(find.text('資料快照：2026-09-05T00:00:00Z'), findsNothing);
      expect(find.text('目前位置：尚未取得'), findsOneWidget);
      expect(find.textContaining('全臺院所／避難所'), findsNothing);
      expect(find.text('回報警示'), findsNothing);
      expect(find.text('推薦最近避難所'), findsNothing);
      expect(find.byTooltip('回報警示'), findsOneWidget);
      expect(find.byTooltip('推薦最近避難所'), findsOneWidget);
      expect(tester.getTopLeft(find.byTooltip('回報警示')).dx, greaterThan(200));
      expect(tester.getTopLeft(find.byTooltip('推薦最近避難所')).dx, greaterThan(200));
      final rescueAction = tester.getRect(find.byTooltip('需要救援'));
      final reportAction = tester.getRect(find.byTooltip('回報警示'));
      final shelterAction = tester.getRect(find.byTooltip('推薦最近避難所'));
      expect(rescueAction.left, reportAction.left);
      expect(reportAction.left, shelterAction.left);
      expect(rescueAction.top, lessThan(reportAction.top));
      expect(reportAction.top, lessThan(shelterAction.top));
      expect(find.byIcon(LucideIcons.mapPinHouse), findsOneWidget);
      expect(find.byIcon(MapIconCatalog.shelter), findsNothing);
      expect(find.byIcon(Icons.near_me), findsNothing);
      expect(find.text('離線地圖可用'), findsNothing);
      expect(find.text('Protomaps 台灣離線底圖'), findsNothing);
      expect(find.text('模擬事件，非即時官方災情'), findsNothing);
      expect(find.byIcon(Icons.layers_outlined), findsOneWidget);
      expect(find.bySemanticsLabel('圖層設定'), findsOneWidget);
      expect(
        find.text('© OpenStreetMap contributors · Protomaps'),
        findsNothing,
      );
    },
  );

  testWidgets('lower-left scenario control only shows the settings icon', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());
    await tester.pump();

    final collapsedSurface = find.byKey(
      const ValueKey<String>('evacuation-disaster-context-control'),
    );
    final iconKey = find.byKey(
      const ValueKey<String>('evacuation-context-collapsed'),
    );
    expect(find.textContaining('避難情境'), findsNothing);
    expect(
      find.descendant(of: collapsedSurface, matching: find.byType(IconButton)),
      findsOneWidget,
    );
    final iconSurface = tester.widget<Material>(collapsedSurface);
    expect(
      iconSurface.color,
      Theme.of(
        tester.element(iconKey),
      ).colorScheme.surface.withValues(alpha: 0.94),
    );
    await tester.tap(iconKey);
    await tester.pumpAndSettle();

    expect(find.text('圖層設定'), findsOneWidget);
  });

  testWidgets('evacuation scenario control stays at the lower left on mobile', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_testApp());
    await tester.pump();

    final scenario = tester.getRect(
      find.byKey(const ValueKey<String>('evacuation-disaster-context-control')),
    );
    final zoomControls = tester.getRect(find.byType(MapZoomControls));
    expect(scenario.left, lessThan(24));
    expect(scenario.bottom, greaterThan(600));
    expect(scenario.bottom, lessThan(844 - 40));
    expect(scenario.right, lessThanOrEqualTo(zoomControls.left));
  });

  testWidgets('opens the map directly without a basemap selection screen', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());
    await tester.pump();

    expect(find.text('選擇離線底圖'), findsNothing);
    expect(find.text('NLSC 臺灣通用電子地圖'), findsNothing);
    expect(find.bySemanticsLabel('搜尋地點'), findsOneWidget);
  });

  testWidgets('offline map controls remain available at 390dp width', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_testApp());
    await tester.pump();

    expect(find.bySemanticsLabel('搜尋地點'), findsOneWidget);
    expect(find.bySemanticsLabel('圖層設定'), findsOneWidget);
    expect(tester.takeException(), isNull);

    final rescue = tester.getRect(_byKey('open-rescue-request'));
    final recommend = tester.getRect(_byKey('recommend-nearest-shelter'));
    expect(recommend.top, greaterThan(rescue.bottom));
    expect(recommend.left, rescue.left);
  });

  testWidgets('quick actions line up above the zoom panel in landscape', (
    tester,
  ) async {
    // Pixel 8a landscape map area below the status bar and bottom navigation.
    await tester.binding.setSurfaceSize(const Size(915, 300));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_testApp());
    await tester.pump();

    expect(tester.takeException(), isNull);
    final rescue = tester.getRect(_byKey('open-rescue-request'));
    final recommend = tester.getRect(_byKey('recommend-nearest-shelter'));
    final zoomControls = tester.getRect(find.byType(MapZoomControls));
    expect(recommend.top, rescue.top);
    expect(recommend.left, greaterThan(rescue.right));
    expect(recommend.bottom, lessThan(zoomControls.top));
  });

  testWidgets('shows shelter verification progress and accepts late layers', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp(pending: true));
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('static-features-pending')),
      findsOneWidget,
    );
    expect(find.text('資料更新：載入中'), findsOneWidget);

    // Android finishes verifying: the new collection replaces the empty one.
    await tester.pumpWidget(
      _testApp(
        features: <StaticFeature>[
          StaticFeature.fromJson(<String, dynamic>{
            'id': 'shelter:5582',
            'kind': 'shelter',
            'name': 'Xihu Elementary',
            'geometry': <String, dynamic>{
              'type': 'Point',
              'coordinates': <double>[121.5657, 25.0838],
            },
          }),
        ],
      ),
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('static-features-pending')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(_testApp(failed: true, snapshotAt: null));
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('static-features-failed')),
      findsOneWidget,
    );
    expect(find.text('資料更新：無資料'), findsOneWidget);
  });

  testWidgets('layer settings does not expose the bundled fixture loader', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp());
    await tester.pump();

    await tester.tap(find.bySemanticsLabel('圖層設定'));
    await tester.pumpAndSettle();

    expect(find.text('載入內建 fixture'), findsNothing);
  });
}

Widget _testApp({
  List<StaticFeature> features = const <StaticFeature>[],
  List<MeshEvent> events = const <MeshEvent>[],
  bool pending = false,
  bool failed = false,
  String? snapshotAt = '2026-09-03T02:00:32Z',
}) => MaterialApp(
  home: MapScreen(
    staticFeatures: StaticFeatureCollection(
      schemaVersion: 'test',
      datasetId: 'test',
      snapshotAt: snapshotAt,
      features: features,
    ),
    staticFeaturesPending: pending,
    staticFeaturesFailed: failed,
    initialState: MapInitialState(events: events, emergencyModeEnabled: false),
  ),
);

Finder _byKey(String key) => find.byKey(ValueKey<String>(key));
