import 'dart:convert';

/// UI-independent map data types shared by static assets and Android events.
class GeoPoint {
  const GeoPoint({required this.longitude, required this.latitude});

  final double longitude;
  final double latitude;

  @override
  bool operator ==(Object other) =>
      other is GeoPoint &&
      other.longitude == longitude &&
      other.latitude == latitude;

  @override
  int get hashCode => Object.hash(longitude, latitude);
}

sealed class MapGeometry {
  const MapGeometry();

  static MapGeometry? fromJson(Object? value) {
    final json = _asStringMap(value);
    if (json == null) return null;

    switch (json['type']) {
      case 'Point':
        final point = _pointFromCoordinates(json['coordinates']);
        return point == null ? null : PointGeometry(point);
      case 'LineString':
        final points = _pointsFromCoordinates(json['coordinates']);
        return points == null ? null : LineStringGeometry(points);
      case 'Polygon':
        final rings = _ringsFromCoordinates(json['coordinates']);
        return rings == null ? null : PolygonGeometry(rings);
      default:
        return null;
    }
  }
}

final class PointGeometry extends MapGeometry {
  const PointGeometry(this.point);

  final GeoPoint point;
}

final class LineStringGeometry extends MapGeometry {
  const LineStringGeometry(this.points);

  final List<GeoPoint> points;
}

final class PolygonGeometry extends MapGeometry {
  const PolygonGeometry(this.rings);

  final List<List<GeoPoint>> rings;
}

class StaticFeatureCollection {
  const StaticFeatureCollection({
    required this.schemaVersion,
    required this.datasetId,
    required this.snapshotAt,
    required this.features,
  });

  final String? schemaVersion;
  final String? datasetId;
  final String? snapshotAt;
  final List<StaticFeature> features;

  factory StaticFeatureCollection.fromJson(Map<String, dynamic> json) {
    final sourceFeatures = json['features'];
    final features =
        sourceFeatures is List
            ? sourceFeatures
                .map(_asStringMap)
                .whereType<Map<String, dynamic>>()
                .map(StaticFeature.fromJson)
                .toList(growable: false)
            : const <StaticFeature>[];

    return StaticFeatureCollection(
      schemaVersion: _asString(json['schema_version']),
      datasetId: _asString(json['dataset_id']),
      snapshotAt: _asString(json['snapshot_at']),
      features: features,
    );
  }
}

class StaticFeature {
  const StaticFeature({
    required this.id,
    required this.kind,
    required this.geometry,
    required this.fields,
    required this.properties,
  });

  final String? id;
  final String? kind;
  final MapGeometry? geometry;

  /// Root-level Task 2 fields such as name, address and available_count.
  /// Values intentionally retain JSON null when the source has no value.
  final Map<String, dynamic> fields;

  /// Optional nested GeoJSON-style properties, kept separate from root fields.
  final Map<String, dynamic>? properties;

  /// A Task 4-ready view of nested properties plus authoritative root fields.
  /// Root fields win on a key collision because they are the Task 2 contract.
  Map<String, dynamic> get details => Map<String, dynamic>.unmodifiable(
    <String, dynamic>{...?properties, ...fields},
  );

  factory StaticFeature.fromJson(Map<String, dynamic> json) => StaticFeature(
    id: _asString(json['id']),
    kind: _asString(json['kind']),
    geometry: MapGeometry.fromJson(json['geometry']),
    fields: _staticFeatureFields(json),
    properties: _asStringMap(json['properties']),
  );
}

/// Display state of a crowd report after government review (see
/// attestation_index.dart). Android's apply state is not changed by it.
enum CrowdVerification { unverified, confirmed, refuted }

class MeshEvent {
  const MeshEvent({
    required this.namespace,
    required this.eventId,
    required this.eventVersion,
    required this.eventType,
    required this.severity,
    required this.source,
    required this.issuedAt,
    required this.expiresAt,
    required this.applyState,
    required this.geometry,
    required this.attributes,
    this.payloadHash,
    this.signingKeyId,
    this.verification,
  });

  final String? namespace;
  final String? eventId;
  final int? eventVersion;
  final String? eventType;
  final String? severity;
  final String? source;
  final String? issuedAt;
  final String? expiresAt;
  final String? applyState;
  final MapGeometry? geometry;
  final Map<String, dynamic>? attributes;
  final String? payloadHash;
  final String? signingKeyId;

  /// Set only on crowd events, by AttestationIndex, for presentation.
  final CrowdVerification? verification;

  factory MeshEvent.fromJson(Map<String, dynamic> json) => MeshEvent(
    namespace: _asString(json['namespace']),
    eventId: _asString(json['event_id']),
    eventVersion: _asInt(json['event_version']),
    eventType: _asString(json['event_type']),
    severity: _asString(json['severity']),
    source: _asString(json['source']),
    issuedAt: _asString(json['issued_at']),
    expiresAt: _asString(json['expires_at']),
    applyState: _asString(json['apply_state']),
    geometry: MapGeometry.fromJson(json['geometry']),
    attributes: _asStringMap(json['attributes']),
    payloadHash: _asString(json['payload_hash']),
    signingKeyId: _asString(json['signing_key_id']),
  );

  MeshEvent copyWithVerification(CrowdVerification value) => MeshEvent(
    namespace: namespace,
    eventId: eventId,
    eventVersion: eventVersion,
    eventType: eventType,
    severity: severity,
    source: source,
    issuedAt: issuedAt,
    expiresAt: expiresAt,
    applyState: applyState,
    geometry: geometry,
    attributes: attributes,
    payloadHash: payloadHash,
    signingKeyId: signingKeyId,
    verification: value,
  );

  /// Keep the UI correct between native expiry ticks and while returning from background.
  String? get effectiveApplyState {
    final expires = _parseEventTime(expiresAt);
    if (applyState == 'EXPIRED' ||
        (expires != null && !expires.isAfter(DateTime.now().toUtc()))) {
      return 'EXPIRED';
    }
    return applyState;
  }

  bool get isExpired => effectiveApplyState == 'EXPIRED';

  /// Dynamic shelter status from FIRE_AGENCY is retired and must not enter
  /// the active map or alert stream.
  bool get isRetiredShelterStatus =>
      eventType == 'SHELTER_STATUS' && source == 'FIRE_AGENCY';

  /// Returns whether this event may be rendered as a current event.
  ///
  /// Android supplies [applyState] after Room ingestion. The Flutter-only
  /// NCDR demo has no Android state yet, so it falls back to the event's
  /// issued/expires time window. An explicit non-CURRENT Android state always
  /// wins over the raw timestamps.
  bool isCurrentAt([DateTime? now]) {
    final reference = (now ?? DateTime.now()).toUtc();
    if (applyState != null && applyState != 'CURRENT') return false;

    final issued = _parseEventTime(issuedAt);
    final expires = _parseEventTime(expiresAt);
    if (expires == null || !expires.isAfter(reference)) return false;
    return issued == null || !issued.isAfter(reference);
  }

  /// Whether the map should draw this event now: current official data, plus
  /// live UNVERIFIED crowd reports, which are shown (marked as unverified)
  /// rather than hidden. Expired events are never drawn.
  bool isShownAt([DateTime? now]) {
    if (applyState != 'UNVERIFIED') return isCurrentAt(now);
    final expires = _parseEventTime(expiresAt);
    return expires != null && expires.isAfter((now ?? DateTime.now()).toUtc());
  }

  bool get isUnverified =>
      applyState == 'UNVERIFIED' && verification != CrowdVerification.confirmed;
}

DateTime? _parseEventTime(String? value) {
  final parsed = value == null ? null : DateTime.tryParse(value);
  return parsed?.toUtc();
}

/// Stable event identity shared by persistence presentation and map overlays.
/// JSON encoding preserves the tuple boundaries when any field contains a
/// delimiter character.
String meshEventIdentity(MeshEvent event) =>
    jsonEncode(<Object?>[event.namespace, event.eventId, event.eventVersion]);

/// Provider-neutral point used when focusing an event on either map renderer.
GeoPoint? meshEventFocusPoint(MeshEvent event) => switch (event.geometry) {
  PointGeometry(:final point) => point,
  LineStringGeometry(:final points) => _averageGeoPoint(points),
  PolygonGeometry(:final rings) => _boundsCenter(rings.expand((ring) => ring)),
  _ => null,
};

GeoPoint? _averageGeoPoint(Iterable<GeoPoint> points) {
  var count = 0;
  var longitude = 0.0;
  var latitude = 0.0;
  for (final point in points) {
    longitude += point.longitude;
    latitude += point.latitude;
    count += 1;
  }
  if (count == 0) return null;
  return GeoPoint(longitude: longitude / count, latitude: latitude / count);
}

GeoPoint? _boundsCenter(Iterable<GeoPoint> points) {
  var hasPoint = false;
  var minLongitude = 0.0;
  var maxLongitude = 0.0;
  var minLatitude = 0.0;
  var maxLatitude = 0.0;
  for (final point in points) {
    if (!hasPoint) {
      minLongitude = maxLongitude = point.longitude;
      minLatitude = maxLatitude = point.latitude;
      hasPoint = true;
      continue;
    }
    if (point.longitude < minLongitude) minLongitude = point.longitude;
    if (point.longitude > maxLongitude) maxLongitude = point.longitude;
    if (point.latitude < minLatitude) minLatitude = point.latitude;
    if (point.latitude > maxLatitude) maxLatitude = point.latitude;
  }
  if (!hasPoint) return null;
  return GeoPoint(
    longitude: (minLongitude + maxLongitude) / 2,
    latitude: (minLatitude + maxLatitude) / 2,
  );
}

class MapInitialState {
  const MapInitialState({
    required this.events,
    required this.emergencyModeEnabled,
    this.staticFeatures = const <StaticFeature>[],
  });

  final List<MeshEvent> events;
  final bool emergencyModeEnabled;
  final List<StaticFeature> staticFeatures;

  factory MapInitialState.fromJson(Map<String, dynamic> json) {
    if (!json.containsKey('events')) {
      throw const FormatException('getInitialState response is missing events');
    }
    if (!json.containsKey('emergency_mode_enabled') ||
        json['emergency_mode_enabled'] is! bool) {
      throw const FormatException(
        'getInitialState response is missing boolean emergency_mode_enabled',
      );
    }

    return MapInitialState(
      events: eventsFromMessage(json['events']),
      emergencyModeEnabled: json['emergency_mode_enabled'] as bool,
      staticFeatures: staticFeaturesFromMessage(json['static_features']),
    );
  }
}

/// Verified static features as Android sends them (`static_features`).
List<StaticFeature> staticFeaturesFromMessage(Object? value) =>
    (value is List ? value : const <Object?>[])
        .map(_asStringMap)
        .whereType<Map<String, dynamic>>()
        .map(StaticFeature.fromJson)
        .toList(growable: false);

class FixtureLoadSummary {
  const FixtureLoadSummary({
    required this.processed,
    required this.inserted,
    required this.updated,
    required this.rejected,
  });

  final int processed;
  final int inserted;
  final int updated;
  final int rejected;

  factory FixtureLoadSummary.fromJson(Map<String, dynamic> json) =>
      FixtureLoadSummary(
        processed: _requiredInt(json, 'processed'),
        inserted: _requiredInt(json, 'inserted'),
        updated: _requiredInt(json, 'updated'),
        rejected: _requiredInt(json, 'rejected'),
      );
}

List<MeshEvent> eventsFromMessage(Object? value) {
  if (value is! List) {
    throw const FormatException('EventChannel payload must be a list');
  }

  return List<MeshEvent>.generate(value.length, (index) {
    final event = _asStringMap(value[index]);
    if (event == null) {
      throw FormatException(
        'EventChannel payload at index $index must be a map',
      );
    }
    return MeshEvent.fromJson(event);
  }, growable: false);
}

Map<String, dynamic> requireMapFromMessage(Object? value, String context) {
  final map = _asStringMap(value);
  if (map == null) throw FormatException('$context must be a map');
  return map;
}

Map<String, dynamic> _staticFeatureFields(Map<String, dynamic> json) {
  const structuralKeys = <String>{'id', 'kind', 'geometry', 'properties'};
  final fields = Map<String, dynamic>.from(json)
    ..removeWhere((key, _) => structuralKeys.contains(key));
  return Map<String, dynamic>.unmodifiable(fields);
}

Map<String, dynamic>? _asStringMap(Object? value) {
  if (value is! Map) return null;
  return Map<String, dynamic>.unmodifiable(
    Map<String, dynamic>.fromEntries(
      value.entries.map((entry) => MapEntry(entry.key.toString(), entry.value)),
    ),
  );
}

int _requiredInt(Map<String, dynamic> json, String key) {
  final value = _asInt(json[key]);
  if (!json.containsKey(key) || value == null) {
    throw FormatException(
      'loadBundledFixture response is missing integer $key',
    );
  }
  return value;
}

String? _asString(Object? value) => value is String ? value : null;

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num && value == value.roundToDouble()) return value.toInt();
  return value is String ? int.tryParse(value) : null;
}

double? _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  return value is String ? double.tryParse(value) : null;
}

GeoPoint? _pointFromCoordinates(Object? value) {
  if (value is! List || value.length < 2) return null;
  final longitude = _asDouble(value[0]);
  final latitude = _asDouble(value[1]);
  if (longitude == null || latitude == null) return null;
  return GeoPoint(longitude: longitude, latitude: latitude);
}

List<GeoPoint>? _pointsFromCoordinates(Object? value) {
  if (value is! List) return null;
  final points = value.map(_pointFromCoordinates).toList(growable: false);
  if (points.any((point) => point == null)) return null;
  return points.cast<GeoPoint>();
}

List<List<GeoPoint>>? _ringsFromCoordinates(Object? value) {
  if (value is! List) return null;
  final rings = value.map(_pointsFromCoordinates).toList(growable: false);
  if (rings.any((ring) => ring == null)) return null;
  return rings.cast<List<GeoPoint>>();
}
