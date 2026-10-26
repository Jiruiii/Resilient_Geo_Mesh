import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import 'map_models.dart';

/// Injectable boundary around the platform location plugin.
abstract interface class LocationGateway {
  Future<bool> isServiceEnabled();

  Future<LocationPermission> checkPermission();

  Future<LocationPermission> requestPermission();

  Future<GeoPoint?> getCurrentLocation();

  Stream<GeoPoint> get locationUpdates;
}

/// Reads one position; injectable so the Android fallback can be tested.
typedef PositionReader = Future<Position> Function(LocationSettings settings);

class GeolocatorLocationGateway implements LocationGateway {
  GeolocatorLocationGateway({PositionReader? readPosition, bool? android})
    : _readPosition = readPosition ?? _readGeolocatorPosition,
      _android =
          android ??
          (!kIsWeb && defaultTargetPlatform == TargetPlatform.android);

  final PositionReader _readPosition;
  final bool _android;

  /// Set once Google's fused provider has failed. Declining the Location
  /// Accuracy prompt makes every fused request fail even though GPS works,
  /// while Android's own LocationManager needs no such consent.
  bool _useLocationManager = false;

  static Future<Position> _readGeolocatorPosition(LocationSettings settings) =>
      Geolocator.getCurrentPosition(locationSettings: settings);

  @override
  Future<LocationPermission> checkPermission() => Geolocator.checkPermission();

  @override
  Future<GeoPoint?> getCurrentLocation() async {
    // A recent, accurate device fix is already current enough for a walking
    // origin. Never silently substitute an old last-known position.
    if (!kIsWeb) {
      try {
        final cached = await Geolocator.getLastKnownPosition();
        if (cached != null &&
            canUseCachedPosition(cached, now: DateTime.now())) {
          return _toGeoPoint(cached);
        }
      } on Object {
        /* A missing cached fix does not prevent requesting GPS. */
      }
    }
    try {
      return _toGeoPoint(await _readPosition(_settings()));
    } on PermissionDeniedException {
      rethrow;
    } on Object {
      if (!_android || _useLocationManager) rethrow;
      _useLocationManager = true;
      return _toGeoPoint(await _readPosition(_settings()));
    }
  }

  LocationSettings _settings({int? distanceFilter}) =>
      _useLocationManager
          ? AndroidSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: distanceFilter ?? 0,
            timeLimit:
                distanceFilter == null ? const Duration(seconds: 10) : null,
            forceLocationManager: true,
          )
          : LocationSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: distanceFilter ?? 0,
            timeLimit:
                distanceFilter == null ? const Duration(seconds: 10) : null,
          );

  static bool canUseCachedPosition(Position position, {required DateTime now}) {
    final age = now.difference(position.timestamp);
    return !age.isNegative &&
        age <= const Duration(seconds: 30) &&
        position.hasAccuracy &&
        position.accuracy.isFinite &&
        position.accuracy >= 0 &&
        position.accuracy <= 50;
  }

  @override
  Future<bool> isServiceEnabled() => Geolocator.isLocationServiceEnabled();

  @override
  Stream<GeoPoint> get locationUpdates => Geolocator.getPositionStream(
    locationSettings: _settings(distanceFilter: 5),
  ).map(_toGeoPoint);

  @override
  Future<LocationPermission> requestPermission() =>
      Geolocator.requestPermission();
}

/// Requests device location only in response to an explicit user action.
class LocationController {
  LocationController({LocationGateway? gateway, bool? webPlatform})
    : _gateway = gateway ?? GeolocatorLocationGateway(),
      _webPlatform = webPlatform ?? kIsWeb;

  final LocationGateway _gateway;
  final bool _webPlatform;
  final StreamController<GeoPoint> _locations =
      StreamController<GeoPoint>.broadcast();
  StreamSubscription<GeoPoint>? _locationSubscription;
  bool _disposed = false;

  Stream<GeoPoint> get locations => _locations.stream;

  Future<GeoPoint?> requestCurrentLocation() async {
    if (_disposed) return null;

    try {
      // Browsers can report `denied` from the Permissions API even though
      // navigator.geolocation is usable. Calling the browser API directly
      // also makes the permission prompt happen in the user's click handler.
      if (_webPlatform) {
        final location = await _gateway.getCurrentLocation();
        if (location == null) return null;
        _listenForUpdates();
        return location;
      }

      if (!await _gateway.isServiceEnabled()) return null;

      var permission = await _gateway.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await _gateway.requestPermission();
      }
      if (!_isGranted(permission)) return null;

      final location = await _gateway.getCurrentLocation();
      if (location == null) return null;
      _listenForUpdates();
      return location;
    } on Object {
      return null;
    }
  }

  void _listenForUpdates() {
    if (_locationSubscription != null || _disposed) return;
    _locationSubscription = _gateway.locationUpdates.listen(
      _locations.add,
      onError: (_) {},
    );
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _locationSubscription?.cancel();
    await _locations.close();
  }
}

bool _isGranted(LocationPermission permission) =>
    permission == LocationPermission.whileInUse ||
    permission == LocationPermission.always;

GeoPoint _toGeoPoint(Position position) =>
    GeoPoint(longitude: position.longitude, latitude: position.latitude);
