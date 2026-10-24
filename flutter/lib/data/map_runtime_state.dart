import 'package:flutter/material.dart';

import 'map_models.dart';

/// UI-only state shared by the MapLibre renderer and its surrounding controls.
///
/// Persisted events and occupancy remain owned by the Android bridge/Room.
class MapRuntimeState {
  const MapRuntimeState({
    required this.themeMode,
    required this.zoomPercentage,
    required this.currentLocation,
    required this.animationEnabled,
    this.emapVisible = false,
  }) : assert(zoomPercentage >= 0 && zoomPercentage <= 100);

  final ThemeMode themeMode;
  final int zoomPercentage;
  final GeoPoint? currentLocation;
  final bool animationEnabled;

  /// Whether the online NLSC EMAP raster covers the offline OSM base map.
  final bool emapVisible;

  MapRuntimeState copyWith({
    ThemeMode? themeMode,
    int? zoomPercentage,
    Object? currentLocation = _unchangedLocation,
    bool? animationEnabled,
    bool? emapVisible,
  }) => MapRuntimeState(
    themeMode: themeMode ?? this.themeMode,
    zoomPercentage: zoomPercentage ?? this.zoomPercentage,
    currentLocation:
        identical(currentLocation, _unchangedLocation)
            ? this.currentLocation
            : currentLocation as GeoPoint?,
    animationEnabled: animationEnabled ?? this.animationEnabled,
    emapVisible: emapVisible ?? this.emapVisible,
  );
}

const Object _unchangedLocation = Object();
