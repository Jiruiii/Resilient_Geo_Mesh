import 'dart:convert';

import '../data/map_models.dart';

final class ShowcaseRouteCatalog {
  const ShowcaseRouteCatalog({
    required this.graphVersion,
    required this.blockedEventId,
    required this.routes,
  });

  final String graphVersion;
  final String blockedEventId;
  final Map<String, ShowcasePrecomputedRoute> routes;

  static ShowcaseRouteCatalog fromJson(String source) {
    final json = jsonDecode(source) as Map<String, dynamic>;
    if (json['schema_version'] != 'showcase-routes-v1') {
      throw const FormatException('Unsupported showcase route data');
    }
    final graphVersion = json['graph_version'];
    final blockedEventId = json['blocked_event_id'];
    final rawRoutes = json['routes'];
    if (graphVersion is! String ||
        blockedEventId is! String ||
        rawRoutes is! Map<String, dynamic>) {
      throw const FormatException('Showcase route data is incomplete');
    }
    return ShowcaseRouteCatalog(
      graphVersion: graphVersion,
      blockedEventId: blockedEventId,
      routes: Map<String, ShowcasePrecomputedRoute>.unmodifiable(
        rawRoutes.map(
          (id, value) => MapEntry(
            id,
            ShowcasePrecomputedRoute.fromJson(
              Map<String, dynamic>.from(value as Map),
            ),
          ),
        ),
      ),
    );
  }
}

final class ShowcasePrecomputedRoute {
  const ShowcasePrecomputedRoute({
    required this.distanceM,
    required this.polyline,
    this.detourDistanceM,
    this.detourPolyline,
  });

  final double distanceM;
  final List<GeoPoint> polyline;
  final double? detourDistanceM;
  final List<GeoPoint>? detourPolyline;

  factory ShowcasePrecomputedRoute.fromJson(Map<String, dynamic> json) {
    final distance = json['distance_m'];
    final rawPolyline = json['polyline'];
    final detourDistance = json['detour_distance_m'];
    final rawDetour = json['detour_polyline'];
    if (distance is! num || rawPolyline is! List<dynamic>) {
      throw const FormatException('Showcase route is incomplete');
    }
    if ((detourDistance == null) != (rawDetour == null) ||
        (detourDistance != null &&
            (detourDistance is! num || rawDetour is! List<dynamic>))) {
      throw const FormatException('Showcase route detour is incomplete');
    }
    return ShowcasePrecomputedRoute(
      distanceM: distance.toDouble(),
      polyline: _polyline(rawPolyline),
      detourDistanceM: (detourDistance as num?)?.toDouble(),
      detourPolyline:
          rawDetour == null ? null : _polyline(rawDetour as List<dynamic>),
    );
  }

  static List<GeoPoint> _polyline(List<dynamic> raw) {
    if (raw.length < 2) {
      throw const FormatException('Showcase route needs two or more points');
    }
    return List<GeoPoint>.unmodifiable(
      raw.map((value) {
        if (value is! List<dynamic> ||
            value.length < 2 ||
            value[0] is! num ||
            value[1] is! num) {
          throw const FormatException('Showcase route point is invalid');
        }
        return GeoPoint(
          longitude: (value[0] as num).toDouble(),
          latitude: (value[1] as num).toDouble(),
        );
      }),
    );
  }
}
