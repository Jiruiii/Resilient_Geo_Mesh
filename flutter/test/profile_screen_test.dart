import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/screens/profile_screen.dart';

void main() {
  testWidgets('profile keeps preferences without a basemap picker', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ProfileScreen(
          themeMode: ThemeMode.system,
          animationEnabled: true,
          onThemeModeChanged: (_) {},
          onAnimationChanged: (_) {},
        ),
      ),
    );

    expect(find.text('地圖底圖'), findsNothing);
    expect(find.byType(DropdownButtonFormField<ThemeMode>), findsOneWidget);
  });
}
