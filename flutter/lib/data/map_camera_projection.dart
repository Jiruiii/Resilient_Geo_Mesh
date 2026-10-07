import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import 'map_models.dart';

class MapViewportBounds {
  const MapViewportBounds({
    required this.minLongitude,
    required this.minLatitude,
    required this.maxLongitude,
    required this.maxLatitude,
  });

  final double minLongitude;
  final double minLatitude;
  final double maxLongitude;
  final double maxLatitude;

  bool contains(GeoPoint point) =>
      point.longitude >= minLongitude &&
      point.longitude <= maxLongitude &&
      point.latitude >= minLatitude &&
      point.latitude <= maxLatitude;
}

/// Projects WGS84 coordinates into the current MapLibre camera viewport.
///
/// MapLibre uses a Web Mercator world. Keeping this calculation local and
/// synchronous prevents Flutter marker overlays from waiting for the native
/// platform view while the camera is moving. An idle-time native projection
/// can still correct any renderer-specific rounding afterwards.
class MapCameraProjection {
  MapCameraProjection._();

  static const double _tileSize = 512;
  static const double _maxMercatorLatitude = 85.05112878;

  /// Android MapLibre returns physical pixels; Flutter overlays and the
  /// web/iOS MapLibre projections use logical pixels.
  static Offset fromNativeScreenPosition(
    Offset position, {
    required bool physicalPixels,
    required double devicePixelRatio,
  }) {
    assert(devicePixelRatio > 0 && devicePixelRatio.isFinite);
    return physicalPixels ? position / devicePixelRatio : position;
  }

  static Offset projectPoint({
    required GeoPoint point,
    required GeoPoint cameraTarget,
    required double zoom,
    required Size viewportSize,
  }) {
    final worldSize = _tileSize * math.pow(2, zoom).toDouble();
    final cameraX = _longitudeToWorld(cameraTarget.longitude);
    final pointX = _longitudeToWorld(point.longitude);
    final wrappedDeltaX = _wrapWorldDelta(pointX - cameraX);
    final pointY = _latitudeToWorld(point.latitude);
    final cameraY = _latitudeToWorld(cameraTarget.latitude);

    return Offset(
      viewportSize.width / 2 + wrappedDeltaX * worldSize,
      viewportSize.height / 2 + (pointY - cameraY) * worldSize,
    );
  }

  /// Returns the shared screen translation for a camera pan at a fixed zoom.
  /// Cached marker positions can use this offset instead of projecting each
  /// point again for every camera callback.
  static Offset panTranslation({
    required GeoPoint fromCameraTarget,
    required GeoPoint toCameraTarget,
    required double zoom,
  }) {
    final worldSize = _tileSize * math.pow(2, zoom).toDouble();
    final fromX = _longitudeToWorld(fromCameraTarget.longitude);
    final toX = _longitudeToWorld(toCameraTarget.longitude);
    final deltaX = _wrapWorldDelta(fromX - toX);
    final fromY = _latitudeToWorld(fromCameraTarget.latitude);
    final toY = _latitudeToWorld(toCameraTarget.latitude);
    return Offset(deltaX * worldSize, (fromY - toY) * worldSize);
  }

  static List<Offset> projectPoints({
    required Iterable<GeoPoint> points,
    required GeoPoint cameraTarget,
    required double zoom,
    required Size viewportSize,
  }) {
    return points
        .map(
          (point) => projectPoint(
            point: point,
            cameraTarget: cameraTarget,
            zoom: zoom,
            viewportSize: viewportSize,
          ),
        )
        .toList(growable: false);
  }

  static MapViewportBounds viewportBounds({
    required GeoPoint cameraTarget,
    required double zoom,
    required Size viewportSize,
    double paddingPixels = 0,
  }) {
    final worldSize = _tileSize * math.pow(2, zoom).toDouble();
    final padding = math.max(0, paddingPixels);
    final halfWidth = (viewportSize.width / 2 + padding) / worldSize;
    final halfHeight = (viewportSize.height / 2 + padding) / worldSize;
    final centerX = _longitudeToWorld(cameraTarget.longitude);
    final centerY = _latitudeToWorld(cameraTarget.latitude);
    final west = (centerX - halfWidth).clamp(0.0, 1.0).toDouble();
    final east = (centerX + halfWidth).clamp(0.0, 1.0).toDouble();
    final north = (centerY - halfHeight).clamp(0.0, 1.0).toDouble();
    final south = (centerY + halfHeight).clamp(0.0, 1.0).toDouble();

    return MapViewportBounds(
      minLongitude: _worldToLongitude(west),
      maxLongitude: _worldToLongitude(east),
      minLatitude: _worldToLatitude(south),
      maxLatitude: _worldToLatitude(north),
    );
  }

  static double _longitudeToWorld(double longitude) {
    return (longitude + 180) / 360;
  }

  static double _latitudeToWorld(double latitude) {
    final clampedLatitude = latitude.clamp(
      -_maxMercatorLatitude,
      _maxMercatorLatitude,
    );
    final latitudeRadians = clampedLatitude * math.pi / 180;
    final mercatorY =
        math.log(math.tan(math.pi / 4 + latitudeRadians / 2)) / math.pi;
    return (1 - mercatorY) / 2;
  }

  static double _worldToLongitude(double x) => (x * 360) - 180;

  static double _worldToLatitude(double y) {
    final mercatorY = (1 - (2 * y)) * math.pi;
    final sinh = (math.exp(mercatorY) - math.exp(-mercatorY)) / 2;
    return 180 / math.pi * math.atan(sinh);
  }

  static double _wrapWorldDelta(double delta) {
    if (delta > 0.5) {
      return delta - 1;
    }
    if (delta < -0.5) {
      return delta + 1;
    }
    return delta;
  }
}
