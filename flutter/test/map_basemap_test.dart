import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/map_app_controller.dart';
import 'package:resilientgeo_flutter/data/map_basemap.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/maplibre_map_config.dart';
import 'package:resilientgeo_flutter/data/offline_map_asset_store.dart';
import 'package:resilientgeo_flutter/widgets/basemap_selector.dart';
import 'package:resilientgeo_flutter/widgets/layer_filter_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  group('MapBasemap style injection', () {
    const baseStyle = '''
{"version":8,"sources":{"taiwan-overview":{"type":"vector","url":"pmtiles://asset://assets/map/pmtiles/taiwan.pmtiles"}},
 "layers":[{"id":"taiwan-background","type":"background"},{"id":"taiwan-roads","type":"line","source":"taiwan-overview"},
 {"id":"taiwan-road-labels","type":"symbol","source":"taiwan-overview"}]}''';

    Map<String, dynamic> inject({required bool dark}) =>
        jsonDecode(MapBasemap.injectEmapLayer(baseStyle, dark: dark))
            as Map<String, dynamic>;

    test('adds a hidden NLSC raster above every OSM layer', () {
      final style = inject(dark: false);
      final source =
          (style['sources'] as Map<String, dynamic>)[MapBasemap.emapSourceId]
              as Map<String, dynamic>;
      expect(source['type'], 'raster');
      expect(source['tiles'], <String>[MapBasemap.emapTileTemplate]);
      expect(source['tileSize'], 256);
      expect(source['attribution'], '© 內政部國土測繪中心');
      expect(source['bounds'], MapBasemap.emapBounds);

      final layers = (style['layers'] as List).cast<Map<String, dynamic>>();
      expect(layers.map((layer) => layer['id']), <String>[
        'taiwan-background',
        'taiwan-roads',
        'taiwan-road-labels',
        MapBasemap.emapLayerId,
      ]);
      expect(layers.last['layout'], <String, String>{'visibility': 'none'});
      expect(layers.last['paint'], isEmpty);
      // OSM sources stay untouched so offline rendering is unchanged.
      expect(
        (style['sources'] as Map<String, dynamic>)['taiwan-overview'],
        <String, String>{
          'type': 'vector',
          'url': 'pmtiles://asset://assets/map/pmtiles/taiwan.pmtiles',
        },
      );
    });

    test('dark styles invert the raster instead of using a second source', () {
      final paint =
          ((inject(dark: true)['layers'] as List).last
                  as Map<String, dynamic>)['paint']
              as Map<String, dynamic>;
      expect(
        paint['raster-brightness-min'] as num,
        greaterThan(paint['raster-brightness-max'] as num),
      );
      expect(paint['raster-hue-rotate'], 180);
    });

    test('injecting twice keeps a single EMAP layer', () {
      final once = MapBasemap.injectEmapLayer(baseStyle, dark: false);
      final twice =
          jsonDecode(MapBasemap.injectEmapLayer(once, dark: true))
              as Map<String, dynamic>;
      final ids = (twice['layers'] as List).map(
        (layer) => (layer as Map)['id'],
      );
      expect(ids.where((id) => id == MapBasemap.emapLayerId), hasLength(1));
    });

    test('bundled light and dark styles both receive the layer', () async {
      for (final asset in <String>[
        MapLibreMapConfig.lightStyleAsset,
        MapLibreMapConfig.darkStyleAsset,
      ]) {
        final style =
            jsonDecode(
                  await OfflineMapAssetStore().loadStyle(
                    styleAsset: asset,
                    installNativeAssets: false,
                  ),
                )
                as Map<String, dynamic>;
        final layers = (style['layers'] as List).cast<Map<String, dynamic>>();
        expect(layers.last['id'], MapBasemap.emapLayerId, reason: asset);
        expect(
          (layers.last['paint'] as Map).isNotEmpty,
          asset == MapLibreMapConfig.darkStyleAsset,
          reason: asset,
        );
        expect(
          layers.where((layer) => layer['id'] == 'taiwan-roads'),
          hasLength(1),
          reason: asset,
        );
      }
    });
  });

  group('MapBasemapMode', () {
    test('visibility follows mode and reachability', () {
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.auto, emapReachable: true),
        isTrue,
      );
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.auto, emapReachable: false),
        isFalse,
      );
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.emap, emapReachable: false),
        isFalse,
      );
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.osm, emapReachable: true),
        isFalse,
      );
    });

    test('before the first probe auto waits on OSM and EMAP mode starts on EMAP', () {
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.auto, emapReachable: null),
        isFalse,
      );
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.emap, emapReachable: null),
        isTrue,
      );
      expect(
        MapBasemap.emapVisible(mode: MapBasemapMode.emap, emapReachable: true),
        isTrue,
      );
    });

    test('unknown stored names fall back to auto', () {
      expect(MapBasemapMode.fromName(null), MapBasemapMode.auto);
      expect(MapBasemapMode.fromName('bogus'), MapBasemapMode.auto);
      expect(MapBasemapMode.fromName('emap'), MapBasemapMode.emap);
      expect(MapBasemapMode.fromName('osm'), MapBasemapMode.osm);
    });
  });

  group('MapAppController base map', () {
    test('auto mode probes NLSC and re-probes when the app resumes', () async {
      var reachable = true;
      var probes = 0;
      var notifications = 0;
      final controller = MapAppController(
        bridge: _EmptyVerifiedBridge(),
        emapProbe: () async {
          probes += 1;
          return reachable;
        },
      );
      addTearDown(controller.dispose);
      await controller.load();
      await pumpEventQueue();
      expect(controller.basemapMode, MapBasemapMode.auto);
      expect(probes, 1);
      expect(controller.emapReachable, isTrue);
      expect(controller.emapVisible, isTrue);

      controller.addListener(() => notifications += 1);
      reachable = false;
      controller.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(probes, 2);
      expect(controller.emapVisible, isFalse);
      expect(notifications, greaterThan(0));
    });

    test('EMAP mode falls back to OSM offline; OSM mode never probes', () async {
      var reachable = false;
      var probes = 0;
      final controller = MapAppController(
        bridge: _EmptyVerifiedBridge(),
        emapProbe: () async {
          probes += 1;
          return reachable;
        },
      );
      addTearDown(controller.dispose);
      await controller.load();
      await pumpEventQueue();
      expect(probes, 1);

      // Offline: the forced EMAP mode also shows OSM.
      await controller.setBasemapMode(MapBasemapMode.emap);
      await pumpEventQueue();
      expect(probes, 2);
      expect(controller.emapVisible, isFalse);

      reachable = true;
      controller.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(probes, 3);
      expect(controller.emapVisible, isTrue);

      await controller.setBasemapMode(MapBasemapMode.osm);
      controller.didChangeAppLifecycleState(AppLifecycleState.resumed);
      controller.refreshEmapReachability();
      await pumpEventQueue();
      expect(probes, 3);
      expect(controller.emapVisible, isFalse);
      final preferences = await SharedPreferences.getInstance();
      expect(preferences.getString('map.basemap_mode'), 'osm');

      await controller.setBasemapMode(MapBasemapMode.auto);
      await pumpEventQueue();
      expect(probes, 4);
    });

    test('camera settles re-probe unless offline OSM and are throttled', () async {
      var probes = 0;
      final controller = MapAppController(
        bridge: _EmptyVerifiedBridge(),
        emapProbe: () async {
          probes += 1;
          return true;
        },
      );
      addTearDown(controller.dispose);
      await controller.load();
      await pumpEventQueue();
      expect(probes, 1);

      // Just probed: a camera settle inside the throttle window is skipped.
      controller.refreshEmapReachability();
      await pumpEventQueue();
      expect(probes, 1);

      await controller.setBasemapMode(MapBasemapMode.osm);
      controller.refreshEmapReachability();
      await pumpEventQueue();
      expect(probes, 1);
    });

    test('a slow probe finishing after dispose is ignored', () async {
      final controller = MapAppController(
        bridge: _EmptyVerifiedBridge(),
        emapProbe: () => Future<bool>.delayed(Duration.zero, () => true),
      );
      await controller.load();
      controller.dispose();
      await pumpEventQueue();
      expect(controller.emapReachable, isNull);
    });

    test('restores a stored mode on load', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'map.basemap_mode': 'osm',
      });
      var probes = 0;
      final controller = MapAppController(
        bridge: _EmptyVerifiedBridge(),
        emapProbe: () async {
          probes += 1;
          return true;
        },
      );
      addTearDown(controller.dispose);
      await controller.load();
      expect(controller.basemapMode, MapBasemapMode.osm);
      expect(controller.emapVisible, isFalse);
      expect(probes, 0);
    });
  });

  group('BasemapSelector', () {
    testWidgets('layer panel switches the base map', (tester) async {
      MapBasemapMode? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LayerFilterPanel(
              showShelters: true,
              showMedical: true,
              showEvents: true,
              showCountyWarningAreas: true,
              emergencyModeEnabled: false,
              onSheltersChanged: (_) {},
              onMedicalChanged: (_) {},
              onEventsChanged: (_) {},
              onCountyWarningAreasChanged: (_) {},
              onEmergencyModeChanged: (_) {},
              basemapMode: MapBasemapMode.auto,
              emapVisible: true,
              onBasemapModeChanged: (mode) => selected = mode,
            ),
          ),
        ),
      );

      expect(find.byType(BasemapSelector), findsOneWidget);
      expect(find.textContaining('目前：國土測繪圖資'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('離線 OSM｜').last);
      await tester.pumpAndSettle();
      expect(selected, MapBasemapMode.osm);
    });

    testWidgets('layer panel hides the selector without a callback', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LayerFilterPanel(
              showShelters: true,
              showMedical: true,
              showEvents: true,
              showCountyWarningAreas: true,
              emergencyModeEnabled: false,
              onSheltersChanged: (_) {},
              onMedicalChanged: (_) {},
              onEventsChanged: (_) {},
              onCountyWarningAreasChanged: (_) {},
              onEmergencyModeChanged: (_) {},
            ),
          ),
        ),
      );
      expect(find.byType(BasemapSelector), findsNothing);
    });
  });

  test('no other remote tile host is introduced', () {
    expect(Uri.parse(MapBasemap.emapTileTemplate).host, 'wmts.nlsc.gov.tw');
    expect(MapBasemap.emapProbeUri.host, 'wmts.nlsc.gov.tw');
  });
}

class _EmptyVerifiedBridge extends MapBridge {
  @override
  Future<MapInitialState> getInitialState() async => const MapInitialState(
    events: <MeshEvent>[],
    emergencyModeEnabled: false,
    staticFeatures: <StaticFeature>[],
  );

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();
}