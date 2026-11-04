import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/ncdr_map_filter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'bundled showcase contains fixed facilities and visible warnings',
    () async {
      final raw = await rootBundle.loadString(
        'assets/data/showcase/scenario.json',
      );
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final now = DateTime.parse(data['scenario_at'] as String);
      final features = StaticFeatureCollection.fromJson(data);
      expect(features.snapshotAt, isNull);
      final events =
          (data['events'] as List<dynamic>)
              .map(
                (value) =>
                    MeshEvent.fromJson(Map<String, dynamic>.from(value as Map)),
              )
              .toList();

      expect(now.toUtc(), DateTime.utc(2026, 11, 4, 2));
      expect(
        features.features.where((feature) => feature.kind == 'medical').length,
        greaterThanOrEqualTo(4),
      );
      expect(
        features.features.where((feature) => feature.kind == 'shelter').length,
        greaterThanOrEqualTo(10),
      );
      expect(events.length, greaterThanOrEqualTo(3));
      expect(
        events.every(
          (event) => event.isShownAt(now) && isMapVisibleEvent(event),
        ),
        isTrue,
      );
      expect(
        events.every((event) => event.attributes?['is_demo'] == true),
        isTrue,
      );
    },
  );

  test(
    'bundled alert waits for the showcase timer and sits on the route',
    () async {
      final raw = await rootBundle.loadString(
        'assets/data/showcase/scenario.json',
      );
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final delayed =
          (data['delayed_events'] as List<dynamic>)
              .map(
                (value) =>
                    MeshEvent.fromJson(Map<String, dynamic>.from(value as Map)),
              )
              .toList();
      expect(delayed, hasLength(1));
      expect(delayed.single.eventType, 'ROAD_CLOSED');
      expect(delayed.single.eventId, 'showcase:route-road-closed');
      expect(meshEventFocusPoint(delayed.single), isNotNull);
      expect(
        delayed.single.isShownAt(DateTime.parse(data['scenario_at'] as String)),
        isTrue,
      );
      expect(isMapVisibleEvent(delayed.single), isTrue);
      expect(data['events'], isA<List<dynamic>>());
      expect(
        (data['events'] as List<dynamic>).any(
          (value) =>
              (value as Map<String, dynamic>)['event_id'] ==
              'showcase:route-road-closed',
        ),
        isFalse,
      );
    },
  );

  test(
    'precomputed showcase routes follow roads and include a closure detour',
    () async {
      final raw = await rootBundle.loadString(
        'assets/data/showcase/routes.json',
      );
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final routes = data['routes'] as Map<String, dynamic>;
      final route = routes['shelter:5558'] as Map<String, dynamic>;
      final normal = route['polyline'] as List<dynamic>;
      final detour = route['detour_polyline'] as List<dynamic>;

      expect(normal.length, greaterThan(3));
      expect(detour.length, greaterThan(3));
      expect(route['distance_m'], greaterThan(300));
      expect(route['detour_distance_m'], greaterThan(route['distance_m']));
      expect(data['blocked_event_id'], 'showcase:route-road-closed');
      expect(data['blocked_way_id'], 203384045);
    },
  );
}
