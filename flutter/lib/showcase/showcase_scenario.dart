import 'dart:convert';

import 'package:flutter/services.dart';

import '../data/map_models.dart';
import 'showcase_clock.dart';
import 'showcase_route_data.dart';

final class ShowcaseScenario {
  const ShowcaseScenario({
    required this.features,
    required this.events,
    required this.delayedEvents,
    required this.origin,
    required this.routes,
  });

  final StaticFeatureCollection features;
  final List<MeshEvent> events;
  final List<MeshEvent> delayedEvents;
  final GeoPoint origin;
  final ShowcaseRouteCatalog routes;

  static Future<ShowcaseScenario> load() async {
    final assets = await Future.wait<String>(<Future<String>>[
      rootBundle.loadString('assets/data/showcase/scenario.json'),
      rootBundle.loadString('assets/data/showcase/routes.json'),
    ]);
    final json = jsonDecode(assets[0]) as Map<String, dynamic>;
    final scenarioAt = DateTime.parse(json['scenario_at'] as String).toUtc();
    if (scenarioAt != ShowcaseClock.scenarioTime) {
      throw const FormatException(
        'Showcase scenario clock does not match asset',
      );
    }
    final coordinates = json['origin'] as List<dynamic>;
    return ShowcaseScenario(
      features: StaticFeatureCollection.fromJson(json),
      events: _events(json['events']),
      delayedEvents: _events(json['delayed_events']),
      origin: GeoPoint(
        longitude: (coordinates[0] as num).toDouble(),
        latitude: (coordinates[1] as num).toDouble(),
      ),
      routes: ShowcaseRouteCatalog.fromJson(assets[1]),
    );
  }

  static List<MeshEvent> _events(Object? raw) {
    if (raw is! List<dynamic>) {
      throw const FormatException('Showcase events must be a list');
    }
    return raw
        .map(
          (value) =>
              MeshEvent.fromJson(Map<String, dynamic>.from(value as Map)),
        )
        .toList(growable: false);
  }
}
