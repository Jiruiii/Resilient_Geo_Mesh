import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:resilientgeo_flutter/data/map_camera_projection.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/maplibre_map_config.dart';
import 'package:resilientgeo_flutter/data/map_zoom.dart';

void main() {
  group('MapLibreMapConfig', () {
    test('keeps the native collapsible attribution control at bottom left', () {
      expect(
        MapLibreMapConfig.attributionButtonPosition,
        AttributionButtonPosition.bottomLeft,
      );
    });

    test('uses the user location when it is available', () {
      const location = GeoPoint(longitude: 121.545053, latitude: 25.011549);

      final camera = MapLibreMapConfig.initialCamera(currentLocation: location);

      expect(camera.target, same(location));
      expect(camera.zoom, MapLibreMapConfig.locationZoom);
    });

    test(
      'starts at the initial Taiwan overview percentage when location is unavailable',
      () {
        final camera = MapLibreMapConfig.initialCamera();

        expect(camera.target, same(MapLibreMapConfig.taiwanOverviewCenter));
        expect(
          camera.zoom,
          ZoomPercentage.toZoom(
            percentage: MapLibreMapConfig.initialOverviewPercentage,
            minZoom: MapLibreMapConfig.minZoom,
            maxZoom: MapLibreMapConfig.maxZoom,
            overviewZoom: MapLibreMapConfig.overviewZoom,
          ),
        );
      },
    );

    test('recenter camera always targets the Taiwan overview', () {
      final camera = MapLibreMapConfig.taiwanOverviewCamera();

      expect(camera.target, same(MapLibreMapConfig.taiwanOverviewCenter));
      expect(camera.zoom, MapLibreMapConfig.overviewZoom);
    });

    test('selects local light and dark style assets', () {
      expect(
        MapLibreMapConfig.styleAssetFor(
          themeMode: ThemeMode.light,
          systemBrightness: Brightness.dark,
        ),
        'assets/map/styles/taiwan-light.json',
      );
      expect(
        MapLibreMapConfig.styleAssetFor(
          themeMode: ThemeMode.system,
          systemBrightness: Brightness.dark,
        ),
        'assets/map/styles/taiwan-dark.json',
      );
    });

    test('camera range permits z17 vector overzoom beyond the z15 package', () {
      expect(MapLibreMapConfig.minZoom, 5);
      expect(MapLibreMapConfig.maxZoom, 17);
      expect(MapLibreMapConfig.overviewZoom, 5);
      expect(MapLibreMapConfig.focusPercentage, 85);
      expect(MapLibreMapConfig.revealAllPercentage, 55);
      expect(MapLibreMapConfig.fullMarkerPercentage, 80);
    });

    test('Taiwan overview reports zero zoom percentage', () {
      expect(MapLibreMapConfig.overviewPercentage, 0);
      expect(MapLibreMapConfig.initialOverviewPercentage, 10);
    });

    test('Taiwan camera bounds include Taipei and exclude distant targets', () {
      expect(
        MapLibreMapConfig.taiwanBounds.contains(
          const LatLng(25.011549, 121.545053),
        ),
        isTrue,
      );
      expect(
        MapLibreMapConfig.taiwanBounds.contains(const LatLng(35, 139)),
        isFalse,
      );
    });

    test('Taiwan overview includes the northern outlying islands', () {
      final bounds = MapLibreMapConfig.taiwanOverviewBounds;

      expect(bounds.southwest, const LatLng(21.5, 118.0));
      expect(bounds.northeast, const LatLng(26.5, 122.2));
      expect(bounds.contains(const LatLng(26.2, 121.0)), isTrue);
    });

    test('Taiwan camera guard follows the Taiwan focus range', () {
      final bounds = MapLibreMapConfig.taiwanCameraBounds;

      expect(bounds.southwest, const LatLng(21.5, 118.0));
      expect(bounds.northeast, const LatLng(26.5, 122.2));
      expect(bounds.contains(const LatLng(26.2, 121.0)), isTrue);
      expect(bounds.contains(const LatLng(35, 121)), isFalse);
    });

    test('native camera bounds switch at the overview guard threshold', () {
      expect(
        MapLibreMapConfig.cameraTargetBoundsForZoom(8.5),
        same(MapLibreMapConfig.taiwanOverviewNativeCameraBounds),
      );
      expect(
        MapLibreMapConfig.cameraTargetBoundsForZoom(8.51),
        same(MapLibreMapConfig.taiwanCameraBounds),
      );
    });

    test(
      'overview native bounds include the viewport around the safe centre',
      () {
        const viewport = Size(508, 873);

        final bounds = MapLibreMapConfig.cameraTargetBoundsForZoom(
          5.7,
          viewportSize: viewport,
        );

        expect(
          bounds.southwest.latitude,
          lessThan(
            MapLibreMapConfig.taiwanOverviewPanBounds.southwest.latitude,
          ),
        );
        expect(
          bounds.northeast.latitude,
          greaterThan(
            MapLibreMapConfig.taiwanOverviewPanBounds.northeast.latitude,
          ),
        );
        expect(
          bounds.southwest.longitude,
          lessThan(
            MapLibreMapConfig.taiwanOverviewPanBounds.southwest.longitude,
          ),
        );
        expect(
          bounds.northeast.longitude,
          greaterThan(
            MapLibreMapConfig.taiwanOverviewPanBounds.northeast.longitude,
          ),
        );
        expect(bounds.contains(const LatLng(23.65, 121.05)), isTrue);
      },
    );

    test(
      'intermediate low zoom keeps Taipei visible instead of overview-centering',
      () {
        const viewport = Size(390, 844);
        const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);
        const taipei = LatLng(25.05, 121.55);

        final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
          taipei,
          zoom: 8,
          viewportSize: viewport,
          padding: padding,
        );

        expect(
          corrected.latitude,
          greaterThan(
            MapLibreMapConfig.taiwanOverviewPanBounds.northeast.latitude,
          ),
        );
        expect(corrected.longitude, closeTo(taipei.longitude, 0.1));
      },
    );

    test(
      'camera guard clamps targets outside the Taiwan interaction range',
      () {
        expect(
          MapLibreMapConfig.clampCameraTarget(const LatLng(35, 130)),
          const LatLng(26.5, 122.2),
        );
        expect(
          MapLibreMapConfig.clampCameraTarget(const LatLng(20, 117)),
          const LatLng(21.5, 118.0),
        );
      },
    );

    test('overview guard keeps the whole map in the visible viewport', () {
      const viewport = Size(1200, 873);
      const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);

      final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
        const LatLng(27, 121),
        zoom: MapLibreMapConfig.overviewZoom,
        viewportSize: viewport,
        padding: padding,
      );

      expect(
        corrected.latitude,
        lessThanOrEqualTo(
          MapLibreMapConfig.taiwanOverviewBounds.northeast.latitude,
        ),
      );
      expect(corrected.longitude, closeTo(121.05, 0.5));
    });

    test(
      'overview guard keeps a low-zoom pan inside the Taiwan focus area',
      () {
        const viewport = Size(1200, 873);
        const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);
        const target = LatLng(27.2, 119.2);

        final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
          target,
          zoom: MapLibreMapConfig.overviewZoom,
          viewportSize: viewport,
          padding: padding,
        );

        expect(
          corrected.latitude,
          closeTo(
            MapLibreMapConfig.taiwanOverviewPanBounds.northeast.latitude,
            1e-9,
          ),
        );
        expect(
          corrected.longitude,
          closeTo(
            MapLibreMapConfig.taiwanOverviewPanBounds.southwest.longitude,
            1e-9,
          ),
        );
      },
    );

    test('mobile overview fits the complete Taiwan focus range', () {
      const viewport = Size(390, 844);
      const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);
      final camera = MapLibreMapConfig.taiwanOverviewCameraForViewport(
        viewport,
        padding: padding,
      );
      final corners = <GeoPoint>[
        const GeoPoint(longitude: 118.0, latitude: 21.5),
        const GeoPoint(longitude: 118.0, latitude: 26.5),
        const GeoPoint(longitude: 122.2, latitude: 21.5),
        const GeoPoint(longitude: 122.2, latitude: 26.5),
      ];

      for (final corner in corners) {
        final screen = MapCameraProjection.projectPoint(
          point: corner,
          cameraTarget: camera.target,
          zoom: camera.zoom,
          viewportSize: viewport,
        );
        expect(
          screen.dx,
          inInclusiveRange(
            padding.left - 1e-6,
            viewport.width - padding.right + 1e-6,
          ),
        );
        expect(
          screen.dy,
          inInclusiveRange(
            padding.top - 1e-6,
            viewport.height - padding.bottom + 1e-6,
          ),
        );
      }
      expect(camera.zoom, lessThan(6.5));
    });

    test(
      'high-zoom camera guard keeps the viewport below the Taiwan north edge',
      () {
        const viewport = Size(390, 844);
        const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);

        final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
          const LatLng(27, 121),
          zoom: 9,
          viewportSize: viewport,
          padding: padding,
        );

        expect(
          corrected.latitude,
          lessThan(MapLibreMapConfig.taiwanOverviewBounds.northeast.latitude),
        );
      },
    );

    test(
      'high-zoom guard does not snap a valid pan to the overview center',
      () {
        const viewport = Size(20000, 20000);
        const padding = EdgeInsets.zero;
        const target = LatLng(25.1, 121.6);

        final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
          target,
          zoom: 9,
          viewportSize: viewport,
          padding: padding,
        );

        expect(corrected, target);
      },
    );

    test(
      'Taiwan overview camera fits the focused range in the map viewport',
      () {
        const viewport = Size(1200, 873);
        const padding = EdgeInsets.fromLTRB(24, 24, 24, 120);
        final camera = MapLibreMapConfig.taiwanOverviewCameraForViewport(
          viewport,
          padding: padding,
        );
        final corners = <GeoPoint>[
          const GeoPoint(longitude: 118.0, latitude: 21.5),
          const GeoPoint(longitude: 118.0, latitude: 26.5),
          const GeoPoint(longitude: 122.2, latitude: 21.5),
          const GeoPoint(longitude: 122.2, latitude: 26.5),
        ];

        for (final corner in corners) {
          final screen = MapCameraProjection.projectPoint(
            point: corner,
            cameraTarget: camera.target,
            zoom: camera.zoom,
            viewportSize: viewport,
          );
          expect(
            screen.dx,
            inInclusiveRange(
              padding.left - 1e-6,
              viewport.width - padding.right + 1e-6,
            ),
          );
          expect(
            screen.dy,
            inInclusiveRange(
              padding.top - 1e-6,
              viewport.height - padding.bottom + 1e-6,
            ),
          );
        }
        expect(camera.zoom, greaterThan(MapLibreMapConfig.minZoom));
      },
    );
  });
}
