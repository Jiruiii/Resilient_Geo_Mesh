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

bool _containsGeometry(MapGeometry geometry, GeoPoint point) =>
    switch (geometry) {
      PolygonGeometry(:final rings) => _containsPolygon(rings, point),
      MultiPolygonGeometry(:final polygons) => polygons.any(
        (polygon) => _containsPolygon(polygon, point),
      ),
      _ => false,
    };

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
