import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart'
    show MapIconCatalog;

void main() {
  test('does not bundle the old static point snapshot', () async {
    await expectLater(
      rootBundle.loadString('assets/data/taiwan/static-features.json'),
      throwsA(isA<FlutterError>()),
    );
  });

  test('bundles the all-Taiwan offline road search asset', () async {
    final raw = await rootBundle.loadString(
      'assets/map/search/taiwan-roads.json',
    );

    expect(raw, contains('"dataset_id":"taiwan-roads"'));
    expect(raw, contains('"attribution":"© OpenStreetMap contributors"'));
  });

  testWidgets(
    'initial screen shows formatted update time and icon-only quick actions',
    (tester) async {
      await tester.pumpWidget(_testApp());
      await tester.pump();

      expect(find.text('更新時間：2026-9-5 00:00:00'), findsOneWidget);
      expect(find.text('資料快照：2026-09-05T00:00:00Z'), findsNothing);
      expect(find.text('目前位置：尚未取得'), findsOneWidget);
      final updateTime = tester.widget<Text>(
        find.text('更新時間：2026-9-5 00:00:00'),
      );
      expect(updateTime.maxLines, 1);
      expect(updateTime.softWrap, isFalse);
      expect(find.text('回報警示'), findsNothing);
      expect(find.text('推薦最近避難所'), findsNothing);
      expect(find.byTooltip('回報警示'), findsOneWidget);
      expect(find.byTooltip('推薦最近避難所'), findsOneWidget);
      expect(tester.getTopLeft(find.byTooltip('回報警示')).dx, greaterThan(200));
      expect(tester.getTopLeft(find.byTooltip('推薦最近避難所')).dx, greaterThan(200));
      expect(find.byIcon(LucideIcons.mapPinHouse), findsOneWidget);
      expect(find.byIcon(MapIconCatalog.shelter), findsNothing);
      expect(find.byIcon(Icons.near_me), findsNothing);
      expect(
        tester.getRect(find.byTooltip('推薦最近避難所')).left,
        greaterThan(tester.getRect(find.byTooltip('回報警示')).right),
      );
      expect(find.text('離線地圖可用'), findsNothing);
      expect(find.text('Protomaps 台灣離線底圖'), findsNothing);
      expect(find.text('模擬事件，非即時官方災情'), findsNothing);
      expect(find.byIcon(Icons.layers_outlined), findsOneWidget);
      expect(find.bySemanticsLabel('圖層設定'), findsOneWidget);
    },
  );

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

    await tester.pumpWidget(_testApp(failed: true));
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('static-features-failed')),
      findsOneWidget,
    );
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
  bool pending = false,
  bool failed = false,
}) => MaterialApp(
  home: MapScreen(
    staticFeatures: StaticFeatureCollection(
      schemaVersion: 'test',
      datasetId: 'test',
      snapshotAt: '2026-09-05T00:00:00Z',
      features: features,
    ),
    staticFeaturesPending: pending,
    staticFeaturesFailed: failed,
    initialState: const MapInitialState(
      events: <MeshEvent>[],
      emergencyModeEnabled: false,
    ),
  ),
);
