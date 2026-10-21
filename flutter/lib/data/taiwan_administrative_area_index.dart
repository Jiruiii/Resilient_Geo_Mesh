import 'dart:convert';

import 'package:flutter/services.dart';

import 'map_models.dart';
import 'taiwan_administrative_area_directory.dart';

class _SpatialArea {
  const _SpatialArea({
    required this.area,
    required this.geometryType,
    required this.coordinateOffset,
    required this.ringOffsets,
    required this.polygonOffsets,
    required this.bbox,
  });

  final TaiwanAdministrativeArea area;
  final String geometryType;
  final int coordinateOffset;
  final List<int> ringOffsets;
  final List<int> polygonOffsets;
  final List<double> bbox;
}

enum _RingRelation { outside, inside, boundary }

class TaiwanAdministrativeAreaIndex {
  TaiwanAdministrativeAreaIndex._({
    required List<_SpatialArea> areas,
    required List<num> coordinates,
  }) : _areas = List<_SpatialArea>.unmodifiable(areas),
       _coordinates = coordinates;

  static const String assetPath =
      'assets/map/boundaries/taiwan-administrative-area-index.json';

  final List<_SpatialArea> _areas;
  final List<num> _coordinates;

  static Future<TaiwanAdministrativeAreaIndex> load(
    TaiwanAdministrativeAreaDirectory directory, {
    AssetBundle? bundle,
  }) async {
    final raw = await (bundle ?? rootBundle).loadString(assetPath);
    return TaiwanAdministrativeAreaIndex.fromJson(directory, jsonDecode(raw));
  }

  factory TaiwanAdministrativeAreaIndex.fromJson(
    TaiwanAdministrativeAreaDirectory directory,
    Object? value,
  ) {
    if (value is! Map) {
      throw const FormatException('Invalid administrative area spatial index');
    }
    final json = Map<String, dynamic>.from(value);
    final rawAreas = json['areas'];
    final rawCoordinates = json['coordinates'];
    if (json['schema_version'] != 'taiwan-area-index-v1' ||
        json['coverage'] != 'TW' ||
        json['target_coordinate_system'] != 'EPSG:4326' ||
        json['source_version'] != directory.sourceVersion ||
        json['coordinate_encoding'] != 'flat-pairs-v1' ||
        json['area_count'] is! num ||
        rawAreas is! List ||
        (json['area_count'] as num).toInt() != rawAreas.length ||
        rawCoordinates is! List ||
        rawCoordinates.length.isOdd) {
      throw const FormatException('Invalid administrative area spatial index');
    }

    if (rawCoordinates.any(
      (coordinate) => coordinate is! num || !coordinate.isFinite,
    )) {
      throw const FormatException('Invalid administrative area coordinates');
    }
    final coordinates = rawCoordinates.cast<num>();
    final totalCoordinatePairs = coordinates.length ~/ 2;
    final areas = <_SpatialArea>[];
    final seenAreaIds = <String>{};
    var expectedCoordinateOffset = 0;
    for (final rawArea in rawAreas) {
      if (rawArea is! Map) {
        throw const FormatException('Invalid administrative area geometry');
      }
      final areaJson = Map<String, dynamic>.from(rawArea);
      final areaId = areaJson['area_id'];
      final sourceArea = areaId is String ? directory.areaById(areaId) : null;
      final geometryType = areaJson['geometry_type'];
      final coordinateOffset = areaJson['coordinate_offset'];
      final ringOffsets = _readOffsets(areaJson['ring_offsets']);
      final polygonOffsets = _readOffsets(areaJson['polygon_offsets']);
      final bbox = _readBbox(areaJson['bbox']);
      if (sourceArea == null ||
          !sourceArea.isTown ||
          !seenAreaIds.add(sourceArea.areaId) ||
          areaJson['level'] != sourceArea.level ||
          areaJson['parent_area_id'] != sourceArea.parentAreaId ||
          areaJson['county_name'] != sourceArea.countyName ||
          areaJson['town_name'] != sourceArea.townName ||
          !const <String>{'Polygon', 'MultiPolygon'}.contains(geometryType) ||
          coordinateOffset is! num ||
          coordinateOffset.toInt() != expectedCoordinateOffset ||
          ringOffsets == null ||
          polygonOffsets == null ||
          bbox == null ||
          ringOffsets.first != 0 ||
          ringOffsets.length < 2 ||
          polygonOffsets.first != 0 ||
          polygonOffsets.length < 2 ||
          polygonOffsets.last != ringOffsets.length - 1 ||
          (geometryType == 'Polygon' && polygonOffsets.length != 2) ||
          !_strictlyIncreasing(ringOffsets) ||
          !_strictlyIncreasing(polygonOffsets) ||
          ringOffsets.last < 4 ||
          expectedCoordinateOffset + ringOffsets.last > totalCoordinatePairs) {
        throw const FormatException('Invalid administrative area geometry');
      }
      expectedCoordinateOffset += ringOffsets.last;
      areas.add(
        _SpatialArea(
          area: sourceArea,
          geometryType: geometryType as String,
          coordinateOffset: coordinateOffset.toInt(),
          ringOffsets: ringOffsets,
          polygonOffsets: polygonOffsets,
          bbox: bbox,
        ),
      );
    }
    if (expectedCoordinateOffset != totalCoordinatePairs ||
        seenAreaIds.length != directory.towns.length ||
        directory.towns.any((town) => !seenAreaIds.contains(town.areaId))) {
      throw const FormatException(
        'Incomplete administrative area spatial index',
      );
    }
    return TaiwanAdministrativeAreaIndex._(
      areas: areas,
      coordinates: coordinates,
    );
  }

  List<TaiwanAdministrativeArea> resolvePoint(GeoPoint point) {
    if (!point.longitude.isFinite ||
        !point.latitude.isFinite ||
        point.longitude < -180 ||
        point.longitude > 180 ||
        point.latitude < -90 ||
        point.latitude > 90) {
      return const <TaiwanAdministrativeArea>[];
    }
    final matches = <TaiwanAdministrativeArea>[];
    for (final area in _areas) {
      if (!_withinBounds(area.bbox, point)) continue;
      if (_containsGeometry(area, point)) matches.add(area.area);
    }
    return List<TaiwanAdministrativeArea>.unmodifiable(matches);
  }

  bool _containsGeometry(_SpatialArea area, GeoPoint point) {
    for (
      var polygonIndex = 0;
      polygonIndex < area.polygonOffsets.length - 1;
      polygonIndex += 1
    ) {
      if (_containsPolygon(area, polygonIndex, point)) return true;
    }
    return false;
  }

  bool _containsPolygon(_SpatialArea area, int polygonIndex, GeoPoint point) {
    final firstRing = area.polygonOffsets[polygonIndex];
    final ringEnd = area.polygonOffsets[polygonIndex + 1];
    final outer = _relationToRing(area, firstRing, point);
    if (outer == _RingRelation.outside) return false;
    if (outer == _RingRelation.boundary) return true;
    for (var ringIndex = firstRing + 1; ringIndex < ringEnd; ringIndex += 1) {
      final hole = _relationToRing(area, ringIndex, point);
      if (hole == _RingRelation.boundary) return true;
      if (hole == _RingRelation.inside) return false;
    }
    return true;
  }

  _RingRelation _relationToRing(
    _SpatialArea area,
    int ringIndex,
    GeoPoint point,
  ) {
    final start = area.coordinateOffset + area.ringOffsets[ringIndex];
    final end = area.coordinateOffset + area.ringOffsets[ringIndex + 1];
    if (end - start < 4) return _RingRelation.outside;
    var containsPoint = false;
    var previousIndex = end - 1;
    for (var currentIndex = start; currentIndex < end; currentIndex += 1) {
      final previousLongitude = _longitude(previousIndex);
      final previousLatitude = _latitude(previousIndex);
      final currentLongitude = _longitude(currentIndex);
      final currentLatitude = _latitude(currentIndex);
      if (_pointOnSegment(
        point.longitude,
        point.latitude,
        previousLongitude,
        previousLatitude,
        currentLongitude,
        currentLatitude,
      )) {
        return _RingRelation.boundary;
      }
      final crossesLatitude =
          (currentLatitude > point.latitude) !=
          (previousLatitude > point.latitude);
      if (crossesLatitude) {
        final crossingLongitude =
            (previousLongitude - currentLongitude) *
                (point.latitude - currentLatitude) /
                (previousLatitude - currentLatitude) +
            currentLongitude;
        if (point.longitude < crossingLongitude) {
          containsPoint = !containsPoint;
        }
      }
      previousIndex = currentIndex;
    }
    return containsPoint ? _RingRelation.inside : _RingRelation.outside;
  }

  double _longitude(int coordinatePairIndex) =>
      _coordinates[coordinatePairIndex * 2].toDouble();

  double _latitude(int coordinatePairIndex) =>
      _coordinates[coordinatePairIndex * 2 + 1].toDouble();

  static List<int>? _readOffsets(Object? value) {
    if (value is! List || value.length < 2) return null;
    final offsets = <int>[];
    for (final item in value) {
      if (item is! num || item.toInt() != item) return null;
      offsets.add(item.toInt());
    }
    return offsets;
  }

  static List<double>? _readBbox(Object? value) {
    if (value is! List || value.length != 4) return null;
    final bounds = <double>[];
    for (final item in value) {
      if (item is! num || !item.toDouble().isFinite) return null;
      bounds.add(item.toDouble());
    }
    if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) return null;
    return bounds;
  }

  static bool _strictlyIncreasing(List<int> values) {
    for (var index = 1; index < values.length; index += 1) {
      if (values[index] <= values[index - 1]) return false;
    }
    return true;
  }

  static bool _withinBounds(List<double> bbox, GeoPoint point) =>
      point.longitude >= bbox[0] &&
      point.latitude >= bbox[1] &&
      point.longitude <= bbox[2] &&
      point.latitude <= bbox[3];

  static bool _pointOnSegment(
    double longitude,
    double latitude,
    double startLongitude,
    double startLatitude,
    double endLongitude,
    double endLatitude,
  ) {
    const epsilon = 1e-9;
    final cross =
        (longitude - startLongitude) * (endLatitude - startLatitude) -
        (latitude - startLatitude) * (endLongitude - startLongitude);
    if (cross.abs() > epsilon) return false;
    return longitude >=
            (startLongitude < endLongitude ? startLongitude : endLongitude) -
                epsilon &&
        longitude <=
            (startLongitude > endLongitude ? startLongitude : endLongitude) +
                epsilon &&
        latitude >=
            (startLatitude < endLatitude ? startLatitude : endLatitude) -
                epsilon &&
        latitude <=
            (startLatitude > endLatitude ? startLatitude : endLatitude) +
                epsilon;
  }
}
