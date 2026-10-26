import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:resilientgeo_flutter/data/location_controller.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  final now = DateTime.utc(2026, 9, 27, 3);
  Position fix({
    int ageSeconds = 5,
    double accuracy = 10,
    bool hasAccuracy = true,
  }) => Position(
    longitude: 121.5,
    latitude: 25,
    timestamp: now.subtract(Duration(seconds: ageSeconds)),
    accuracy: accuracy,
    hasAccuracy: hasAccuracy,
    altitude: 0,
    altitudeAccuracy: 0,
    heading: 0,
    headingAccuracy: 0,
    speed: 0,
    speedAccuracy: 0,
  );
  test(
    'a recent accurate device fix can avoid waiting for another GPS fix',
    () {
      expect(
        GeolocatorLocationGateway.canUseCachedPosition(fix(), now: now),
        isTrue,
      );
    },
  );
  test('stale, future and inaccurate fixes cannot become a route origin', () {
    for (final position in [
      fix(ageSeconds: 31),
      fix(ageSeconds: -1),
      fix(accuracy: 51),
      fix(accuracy: -1),
      fix(accuracy: double.nan),
      fix(hasAccuracy: false),
    ]) {
      expect(
        GeolocatorLocationGateway.canUseCachedPosition(position, now: now),
        isFalse,
      );
    }
  });

  group('Android position fallback', () {
    test('declined fused location retries once with LocationManager', () async {
      final requested = <LocationSettings>[];
      final gateway = GeolocatorLocationGateway(
        android: true,
        readPosition: (settings) async {
          requested.add(settings);
          if (requested.length == 1) {
            throw const LocationServiceDisabledException();
          }
          return fix();
        },
      );

      final location = await gateway.getCurrentLocation();

      expect(location, const GeoPoint(longitude: 121.5, latitude: 25));
      expect(requested, hasLength(2));
      expect(requested.first, isNot(isA<AndroidSettings>()));
      expect((requested.last as AndroidSettings).forceLocationManager, isTrue);
      // Later requests skip the fused provider that already failed.
      await gateway.getCurrentLocation();
      expect(requested, hasLength(3));
      expect((requested.last as AndroidSettings).forceLocationManager, isTrue);
    });

    test('a denied permission is never retried', () async {
      var reads = 0;
      final gateway = GeolocatorLocationGateway(
        android: true,
        readPosition: (_) async {
          reads += 1;
          throw const PermissionDeniedException('denied');
        },
      );

      await expectLater(
        gateway.getCurrentLocation(),
        throwsA(isA<PermissionDeniedException>()),
      );
      expect(reads, 1);
    });

    test('other platforms surface the first failure', () async {
      var reads = 0;
      final gateway = GeolocatorLocationGateway(
        android: false,
        readPosition: (_) async {
          reads += 1;
          throw TimeoutException('no fix');
        },
      );

      await expectLater(
        gateway.getCurrentLocation(),
        throwsA(isA<TimeoutException>()),
      );
      expect(reads, 1);
    });
  });
}
