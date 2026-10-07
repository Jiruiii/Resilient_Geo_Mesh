import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_runtime_state.dart';
import 'package:resilientgeo_flutter/data/maplibre_map_config.dart';
import 'package:resilientgeo_flutter/widgets/map_canvas.dart';

void main() {
  testWidgets('keyboard changes keep the style; theme changes replace it', (
    tester,
  ) async {
    final loads = <String, int>{};
    rootBundle.clear();
    tester.binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      (message) async {
        final asset = utf8.decode(
          message!.buffer.asUint8List(
            message.offsetInBytes,
            message.lengthInBytes,
          ),
        );
        loads.update(asset, (count) => count + 1, ifAbsent: () => 1);
        final bytes = Uint8List.fromList(utf8.encode('{"sources":{}}'));
        return bytes.buffer.asByteData();
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMessageHandler(
        'flutter/assets',
        null,
      );
      rootBundle.clear();
    });

    Widget app({double keyboard = 0, ThemeMode theme = ThemeMode.light}) =>
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(viewInsets: EdgeInsets.only(bottom: keyboard)),
            child: MapCanvas(
              runtimeState: MapRuntimeState(
                themeMode: theme,
                zoomPercentage: 10,
                currentLocation: null,
                animationEnabled: false,
              ),
              staticFeatures: const [],
              visibleEvents: const [],
              showShelters: false,
              showMedical: false,
              showEvents: true,
              onStaticFeatureSelected: (_) {},
              onEventSelected: (_) {},
              onZoomPercentageChanged: (_) {},
              onOpenLayerSettings: () {},
              onRequestLocation: () {},
              onMapTap: () {},
            ),
          ),
        );

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(loads[MapLibreMapConfig.lightStyleAsset], 1);
    rootBundle.clear();
    await tester.pumpWidget(app(keyboard: 300));
    await tester.pumpAndSettle();
    expect(loads[MapLibreMapConfig.lightStyleAsset], 1);

    await tester.pumpWidget(app(theme: ThemeMode.dark));
    await tester.pumpAndSettle();
    expect(loads[MapLibreMapConfig.darkStyleAsset], 1);
  });

}
