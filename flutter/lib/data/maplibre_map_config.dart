import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import 'map_models.dart';
import 'map_zoom.dart';

/// Immutable camera and style decisions shared by the MapLibre widget and
/// tests.  The renderer owns no product data; it only consumes this config.
class MapLibreMapConfig {
  const MapLibreMapConfig._();

  /// Use MapLibre's built-in compact, expandable attribution control.
  static const AttributionButtonPosition attributionButtonPosition =
      AttributionButtonPosition.bottomLeft;

  /// Keep the camera range useful for Taiwan. The checked-in PMTiles currently
  /// contain data through z15; z17 is an intentional vector overzoom until a
  /// higher-detail Taiwan package is generated.
  static const double minZoom = 5;
  static const double maxZoom = 17;
  static const double overviewZoom = 5;
  static const double overviewGuardMaxZoom = 8.5;
  static const int overviewPercentage = 0;
  static const int initialOverviewPercentage = 10;

  /// At this level the administrative clusters are replaced by raw data points.
  static const int revealAllPercentage = 55;

  /// At this level raw data points switch from dots to their full icons.
  static const int fullMarkerPercentage = 80;
  static const double locationZoom = 13;
  static const int focusPercentage = 85;

  static const GeoPoint taiwanOverviewCenter = GeoPoint(
    longitude: 121.05,
    latitude: 23.65,
  );

  static final LatLngBounds taiwanBounds = LatLngBounds(
    southwest: const LatLng(21.8, 118.0),
    northeast: const LatLng(26.5, 122.2),
  );

  /// The reset camera fits the complete local Taiwan package, including
  /// Matsu, Penghu, Kinmen, and the southeast islands.
  /// The camera target remains Taiwan's center rather than the mathematical
  /// center of the focus bbox.
  static final LatLngBounds taiwanOverviewBounds = LatLngBounds(
    southwest: const LatLng(21.5, 118.0),
    northeast: const LatLng(26.5, 122.2),
  );

  /// Bounds used by the Dart-side camera guard. Keep the interaction range
  /// aligned with the reset range so users cannot pan into a large unrelated
  /// area above Taiwan while zoomed in.
  static final LatLngBounds taiwanCameraBounds = LatLngBounds(
    southwest: const LatLng(21.5, 118.0),
    northeast: const LatLng(26.5, 122.2),
  );

  /// Fallback centre envelope used only when the viewport is larger than the
  /// complete Taiwan focus range. Once the viewport becomes smaller than the
  /// focus range, low-zoom panning must be allowed to reach northern Taiwan.
  static final LatLngBounds taiwanOverviewPanBounds = LatLngBounds(
    southwest: const LatLng(23.5, 120.0),
    northeast: const LatLng(24.1, 122.1),
  );

  /// Native MapLibre bounds must contain the complete overview viewport. A
  /// narrow bounds here would make MapLibre zoom in automatically on a tall
  /// phone viewport, so this low-zoom safety envelope is deliberately wider.
  /// The Dart-side [taiwanOverviewPanBounds] still provides the tighter centre
  /// guard after a movement settles.
  static final LatLngBounds taiwanOverviewNativeCameraBounds = LatLngBounds(
    southwest: const LatLng(5.0, 105.0),
    northeast: const LatLng(42.0, 137.0),
  );

  static LatLngBounds cameraTargetBoundsForZoom(
    double zoom, {
    Size? viewportSize,
  }) {
    if (zoom > overviewGuardMaxZoom) return taiwanCameraBounds;
    final viewport = viewportSize;
    if (viewport == null || viewport.isEmpty) {
      return taiwanOverviewNativeCameraBounds;
    }
    return overviewNativeCameraBoundsForViewport(
      zoom: zoom,
      viewportSize: viewport,
    );
  }

  /// Expands the complete Taiwan focus range by the visible half-viewport.
  /// The resulting MapLibre max-bounds can contain the fitted overview without
  /// restricting intermediate zooms to a narrow central latitude band.
  static LatLngBounds overviewNativeCameraBoundsForViewport({
    required double zoom,
    required Size viewportSize,
  }) {
    final scale = 512 * math.pow(2, zoom).toDouble();
    // MapLibre's max-bounds calculation uses the complete platform-view
    // viewport, not the Flutter overlay padding. Expand by the full half
    // viewport so applying max-bounds does not force an automatic zoom-in.
    final leftOffset = viewportSize.width / 2 / scale;
    final rightOffset = viewportSize.width / 2 / scale;
    final topOffset = viewportSize.height / 2 / scale;
    final bottomOffset = viewportSize.height / 2 / scale;

    final centerBounds = taiwanOverviewBounds;
    return LatLngBounds(
      southwest: LatLng(
        _latitudeFromWorldY(
          _worldY(centerBounds.southwest.latitude) + bottomOffset,
        ),
        _longitudeFromWorldX(
          _worldX(centerBounds.southwest.longitude) - leftOffset,
        ),
      ),
      northeast: LatLng(
        _latitudeFromWorldY(
          _worldY(centerBounds.northeast.latitude) - topOffset,
        ),
        _longitudeFromWorldX(
          _worldX(centerBounds.northeast.longitude) + rightOffset,
        ),
      ),
    );
  }

  static LatLng clampCameraTarget(LatLng target) => LatLng(
    target.latitude
        .clamp(
          taiwanCameraBounds.southwest.latitude,
          taiwanCameraBounds.northeast.latitude,
        )
        .toDouble(),
    target.longitude
        .clamp(
          taiwanCameraBounds.southwest.longitude,
          taiwanCameraBounds.northeast.longitude,
        )
        .toDouble(),
  );

  /// At overview zoom a valid target still can show only ocean if the target
  /// is clamped by latitude alone. Keep the focused Taiwan range inside the
  /// usable viewport while the map is zoomed out, then allow the wider camera
  /// guard once the user has zoomed into an area.
  static LatLng clampCameraTargetForViewport(
    LatLng target, {
    required double zoom,
    required Size viewportSize,
    required EdgeInsets padding,
  }) {
    final targetGuarded = clampCameraTarget(target);
    if (viewportSize.isEmpty) {
      return targetGuarded;
    }

    final scale = 512 * math.pow(2, zoom).toDouble();
    final centerX = viewportSize.width / 2;
    final centerY = viewportSize.height / 2;
    if (zoom <= overviewGuardMaxZoom) {
      final west = _worldX(taiwanOverviewBounds.southwest.longitude);
      final east = _worldX(taiwanOverviewBounds.northeast.longitude);
      final south = _worldY(taiwanOverviewBounds.southwest.latitude);
      final north = _worldY(taiwanOverviewBounds.northeast.latitude);
      final minTargetX = west + math.max(0, centerX - padding.left) / scale;
      final maxTargetX =
          east -
          math.max(0, viewportSize.width - padding.right - centerX) / scale;
      final minTargetY = north + math.max(0, centerY - padding.top) / scale;
      final maxTargetY =
          south -
          math.max(0, viewportSize.height - padding.bottom - centerY) / scale;

      // At very low zoom the viewport can be wider or taller than the whole
      // focus range. In that case there is no valid interval that keeps every
      // edge aligned with the viewport. Use the smaller overview centre
      // envelope instead of preserving an arbitrary ocean-facing target.
      if (minTargetX > maxTargetX || minTargetY > maxTargetY) {
        return _clampToBounds(targetGuarded, taiwanOverviewPanBounds);
      }

      final targetX = _worldX(
        targetGuarded.longitude,
      ).clamp(minTargetX, maxTargetX);
      final targetY = _worldY(
        targetGuarded.latitude,
      ).clamp(minTargetY, maxTargetY);
      return clampCameraTarget(
        LatLng(
          _latitudeFromWorldY(targetY.toDouble()),
          _longitudeFromWorldX(targetX.toDouble()),
        ),
      );
    }

    // Once zoomed in, keep the visible viewport inside the Taiwan interaction
    // range instead of only clamping the camera centre. This prevents a north
    // drag from leaving the map on an empty ocean area.
    final west = _worldX(taiwanCameraBounds.southwest.longitude);
    final east = _worldX(taiwanCameraBounds.northeast.longitude);
    final south = _worldY(taiwanCameraBounds.southwest.latitude);
    final north = _worldY(taiwanCameraBounds.northeast.latitude);
    final minTargetX = west + math.max(0, centerX - padding.left) / scale;
    final maxTargetX =
        east -
        math.max(0, viewportSize.width - padding.right - centerX) / scale;
    final minTargetY = north + math.max(0, centerY - padding.top) / scale;
    final maxTargetY =
        south -
        math.max(0, viewportSize.height - padding.bottom - centerY) / scale;

    final targetX = _clampWorldCoordinate(
      _worldX(targetGuarded.longitude),
      minTargetX,
      maxTargetX,
    );
    final targetY = _clampWorldCoordinate(
      _worldY(targetGuarded.latitude),
      minTargetY,
      maxTargetY,
    );
    return clampCameraTarget(
      LatLng(_latitudeFromWorldY(targetY), _longitudeFromWorldX(targetX)),
    );
  }

  static LatLng _clampToBounds(LatLng target, LatLngBounds bounds) => LatLng(
    target.latitude
        .clamp(bounds.southwest.latitude, bounds.northeast.latitude)
        .toDouble(),
    target.longitude
        .clamp(bounds.southwest.longitude, bounds.northeast.longitude)
        .toDouble(),
  );

  static double _clampWorldCoordinate(
    double value,
    double minimum,
    double maximum,
  ) {
    if (minimum > maximum) return value;
    return value.clamp(minimum, maximum).toDouble();
  }

  static const String lightStyleAsset = 'assets/map/styles/taiwan-light.json';
  static const String darkStyleAsset = 'assets/map/styles/taiwan-dark.json';

  static MapLibreCameraState initialCamera({GeoPoint? currentLocation}) =>
      MapLibreCameraState(
        target: currentLocation ?? taiwanOverviewCenter,
        // Start at the user-facing initial level. Waiting for the fitted
        // viewport camera here makes the web renderer briefly expose 0%.
        zoom:
            currentLocation == null
                ? ZoomPercentage.toZoom(
                  percentage: initialOverviewPercentage,
                  minZoom: minZoom,
                  maxZoom: maxZoom,
                  overviewZoom: overviewZoom,
                )
                : locationZoom,
      );

  static MapLibreCameraState taiwanOverviewCamera() =>
      const MapLibreCameraState(
        target: taiwanOverviewCenter,
        zoom: overviewZoom,
      );

  /// Calculates a camera that fits the reset focus range inside the actual map
  /// viewport. MapLibre's bounds update can run before the platform view has a
  /// stable size, so the Flutter side supplies the fitted camera after layout.
  static MapLibreCameraState taiwanOverviewCameraForViewport(
    Size viewportSize, {
    required EdgeInsets padding,
  }) {
    final west = _worldX(taiwanOverviewBounds.southwest.longitude);
    final east = _worldX(taiwanOverviewBounds.northeast.longitude);
    final south = _worldY(taiwanOverviewBounds.southwest.latitude);
    final north = _worldY(taiwanOverviewBounds.northeast.latitude);
    final targetX = _worldX(taiwanOverviewCenter.longitude);
    final targetY = _worldY(taiwanOverviewCenter.latitude);
    final viewportCenterX = viewportSize.width / 2;
    final viewportCenterY = viewportSize.height / 2;
    final horizontalScale = math.min(
      (viewportCenterX - padding.left) / math.max(1e-9, targetX - west),
      (viewportSize.width - padding.right - viewportCenterX) /
          math.max(1e-9, east - targetX),
    );
    final verticalScale = math.min(
      (viewportCenterY - padding.top) / math.max(1e-9, targetY - north),
      (viewportSize.height - padding.bottom - viewportCenterY) /
          math.max(1e-9, south - targetY),
    );
    final worldScale = math.max(1.0, math.min(horizontalScale, verticalScale));
    final fittedZoom = math.log(worldScale / 512) / math.ln2;
    final zoom = fittedZoom.clamp(minZoom, maxZoom).toDouble();
    return MapLibreCameraState(target: taiwanOverviewCenter, zoom: zoom);
  }

  static double _worldX(double longitude) => (longitude + 180) / 360;

  static double _longitudeFromWorldX(double x) => (x * 360) - 180;

  static double _worldY(double latitude) {
    final radians = latitude * math.pi / 180;
    return (1 -
            (math.log(math.tan(radians) + (1 / math.cos(radians))) / math.pi)) /
        2;
  }

  static double _latitudeFromWorldY(double y) {
    final radians = math.pi - (2 * math.pi * y);
    final sinh = (math.exp(radians) - math.exp(-radians)) / 2;
    return 180 / math.pi * math.atan(sinh);
  }

  static String styleAssetFor({
    required ThemeMode themeMode,
    required Brightness systemBrightness,
  }) {
    final isDark =
        themeMode == ThemeMode.dark ||
        (themeMode == ThemeMode.system && systemBrightness == Brightness.dark);
    return isDark ? darkStyleAsset : lightStyleAsset;
  }
}

class MapLibreCameraState {
  const MapLibreCameraState({required this.target, required this.zoom});

  final GeoPoint target;
  final double zoom;
}
