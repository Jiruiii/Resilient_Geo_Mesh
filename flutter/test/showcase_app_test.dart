import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_basemap.dart';
import 'package:resilientgeo_flutter/screens/profile_screen.dart';
import 'package:resilientgeo_flutter/showcase/showcase_app.dart';
import 'package:resilientgeo_flutter/showcase/showcase_scenario.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('shows the fixed road alert ten seconds after opening', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await ShowcaseScenario.load();
    });
    await tester.pumpWidget(const ShowcaseApp());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    final navigation = find.byType(NavigationBar);
    for (
      var attempt = 0;
      attempt < 20 && navigation.evaluate().isEmpty;
      attempt += 1
    ) {
      await tester.pump();
    }
    expect(navigation, findsOneWidget);

    expect(
      find.descendant(of: navigation, matching: find.text('3')),
      findsOneWidget,
    );

    await tester.pump(const Duration(seconds: 9));
    expect(
      find.descendant(of: navigation, matching: find.text('3')),
      findsOneWidget,
    );

    await tester.pump(const Duration(seconds: 1));
    expect(
      find.descendant(of: navigation, matching: find.text('4')),
      findsOneWidget,
    );
    expect(find.text('康寧路二段道路封閉'), findsOneWidget);
    expect(find.text('設施資料：歷史範例'), findsNothing);

    await tester.tap(find.text('個人'));
    await tester.pump(const Duration(milliseconds: 300));
    final reset = find.byKey(const ValueKey<String>('showcase-reset'));
    expect(reset, findsOneWidget);
    await tester.tap(reset);
    await tester.pump();
    expect(
      find.descendant(of: navigation, matching: find.text('3')),
      findsOneWidget,
    );
    await tester.pump(const Duration(seconds: 9));
    expect(
      find.descendant(of: navigation, matching: find.text('3')),
      findsOneWidget,
    );
    await tester.pump(const Duration(seconds: 1));
    expect(
      find.descendant(of: navigation, matching: find.text('4')),
      findsOneWidget,
    );
  });

  testWidgets('a new road alert replaces an open route sheet', (tester) async {
    await tester.runAsync(() async {
      await ShowcaseScenario.load();
    });
    await tester.pumpWidget(const ShowcaseApp());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    final navigation = find.byType(NavigationBar);
    for (
      var attempt = 0;
      attempt < 20 && navigation.evaluate().isEmpty;
      attempt += 1
    ) {
      await tester.pump();
    }
    expect(navigation, findsOneWidget);

    final recommend = find.byKey(
      const ValueKey<String>('recommend-nearest-shelter'),
    );
    for (
      var attempt = 0;
      attempt < 20 && recommend.evaluate().isEmpty;
      attempt += 1
    ) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(recommend, findsOneWidget);
    await tester.tap(recommend);
    for (var attempt = 0; attempt < 10; attempt += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('逃生路線'), findsOneWidget);

    await tester.pump(const Duration(seconds: 10));
    for (var attempt = 0; attempt < 10; attempt += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(find.text('逃生路線'), findsNothing);
    expect(find.text('康寧路二段道路封閉'), findsOneWidget);

    await tester.tap(find.byTooltip('關閉詳情'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(recommend);
    for (var attempt = 0; attempt < 10; attempt += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('逃生路線'), findsOneWidget);
    expect(find.text('距離：447 公尺'), findsOneWidget);
    expect(find.text('前方道路封閉，已自動繞行'), findsOneWidget);
  });

  testWidgets('basemap selection stays in sync between profile and map', (
    tester,
  ) async {
    await _pumpShowcase(tester, basemapProbe: () async => true);

    await _openProfileBasemapSelector(tester);
    expect(find.text('自動'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('國土測繪圖資｜').last);
    await tester.pumpAndSettle();
    expect(find.text('國土測繪圖資'), findsOneWidget);

    await tester.tap(find.text('首頁'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.bySemanticsLabel('圖層設定'));
    await tester.pumpAndSettle();
    expect(find.text('國土測繪圖資'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('離線 OSM｜').last);
    await tester.pumpAndSettle();
    expect(find.text('離線 OSM'), findsOneWidget);
    Navigator.of(
      tester.element(find.byKey(const ValueKey<String>('basemap-selector'))),
    ).pop();
    await tester.pumpAndSettle();

    await _openProfileBasemapSelector(tester);
    expect(find.text('離線 OSM'), findsOneWidget);
  });

  testWidgets('an unreachable NLSC tile falls back to OSM in EMAP mode', (
    tester,
  ) async {
    await _pumpShowcase(tester, basemapProbe: () async => false);
    await _openProfileBasemapSelector(tester);
    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('國土測繪圖資｜').last);
    await tester.pumpAndSettle();

    expect(find.text('國土測繪圖資'), findsOneWidget);
    expect(find.textContaining('目前：離線 OSM'), findsOneWidget);
  });

  testWidgets('a thrown NLSC probe error falls back to OSM', (tester) async {
    await _pumpShowcase(
      tester,
      basemapProbe: () async => throw StateError('NLSC unavailable'),
    );
    await _openProfileBasemapSelector(tester);

    expect(find.text('自動'), findsOneWidget);
    expect(find.textContaining('目前：離線 OSM'), findsOneWidget);
  });

  testWidgets('OSM mode stops NLSC probes until an online mode is selected', (
    tester,
  ) async {
    var probeCount = 0;
    await _pumpShowcase(
      tester,
      basemapProbe: () async {
        probeCount += 1;
        return false;
      },
    );
    expect(probeCount, 1);

    await _openProfileBasemapSelector(tester);
    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('離線 OSM｜').last);
    await tester.pumpAndSettle();
    expect(probeCount, 1);

    await tester.pump(MapBasemap.probeInterval + const Duration(seconds: 1));
    expect(probeCount, 1);

    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('自動｜').last);
    await tester.pumpAndSettle();
    expect(probeCount, 2);
  });

  testWidgets('reset returns the showcase basemap to auto', (tester) async {
    var probeCount = 0;
    await _pumpShowcase(
      tester,
      basemapProbe: () async {
        probeCount += 1;
        return false;
      },
    );
    await _openProfileBasemapSelector(tester);
    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('離線 OSM｜').last);
    await tester.pumpAndSettle();

    final profileScroll = find.descendant(
      of: find.byType(ProfileScreen),
      matching: find.byType(Scrollable),
    );
    await tester.drag(profileScroll.first, const Offset(0, 1000));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('showcase-reset')));
    await tester.pump();
    expect(probeCount, 2);
    await _openProfileBasemapSelector(tester);
    expect(find.text('自動'), findsOneWidget);
  });

  testWidgets('switching the basemap preserves an open evacuation route', (
    tester,
  ) async {
    await _pumpShowcase(tester, basemapProbe: () async => false);
    final recommend = find.byKey(
      const ValueKey<String>('recommend-nearest-shelter'),
    );
    for (
      var attempt = 0;
      attempt < 20 && recommend.evaluate().isEmpty;
      attempt += 1
    ) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(recommend, findsOneWidget);
    await tester.tap(recommend);
    for (var attempt = 0; attempt < 10; attempt += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('逃生路線'), findsOneWidget);

    await _openProfileBasemapSelector(tester);
    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('離線 OSM｜').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('首頁'));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('逃生路線'), findsOneWidget);
    expect(find.text('距離：334 公尺'), findsOneWidget);
  });
}

Future<void> _pumpShowcase(
  WidgetTester tester, {
  required EmapReachabilityProbe basemapProbe,
}) async {
  await tester.runAsync(() async {
    await ShowcaseScenario.load();
  });
  await tester.pumpWidget(ShowcaseApp(basemapProbe: basemapProbe));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 100)),
  );
  await tester.pump();
  final navigation = find.byType(NavigationBar);
  for (
    var attempt = 0;
    attempt < 20 && navigation.evaluate().isEmpty;
    attempt += 1
  ) {
    await tester.pump();
  }
  expect(navigation, findsOneWidget);
}

Future<void> _openProfileBasemapSelector(WidgetTester tester) async {
  await tester.tap(find.text('個人'));
  await tester.pump(const Duration(milliseconds: 300));
  final profileScroll = find.descendant(
    of: find.byType(ProfileScreen),
    matching: find.byType(Scrollable),
  );
  await tester.scrollUntilVisible(
    find.byKey(const ValueKey<String>('basemap-selector')),
    400,
    scrollable: profileScroll.first,
  );
}
