import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

import 'evacuation_models.dart';
import 'map_bridge.dart';
import 'map_models.dart';
import 'map_search.dart';

/// Bounded, opt-in diagnostics in debug/profile builds; no release overhead.
class AppPerformance {
  static Future<MapSearchQuery> Function(String)? search;

  /// Reported with frame timings so A/B runs record which map path ran.
  static String mapComposition = 'platform_default';

  /// Set by the app shell: replays the current event snapshot, returns size.
  static int Function()? replayEvents;
  static Future<Map<String, dynamic>>? _eventBurst;

  static void register() {
    if (kReleaseMode) return;
    // Starts a burst and returns at once so the caller can pan meanwhile;
    // `eventBurstResult` waits for it. mode=native touches Room through the
    // Android bridge; mode=replay re-delivers the snapshot inside Flutter.
    developer.registerExtension('ext.resilientgeo.eventBurst', (
      _,
      parameters,
    ) async {
      final count = int.parse(parameters['count'] ?? '60');
      final intervalMs = int.parse(parameters['interval_ms'] ?? '50');
      final mode = parameters['mode'] ?? 'native';
      _eventBurst = switch (mode) {
        'native' => MapBridge().measurementEventBurst(
          count: count,
          intervalMs: intervalMs,
        ),
        'replay' => _replayBurst(count, intervalMs),
        _ => Future.error(ArgumentError.value(mode, 'mode')),
      };
      return developer.ServiceExtensionResponse.result(
        jsonEncode({'started': mode}),
      );
    });
    developer.registerExtension('ext.resilientgeo.eventBurstResult', (
      _,
      __,
    ) async {
      final burst = _eventBurst;
      if (burst == null) {
        return developer.ServiceExtensionResponse.result('{"started":false}');
      }
      try {
        return developer.ServiceExtensionResponse.result(
          jsonEncode(await burst),
        );
      } on Object catch (error) {
        return developer.ServiceExtensionResponse.result(
          jsonEncode({'error': error.toString()}),
        );
      }
    });
    developer.registerExtension('ext.resilientgeo.search', (
      _,
      parameters,
    ) async {
      final query = search;
      if (query == null) {
        return developer.ServiceExtensionResponse.result('{"ready":false}');
      }
      final watch = Stopwatch()..start();
      final result = await query(parameters['query'] ?? '');
      return developer.ServiceExtensionResponse.result(
        jsonEncode({
          'ready': true,
          'elapsed_ms': watch.elapsedMicroseconds / 1000,
          'results': result.results.length,
        }),
      );
    });
    developer.registerExtension('ext.resilientgeo.routeBenchmark', (
      _,
      parameters,
    ) async {
      final watch = Stopwatch()..start();
      final result = await MapBridge().calculateEvacuationRoute(
        origin: GeoPoint(
          longitude: double.parse(parameters['lon']!),
          latitude: double.parse(parameters['lat']!),
        ),
        destination: ShelterRouteCandidate(
          id: 'benchmark',
          location: GeoPoint(
            longitude: double.parse(parameters['targetLon']!),
            latitude: double.parse(parameters['targetLat']!),
          ),
        ),
      );
      return developer.ServiceExtensionResponse.result(
        jsonEncode({
          'elapsed_ms': watch.elapsedMicroseconds / 1000,
          'status': result.status.wireValue,
          'distance_m': result.distanceM,
          'points': result.polyline.length,
        }),
      );
    });
    final frames = <FrameTiming>[];
    SchedulerBinding.instance.addTimingsCallback((batch) {
      frames.addAll(batch);
      if (frames.length > 600) frames.removeRange(0, frames.length - 600);
    });
    developer.registerExtension('ext.resilientgeo.performance', (
      _,
      parameters,
    ) async {
      if (parameters['reset'] == 'true') frames.clear();
      double percentile(List<int> values, double p) {
        if (values.isEmpty) return 0;
        values.sort();
        return values[((values.length - 1) * p).round()] / 1000;
      }

      return developer.ServiceExtensionResponse.result(
        jsonEncode({
          'map_composition': mapComposition,
          'frames': frames.length,
          'build_p50_ms': percentile(
            frames.map((f) => f.buildDuration.inMicroseconds).toList(),
            .5,
          ),
          'build_p95_ms': percentile(
            frames.map((f) => f.buildDuration.inMicroseconds).toList(),
            .95,
          ),
          'raster_p95_ms': percentile(
            frames.map((f) => f.rasterDuration.inMicroseconds).toList(),
            .95,
          ),
          'total_p95_ms': percentile(
            frames.map((f) => f.totalSpan.inMicroseconds).toList(),
            .95,
          ),
          'slow_frames':
              frames
                  .where(
                    (f) =>
                        f.buildDuration.inMicroseconds > 16000 ||
                        f.rasterDuration.inMicroseconds > 16000,
                  )
                  .length,
        }),
      );
    });
  }

  static Future<Map<String, dynamic>> _replayBurst(
    int count,
    int intervalMs,
  ) async {
    final replay = replayEvents;
    if (replay == null) throw StateError('event replay is not registered');
    final watch = Stopwatch()..start();
    var events = 0;
    for (var index = 0; index < count; index += 1) {
      events = replay();
      await Future<void>.delayed(Duration(milliseconds: intervalMs));
    }
    await Future<void>.delayed(const Duration(seconds: 1));
    return <String, dynamic>{
      'replays': count,
      'events_per_snapshot': events,
      'duration_ms': watch.elapsedMilliseconds,
    };
  }
}
