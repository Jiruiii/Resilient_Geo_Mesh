import 'map_models.dart';

/// Finds a currently visible NCDR administrative-area warning at [point].
///
/// Using the signed event geometry directly keeps area taps consistent on Web
/// and Android, even when the map renderer does not return fill-layer hits.
MeshEvent? ncdrAreaWarningAtCoordinate(
  Iterable<MeshEvent> events,
  GeoPoint point, {
  DateTime? now,
}) {
  final reference = (now ?? DateTime.now()).toUtc();
  for (final event in events) {
    if (event.hasCompleteNcdrAreaMask &&
        event.isShownAt(reference) &&
        _containsGeometry(event.geometry!, point)) {
      return event;
    }
  }
  return null;
}

/// Finds the most relevant visible CWA county warning under [point].
///
/// County boundaries are bundled display geometry, while warning identity and
/// validity remain on the complete event records supplied by the server.
MeshEvent? cwaCountyWarningAtCoordinate(
  Iterable<MeshEvent> events,
  Map<String, Map<String, dynamic>> counties,
  GeoPoint point, {
  DateTime? now,
}) {
  final reference = (now ?? DateTime.now()).toUtc();
  MeshEvent? selected;
  var selectedIsCurrent = false;
  var selectedIssuedAt = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

  for (final event in events) {
    if (!event.isCwaCountyWarning) continue;
    final isCurrent = event.isCurrentAt(reference);
    if (!isCurrent && !event.isUpcomingCwaCountyWarningAt(reference)) continue;

    final areaId = event.attributes?['area_id'];
    if (areaId is! String) continue;
    final geometry = counties[areaId]?['geometry'];
    if (!_containsGeoJsonGeometry(geometry, point)) continue;

    final issuedAt =
        DateTime.tryParse(event.issuedAt ?? '')?.toUtc() ??
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
    if (selected == null ||
        (isCurrent && !selectedIsCurrent) ||
        (isCurrent == selectedIsCurrent &&
            issuedAt.isAfter(selectedIssuedAt))) {
      selected = event;
      selectedIsCurrent = isCurrent;
      selectedIssuedAt = issuedAt;
    }
  }
  return selected;
}

bool _containsGeometry(MapGeometry geometry, GeoPoint point) =>
    switch (geometry) {
      PolygonGeometry(:final rings) => _containsPolygon(rings, point),
      MultiPolygonGeometry(:final polygons) => polygons.any(
        (polygon) => _containsPolygon(polygon, point),
      ),
      _ => false,
    };

bool _containsGeoJsonGeometry(Object? value, GeoPoint point) {
  if (value is! Map) return false;
  final type = value['type'];
  final coordinates = value['coordinates'];
  return switch (type) {
    'Polygon' => _containsPolygon(_geoJsonRings(coordinates), point),
    'MultiPolygon' =>
      coordinates is List &&
          coordinates.any(
            (polygon) => _containsPolygon(_geoJsonRings(polygon), point),
          ),
    _ => false,
  };
}

List<List<GeoPoint>> _geoJsonRings(Object? coordinates) {
  if (coordinates is! List) return const <List<GeoPoint>>[];
  final rings = <List<GeoPoint>>[];
  for (final ring in coordinates) {
    if (ring is! List) return const <List<GeoPoint>>[];
    final points = <GeoPoint>[];
    for (final coordinate in ring) {
      if (coordinate is! List ||
          coordinate.length < 2 ||
          coordinate[0] is! num ||
          coordinate[1] is! num) {
        return const <List<GeoPoint>>[];
      }
      points.add(
        GeoPoint(
          longitude: (coordinate[0] as num).toDouble(),
          latitude: (coordinate[1] as num).toDouble(),
        ),
      );
    }
    rings.add(points);
  }
  return rings;
}

bool _containsPolygon(List<List<GeoPoint>> rings, GeoPoint point) {
  if (rings.isEmpty || !_containsRing(rings.first, point)) return false;
  for (final hole in rings.skip(1)) {
    if (_containsRing(hole, point)) return false;
  }
  return true;
}

bool _containsRing(List<GeoPoint> ring, GeoPoint point) {
  if (ring.length < 3) return false;
  var containsPoint = false;
  var previous = ring.last;
  for (final current in ring) {
    if (_pointOnSegment(point, previous, current)) return true;
    final crossesLatitude =
        (current.latitude > point.latitude) !=
        (previous.latitude > point.latitude);
    if (crossesLatitude) {
      final crossingLongitude =
          (previous.longitude - current.longitude) *
              (point.latitude - current.latitude) /
              (previous.latitude - current.latitude) +
          current.longitude;
      if (point.longitude < crossingLongitude) {
        containsPoint = !containsPoint;
      }
    }
    previous = current;
  }
  return containsPoint;
}

bool _pointOnSegment(GeoPoint point, GeoPoint start, GeoPoint end) {
  const epsilon = 1e-9;
  final cross =
      (point.longitude - start.longitude) * (end.latitude - start.latitude) -
      (point.latitude - start.latitude) * (end.longitude - start.longitude);
  if (cross.abs() > epsilon) return false;
  return point.longitude >=
          (start.longitude < end.longitude ? start.longitude : end.longitude) -
              epsilon &&
      point.longitude <=
          (start.longitude > end.longitude ? start.longitude : end.longitude) +
              epsilon &&
      point.latitude >=
          (start.latitude < end.latitude ? start.latitude : end.latitude) -
              epsilon &&
      point.latitude <=
          (start.latitude > end.latitude ? start.latitude : end.latitude) +
              epsilon;
}
