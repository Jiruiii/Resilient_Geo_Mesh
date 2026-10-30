import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/debug/mesh_drill_app.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';
import 'package:resilientgeo_flutter/widgets/map_zoom_controls.dart';

void main() {
  test(
    'explains the disabled load buttons only while a drill sync is running',
    () {
      final hint = drillRunningHint(running: true);
      expect(hint, contains('停止演練同步'));
      expect(hint, contains('無法載入'));
      expect(drillRunningHint(running: false), isNull);
    },
  );

  for (final size in const <Size>[Size(412, 890), Size(914, 387)]) {
    testWidgets('drill map keeps the recommend action reachable at $size', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(size);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(const MaterialApp(home: MeshDrillScreen()));
      await tester.pump();

      expect(tester.takeException(), isNull);
      final recommend = find.byKey(
        const ValueKey<String>('recommend-nearest-shelter'),
      );
      final button = tester.getRect(recommend);
      expect(button.bottom, lessThanOrEqualTo(size.height));
      expect(
        button.bottom,
        lessThan(tester.getRect(find.byType(MapZoomControls)).top),
      );
      // Unmount so the drill's status timer is cancelled.
      await tester.pumpWidget(const SizedBox());
    });
  }
  testWidgets('rotating keeps the drill map state', (tester) async {
    await tester.binding.setSurfaceSize(const Size(412, 890));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(const MaterialApp(home: MeshDrillScreen()));
    await tester.pump();
    final before = tester.state(find.byType(MapScreen));

    await tester.binding.setSurfaceSize(const Size(914, 387));
    await tester.pump();

    expect(tester.state(find.byType(MapScreen)), same(before));
    await tester.pumpWidget(const SizedBox());
  });
}
