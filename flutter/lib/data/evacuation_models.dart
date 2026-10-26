import 'dart:convert';
import 'dart:math' as math;

import 'map_models.dart';
import 'supply_status.dart';

enum DisasterType {
  flood('flood', '水災'),
  earthquake('earthquake', '震災'),
  debrisFlow('debris_flow', '土石流'),
  tsunami('tsunami', '海嘯'),
  nuclear('nuclear', '核子事故'),
  landslide('landslide', '坡地災害');

  const DisasterType(this.wireValue, this.label);
  final String wireValue, label;
}

enum ShelterDisasterEligibility { compatible, incompatible, unknown }

ShelterDisasterEligibility shelterDisasterEligibility(
  StaticFeature shelter,
  DisasterType type,
) {
  final raw = shelter.details['disaster_types'];
  final labels =
      raw is List
          ? raw.whereType<String>().map((value) => value.trim()).toSet()
          : <String>{};
  final known = labels.intersection(
    DisasterType.values.map((value) => value.label).toSet(),
  );
  if (known.isEmpty) return ShelterDisasterEligibility.unknown;
  return known.contains(type.label)
      ? ShelterDisasterEligibility.compatible
      : ShelterDisasterEligibility.incompatible;
}

enum EvacuationRouteStatus { ok, noRoute, graphUnavailable, invalidInput }

extension EvacuationRouteStatusWire on EvacuationRouteStatus {
  String get wireValue => switch (this) {
    EvacuationRouteStatus.ok => 'ok',
    EvacuationRouteStatus.noRoute => 'no_route',
    EvacuationRouteStatus.graphUnavailable => 'graph_unavailable',
    EvacuationRouteStatus.invalidInput => 'invalid_input',
  };

  static EvacuationRouteStatus fromWire(Object? value) => switch (value) {
    'ok' => EvacuationRouteStatus.ok,
    'no_route' => EvacuationRouteStatus.noRoute,
    'graph_unavailable' => EvacuationRouteStatus.graphUnavailable,
    'invalid_input' => EvacuationRouteStatus.invalidInput,
    _ => throw FormatException('Unknown evacuation route status: $value'),
  };
}

/// Only shelters carry opening status and disaster eligibility; medical and
/// supply routes are plain walking directions, not evacuation guidance.
enum RouteDestinationKind {
  shelter('shelter'),
  medical('medical'),
  supply('supply');

  const RouteDestinationKind(this.wireValue);
  final String wireValue;
}

final class ShelterRouteCandidate {
  const ShelterRouteCandidate({
    required this.id,
    required this.location,
    this.kind = RouteDestinationKind.shelter,
  });

  final String id;
  final GeoPoint location;
  final RouteDestinationKind kind;

  Map<String, Object?> toChannelArguments() => <String, Object?>{
    'id': id,
    'lon': location.longitude,
    'lat': location.latitude,
    'kind': kind.wireValue,
  };
}

/// A place the user asked to walk to. Supply points are events that can be
/// updated, expire or be withdrawn, so [supplyKey] finds their latest version
/// again before every request.
final class RouteDestination {
  const RouteDestination._({
    required this.kind,
    required this.name,
    required this.candidate,
    this.supplyKey,
  });

  final RouteDestinationKind kind;
  final String name;
  final ShelterRouteCandidate candidate;
  final String? supplyKey;

  bool get isShelter => kind == RouteDestinationKind.shelter;

  static RouteDestination? fromFeature(
    StaticFeature feature, {
    required String name,
  }) {
    final kind = switch (feature.kind) {
      'shelter' => RouteDestinationKind.shelter,
      'medical' => RouteDestinationKind.medical,
      _ => null,
    };
    final id = feature.id;
    final geometry = feature.geometry;
    if (kind == null ||
        id == null ||
        id.isEmpty ||
        geometry is! PointGeometry ||
        !_validPoint(geometry.point)) {
      return null;
    }
    return RouteDestination._(
      kind: kind,
      name: name,
      candidate: ShelterRouteCandidate(
        id: id,
        location: geometry.point,
        kind: kind,
      ),
    );
  }

  static RouteDestination? fromSupplyEvent(
    MeshEvent event, {
    required String name,
  }) {
    if (!isRoutableSupplyEvent(event)) return null;
    return RouteDestination._(
      kind: RouteDestinationKind.supply,
      name: name,
      candidate: ShelterRouteCandidate(
        id: meshEventIdentity(event),
        location: (event.geometry! as PointGeometry).point,
        kind: RouteDestinationKind.supply,
      ),
      supplyKey: supplyEventKey(event),
    );
  }
}

/// Supply distribution points and supply station announcements with an
/// exact map point; area-only announcements have nowhere to walk to.
bool isRoutableSupplyEvent(MeshEvent event) {
  if (!isSupplyEvent(event) && !isSupplyStationEvent(event)) return false;
  if (isSupplyStationEvent(event) &&
      event.attributes?['has_map_location'] != true) {
    return false;
  }
  final eventId = event.eventId;
  final geometry = event.geometry;
  return eventId != null &&
      eventId.isNotEmpty &&
      geometry is PointGeometry &&
      _validPoint(geometry.point);
}

/// Identity of a supply point across versions, unlike [meshEventIdentity].
String supplyEventKey(MeshEvent event) =>
    jsonEncode(<Object?>[event.namespace, event.eventId]);

/// Latest stored version of the supply point, or null once it is withdrawn:
/// removed from storage or republished as a retraction.
MeshEvent? latestSupplyEvent(Iterable<MeshEvent> events, String key) {
  MeshEvent? latest;
  for (final event in events) {
    if (!isRoutableSupplyEvent(event) || supplyEventKey(event) != key) continue;
    if (latest == null ||
        (event.eventVersion ?? 0) > (latest.eventVersion ?? 0)) {
      latest = event;
    }
  }
  if (latest?.attributes?['publication_retracted'] == true) return null;
  return latest;
}

/// A poor supply status is a warning, never a reason to hide the route:
/// unknown or exhausted stock may still be worth checking in person.
List<RouteWarning> supplyRouteWarnings(MeshEvent event, [DateTime? now]) {
  final eventId = event.eventId;
  if (!event.isCurrentAt(now)) {
    return <RouteWarning>[
      RouteWarning(
        code: 'SUPPLY_STATUS_EXPIRED',
        eventId: eventId,
        message: '物資資訊已過期或未查證，請現場確認',
      ),
    ];
  }
  if (!isSupplyEvent(event)) return const <RouteWarning>[];
  final (code, message) = switch (SupplyStatus(event).data['status']) {
    'AVAILABLE' => (null, null),
    'PAUSED' => ('SUPPLY_PAUSED', '官方狀態顯示此物資點暫停發放'),
    'EXHAUSTED' => ('SUPPLY_EXHAUSTED', '官方狀態顯示此物資點已發完'),
    'CLOSED' => ('SUPPLY_CLOSED', '官方狀態顯示此物資點已結束發放'),
    _ => ('SUPPLY_STATUS_UNKNOWN', '沒有此物資點的供應狀態，請現場確認'),
  };
  if (code == null || message == null) return const <RouteWarning>[];
  return <RouteWarning>[
    RouteWarning(code: code, eventId: eventId, message: message),
  ];
}

List<ShelterRouteCandidate> shortlistShelterCandidates(
  GeoPoint origin,
  Iterable<StaticFeature> shelters, {
  int limit = 5,
  double maxDistanceM = double.infinity,
  DisasterType? disasterType,
}) {
  final cappedLimit = limit.clamp(0, 50).toInt();
  if (cappedLimit == 0 || !_validPoint(origin)) {
    return const <ShelterRouteCandidate>[];
  }

  final ranked = <_ShelterCandidateDistance>[];
  for (final shelter in shelters) {
    if (shelter.kind != 'shelter') continue;
    if (disasterType != null &&
        shelterDisasterEligibility(shelter, disasterType) ==
            ShelterDisasterEligibility.incompatible) {
      continue;
    }
    final id = shelter.id;
    final geometry = shelter.geometry;
    if (id == null || id.isEmpty || geometry is! PointGeometry) continue;
    if (!_validPoint(geometry.point)) continue;
    if (shelterAirDistanceM(origin, geometry.point) > maxDistanceM) continue;
    ranked.add(
      _ShelterCandidateDistance(
        candidate: ShelterRouteCandidate(id: id, location: geometry.point),
        airDistanceSquared:
            math.pow(shelterAirDistanceM(origin, geometry.point), 2).toDouble(),
      ),
    );
  }
  ranked.sort((left, right) {
    final distanceOrder = left.airDistanceSquared.compareTo(
      right.airDistanceSquared,
    );
    if (distanceOrder != 0) return distanceOrder;
    return left.candidate.id.compareTo(right.candidate.id);
  });
  return ranked
      .take(cappedLimit)
      .map((entry) => entry.candidate)
      .toList(growable: false);
}

double shelterAirDistanceM(GeoPoint origin, GeoPoint destination) {
  final lat1 = origin.latitude * math.pi / 180;
  final lat2 = destination.latitude * math.pi / 180;
  final dLat = lat2 - lat1;
  final dLon = (destination.longitude - origin.longitude) * math.pi / 180;
  final a =
      math.pow(math.sin(dLat / 2), 2) +
      math.cos(lat1) * math.cos(lat2) * math.pow(math.sin(dLon / 2), 2);
  return 6371000 * 2 * math.asin(math.sqrt(a.clamp(0, 1)));
}

final class _ShelterCandidateDistance {
  const _ShelterCandidateDistance({
    required this.candidate,
    required this.airDistanceSquared,
  });

  final ShelterRouteCandidate candidate;
  final double airDistanceSquared;
}

bool _validPoint(GeoPoint point) =>
    point.longitude.isFinite &&
    point.latitude.isFinite &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    point.latitude >= -90 &&
    point.latitude <= 90;

final class RouteWarning {
  const RouteWarning({
    required this.code,
    required this.eventId,
    required this.message,
  });

  final String code;
  final String? eventId;
  final String message;

  factory RouteWarning.fromMessage(Object? value) {
    final map = _asMap(value, 'route warning');
    final code = map['code'];
    final message = map['message'];
    final eventId = map['event_id'];
    if (code is! String ||
        code.isEmpty ||
        message is! String ||
        message.isEmpty) {
      throw const FormatException('route warning is missing code or message');
    }
    if (eventId != null && eventId is! String) {
      throw const FormatException('route warning event_id must be a string');
    }
    return RouteWarning(
      code: code,
      eventId: eventId as String?,
      message: message,
    );
  }
}

final class EvacuationRouteResult {
  const EvacuationRouteResult({
    required this.status,
    required this.polyline,
    required this.distanceM,
    required this.durationS,
    required this.graphVersion,
    required this.eventSnapshotAt,
    required this.warnings,
    required this.blockedEventIds,
  });

  final EvacuationRouteStatus status;
  final List<GeoPoint> polyline;
  final double? distanceM;
  final double? durationS;
  final String? graphVersion;
  final String? eventSnapshotAt;
  final List<RouteWarning> warnings;
  final List<String> blockedEventIds;

  EvacuationRouteResult withWarning(RouteWarning warning) =>
      EvacuationRouteResult(
        status: status,
        polyline: polyline,
        distanceM: distanceM,
        durationS: durationS,
        graphVersion: graphVersion,
        eventSnapshotAt: eventSnapshotAt,
        warnings: <RouteWarning>[...warnings, warning],
        blockedEventIds: blockedEventIds,
      );

  factory EvacuationRouteResult.fromMessage(Map<String, dynamic> message) {
    final status = EvacuationRouteStatusWire.fromWire(message['status']);
    final warnings = _warnings(message['warnings']);
    final blockedEventIds = _blockedEventIds(message['blocked_event_ids']);
    if (status != EvacuationRouteStatus.ok) {
      return EvacuationRouteResult(
        status: status,
        polyline: const <GeoPoint>[],
        distanceM: null,
        durationS: null,
        graphVersion: _optionalString(message['graph_version']),
        eventSnapshotAt: _optionalString(message['event_snapshot_at']),
        warnings: warnings,
        blockedEventIds: blockedEventIds,
      );
    }

    final polyline = _polyline(message['polyline']);
    if (polyline.length < 2) {
      throw const FormatException(
        'ok route needs at least two polyline points',
      );
    }
    final distanceM = _requiredNonNegativeNumber(message['distance_m']);
    final durationS = _requiredNonNegativeNumber(message['duration_s']);
    final graphVersion = _requiredString(message['graph_version']);
    final eventSnapshotAt = _requiredString(message['event_snapshot_at']);
    return EvacuationRouteResult(
      status: status,
      polyline: polyline,
      distanceM: distanceM,
      durationS: durationS,
      graphVersion: graphVersion,
      eventSnapshotAt: eventSnapshotAt,
      warnings: warnings,
      blockedEventIds: blockedEventIds,
    );
  }
}

/// Camera bounds that show a whole drawable route. Very short routes are
/// widened so the camera does not jump to maximum zoom on a few metres.
GeoBounds? routeFocusBounds(
  EvacuationRouteResult route, {
  double minSpanDegrees = 0.002,
}) {
  if (route.status != EvacuationRouteStatus.ok || route.polyline.length < 2) {
    return null;
  }
  var west = route.polyline.first.longitude;
  var east = west;
  var south = route.polyline.first.latitude;
  var north = south;
  for (final point in route.polyline.skip(1)) {
    west = math.min(west, point.longitude);
    east = math.max(east, point.longitude);
    south = math.min(south, point.latitude);
    north = math.max(north, point.latitude);
  }
  final widenLongitude = math.max(0, minSpanDegrees - (east - west)) / 2;
  final widenLatitude = math.max(0, minSpanDegrees - (north - south)) / 2;
  return GeoBounds(
    southwest: GeoPoint(
      longitude: west - widenLongitude,
      latitude: south - widenLatitude,
    ),
    northeast: GeoPoint(
      longitude: east + widenLongitude,
      latitude: north + widenLatitude,
    ),
  );
}

List<RouteWarning> _warnings(Object? value) {
  if (value == null) return const <RouteWarning>[];
  if (value is! List) throw const FormatException('warnings must be a list');
  return value.map(RouteWarning.fromMessage).toList(growable: false);
}

List<String> _blockedEventIds(Object? value) {
  if (value == null) return const <String>[];
  if (value is! List || value.any((item) => item is! String)) {
    throw const FormatException('blocked_event_ids must be a string list');
  }
  return value.cast<String>().toList(growable: false);
}

List<GeoPoint> _polyline(Object? value) {
  if (value is! List) throw const FormatException('polyline must be a list');
  return value.map(_point).toList(growable: false);
}

GeoPoint _point(Object? value) {
  if (value is! List ||
      value.length != 2 ||
      value[0] is! num ||
      value[1] is! num) {
    throw const FormatException('route coordinate must be [lon, lat]');
  }
  final longitude = (value[0] as num).toDouble();
  final latitude = (value[1] as num).toDouble();
  if (!longitude.isFinite ||
      !latitude.isFinite ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90) {
    throw const FormatException('route coordinate is invalid');
  }
  return GeoPoint(longitude: longitude, latitude: latitude);
}

double _requiredNonNegativeNumber(Object? value) {
  if (value is! num || !value.isFinite || value < 0) {
    throw const FormatException('route metric must be non-negative');
  }
  return value.toDouble();
}

String _requiredString(Object? value) {
  if (value is! String || value.isEmpty) {
    throw const FormatException('route response is missing a required string');
  }
  return value;
}

String? _optionalString(Object? value) {
  if (value == null) return null;
  if (value is! String) {
    throw const FormatException('route value must be a string');
  }
  return value;
}

Map<String, dynamic> _asMap(Object? value, String context) {
  if (value is! Map) throw FormatException('$context must be a map');
  return Map<String, dynamic>.fromEntries(
    value.entries.map((entry) => MapEntry(entry.key.toString(), entry.value)),
  );
}
