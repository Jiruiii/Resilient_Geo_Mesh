import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';
import 'package:resilientgeo_flutter/widgets/map_zoom_controls.dart';

void main() {
  test('MapLibre marker catalog uses Lucide app-owned icons', () {
    expect(MapIconCatalog.disaster, LucideIcons.triangleAlert);
    expect(MapIconCatalog.expiredEvent, LucideIcons.clock3);
    expect(MapIconCatalog.shelter, LucideIcons.house);
    expect(MapIconCatalog.shelterRecommendation, LucideIcons.mapPinHouse);
    expect(MapIconCatalog.medical, LucideIcons.hospital);
  });

  testWidgets('percentage control exposes 0, 50, and 100 percent', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 0,
            onZoomPercentageChanged: (_) {},
          ),
        ),
      ),
    );
    expect(find.text('縮放 0%'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 50,
            onZoomPercentageChanged: (_) {},
          ),
        ),
      ),
    );
    expect(find.text('縮放 50%'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 100,
            onZoomPercentageChanged: (_) {},
          ),
        ),
      ),
    );
    expect(find.text('縮放 100%'), findsOneWidget);
  });

  testWidgets('percentage slider supports one percent steps', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 5,
            onZoomPercentageChanged: (_) {},
          ),
        ),
      ),
    );

    final slider = tester.widget<Slider>(find.byType(Slider));
    expect(slider.divisions, 100);
  });

  testWidgets('plus and minus controls change the displayed percentage', (
    tester,
  ) async {
    var percentage = 50;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder:
                (context, setState) => MapZoomControls(
                  zoomPercentage: percentage,
                  onZoomPercentageChanged: (value) {
                    setState(() => percentage = value);
                  },
                ),
          ),
        ),
      ),
    );

    await tester.tap(find.byTooltip('放大'));
    await tester.pump();
    expect(find.text('縮放 60%'), findsOneWidget);

    await tester.tap(find.byTooltip('縮小'));
    await tester.pump();
    expect(find.text('縮放 50%'), findsOneWidget);
  });

  testWidgets('recenter control is labelled as the default view', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 0,
            onZoomPercentageChanged: (_) {},
            onRecenter: () {},
          ),
        ),
      ),
    );

    expect(find.byTooltip('回到預設'), findsOneWidget);
    expect(find.byTooltip('回到內湖範圍'), findsNothing);
  });

  testWidgets('zoom controls do not duplicate the map attribution control', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapZoomControls(
            zoomPercentage: 0,
            onZoomPercentageChanged: (_) {},
          ),
        ),
      ),
    );

    expect(find.byTooltip('地圖來源與授權'), findsNothing);
    expect(find.textContaining('OpenStreetMap contributors'), findsNothing);
  });
}
