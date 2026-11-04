import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
}
