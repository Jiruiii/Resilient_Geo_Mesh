import 'dart:convert';

import 'package:flutter/services.dart';

import 'map_models.dart';

/// Small display boundaries bundled with Web and Android. The server's full
/// administrative geometry remains the source of truth for area matching.
class CwaCountyWarningOverlay {
  const CwaCountyWarningOverlay._();

  static const assetPath = 'assets/map/boundaries/cwa-county-warning.geojson';
  static final RegExp _countyAreaId = RegExp(r'^tw\.\d{5}$');

  static Future<Map<String, Map<String, dynamic>>> load({
    AssetBundle? bundle,
  }) async {
    final json = jsonDecode(await (bundle ?? rootBundle).loadString(assetPath));
    if (json is! Map<String, dynamic> ||
        json['type'] != 'FeatureCollection' ||
        json['features'] is! List) {
      throw const FormatException('Invalid CWA county boundary asset');
    }
    final features = <String, Map<String, dynamic>>{};
    for (final feature in json['features'] as List<dynamic>) {
      if (feature is! Map<String, dynamic> ||
          feature['properties'] is! Map<String, dynamic> ||
          feature['geometry'] is! Map<String, dynamic>) {
        throw const FormatException('Invalid CWA county boundary feature');
      }
      final areaId = (feature['properties'] as Map<String, dynamic>)['area_id'];
      final geometry = feature['geometry'] as Map<String, dynamic>;
      if (areaId is! String ||
          !_countyAreaId.hasMatch(areaId) ||
          !const <String>{
            'Polygon',
            'MultiPolygon',
          }.contains(geometry['type']) ||
          features.containsKey(areaId)) {
        throw const FormatException('Invalid CWA county boundary area');
      }
      features[areaId] = feature;
    }
    if (features.length != 22) {
      throw const FormatException('Incomplete CWA county boundary asset');
    }
    return Map<String, Map<String, dynamic>>.unmodifiable(features);
  }

  static Map<String, dynamic> featureCollection(
    Iterable<MeshEvent> events,
    Map<String, Map<String, dynamic>> counties, {
    DateTime? now,
  }) {
    final reference = (now ?? DateTime.now()).toUtc();
    final areaIds = currentAreaIds(events, now: reference).toList()..sort();
    return <String, dynamic>{
      'type': 'FeatureCollection',
      'features': <Map<String, dynamic>>[
        for (final areaId in areaIds)
          if (counties.containsKey(areaId)) counties[areaId]!,
      ],
    };
  }

  /// Includes warnings announced in the feed for a future affected period.
  static Set<String> currentAreaIds(
    Iterable<MeshEvent> events, {
    DateTime? now,
  }) {
    final reference = (now ?? DateTime.now()).toUtc();
    final ids = <String>{};
    for (final event in events) {
      if (!event.isCwaCountyWarning ||
          !(event.isCurrentAt(reference) ||
              event.isUpcomingCwaCountyWarningAt(reference))) {
        continue;
      }
      final areaId = event.attributes?['area_id'];
      if (areaId is String && _countyAreaId.hasMatch(areaId)) {
        ids.add(areaId);
      }
    }
    return ids;
  }

  static DateTime? nextExpiry(Iterable<MeshEvent> events, {DateTime? now}) {
    final reference = (now ?? DateTime.now()).toUtc();
    DateTime? next;
    for (final event in events) {
      if (!event.isCwaCountyWarning ||
          !(event.isCurrentAt(reference) ||
              event.isUpcomingCwaCountyWarningAt(reference))) {
        continue;
      }
      final expiry = DateTime.tryParse(event.expiresAt ?? '')?.toUtc();
      if (expiry != null && (next == null || expiry.isBefore(next))) {
        next = expiry;
      }
    }
    return next;
  }
}
