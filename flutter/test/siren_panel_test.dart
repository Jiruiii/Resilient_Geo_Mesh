import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/siren_controller.dart';
import 'package:resilientgeo_flutter/widgets/siren_panel.dart';

import 'support/fake_siren_platform.dart';

void main() {
  testWidgets('idle shows the explicit start button and the 119 disclaimer', (tester) async {
    final controller = SirenController(FakeSirenPlatform());
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    expect(find.byKey(const ValueKey<String>('siren-start')), findsOneWidget);
    expect(find.text('發出定位警報聲'), findsOneWidget);
    expect(find.text('此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('playing shows a full-width stop button', (tester) async {
    final platform = FakeSirenPlatform();
    final controller = SirenController(platform);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    await tester.tap(find.byKey(const ValueKey<String>('siren-start')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('siren-stop')), findsOneWidget);
    expect(find.text('停止警報'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('siren-stop')));
    await tester.pump();
    expect(platform.stops, 1);
    controller.dispose();
  });

  testWidgets('the web build states its background limitation', (tester) async {
    final controller = SirenController(FakeSirenPlatform(isWeb: true));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SirenPanel(controller: controller))));
    expect(find.text('瀏覽器在背景分頁或鎖屏時不保證持續播放；無法偵測系統音量，請確認裝置未靜音。'), findsOneWidget);
    controller.dispose();
  });
}
