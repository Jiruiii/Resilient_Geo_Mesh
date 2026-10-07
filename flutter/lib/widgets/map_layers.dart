import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../data/crowd_report_models.dart';
import '../data/map_administrative.dart';
import '../data/map_models.dart';
import '../data/map_zoom.dart';
import '../data/maplibre_map_config.dart';
import '../data/ncdr_map_filter.dart';

typedef StaticFeatureSelection = void Function(List<StaticFeature> features);
typedef MeshEventSelection = void Function(MeshEvent event);
typedef MapClusterSelection =
    void Function(GeoPoint point, {double? targetZoom});

const Color shelterMarkerColor = Color(0xFF0F766E);
const Color medicalMarkerColor = Color(0xFF4F46E5);

enum MapMarkerKind { facility, event, currentLocation, cluster }

/// App-owned icons stay in one catalog so map markers and notification cards
/// cannot drift back to platform-specific Material glyphs.
class MapIconCatalog {
  const MapIconCatalog._();

  static const IconData disaster = LucideIcons.triangleAlert;
  static const IconData expiredEvent = LucideIcons.clock3;
  static const IconData shelter = LucideIcons.house;
  static const IconData shelterRecommendation = LucideIcons.mapPinHouse;
  static const IconData medical = LucideIcons.hospital;
}

class MapMarkerData {
  const MapMarkerData({
    required this.key,
    required this.point,
    required this.width,
    required this.height,
    required this.child,
    required this.onTap,
    required this.kind,
    this.administrativeAreaName,
    this.itemCount = 1,
    this.shelterCount = 0,
    this.medicalCount = 0,
    this.eventCount = 0,
    this.hasCriticalEvent = false,
  });

  final Key key;
  final GeoPoint point;
  final double width;
  final double height;
  final Widget child;
  final VoidCallback onTap;
  final MapMarkerKind kind;
  final String? administrativeAreaName;
  final int itemCount;
  final int shelterCount;
  final int medicalCount;
  final int eventCount;
  final bool hasCriticalEvent;
}

class MapMarkerCluster {
  const MapMarkerCluster({required this.members, required this.point});

  final List<MapMarkerData> members;
  final GeoPoint point;

  int get itemCount =>
      members.fold(0, (total, marker) => total + marker.itemCount);

  int get shelterCount =>
      members.fold(0, (total, marker) => total + marker.shelterCount);

  int get medicalCount =>
      members.fold(0, (total, marker) => total + marker.medicalCount);

  int get eventCount =>
      members.fold(0, (total, marker) => total + marker.eventCount);

  bool get hasCriticalEvent => members.any((marker) => marker.hasCriticalEvent);
}

/// Converts provider-neutral map models to Flutter overlay markers.
///
/// MapLibre owns basemap and line/polygon rendering. These widgets stay above
/// the platform view to preserve marker hit-testing and accessibility
/// semantics while the map itself remains pannable.
class MapLayers {
  const MapLayers._();
  static MapMarkerData currentLocationMarker(GeoPoint point) =>
      _locationMarker(point);

  static final _administrativeNames =
      Expando<Map<MapAdministrativeIndex, String?>>();
  static final _areaNamesPattern = Expando<RegExp>();
  static final _areaBuckets =
      Expando<Map<GeoPoint, Map<String, MapAdministrativeArea?>>>();

  static const double _compactMarkerZoom = 12;
  static const double _compactMarkerSize = 18;
  static const double _fullMarkerSize = 28;
  static final double _defaultRevealAllZoom = ZoomPercentage.toZoom(
    percentage: MapLibreMapConfig.revealAllPercentage,
    minZoom: MapLibreMapConfig.minZoom,
    maxZoom: MapLibreMapConfig.maxZoom,
    overviewZoom: MapLibreMapConfig.overviewZoom,
  );
  static const double _countyClusterMaxZoom = 8.5;
  static const double _subdivisionClusterMaxZoom = 11.5;
  static const double _countyDrillZoom = 10.2;
  static const double _subdivisionDrillZoom = 11.6;
  static const int _countyClusterMaxPercentage = 25;
  static const int _countyCountPercentage = 0;
  static const int _subdivisionCountPercentage = 0;
  static const int _genericCountPercentage = 0;

  static List<MapMarkerData> buildMarkers({
    required List<StaticFeature> features,
    required List<MeshEvent> events,
    required bool showShelters,
    required bool showMedical,
    required bool showEvents,
    required StaticFeatureSelection onStaticFeatureSelected,
    required MeshEventSelection onEventSelected,
    MapClusterSelection? onClusterSelected,
    MapAdministrativeIndex? administrativeIndex,
    double? revealAllAtZoom,
    GeoPoint? currentLocation,
    double? zoom,
    int? zoomPercentage,
    DateTime? now,
  }) {
    final compactMarkers =
        zoomPercentage != null
            ? zoomPercentage < MapLibreMapConfig.fullMarkerPercentage
            : zoom != null && zoom < _compactMarkerZoom;
    final visibleFacilities = features
        .where(
          (feature) =>
              (showShelters && feature.kind == 'shelter') ||
              (showMedical && feature.kind == 'medical'),
        )
        .toList(growable: false);
    final eventNow = (now ?? DateTime.now()).toUtc();
    final visibleEvents =
        showEvents
            ? events
                .where((event) => event.isShownAt(eventNow))
                .where(isMapVisibleEvent)
                .where((event) => meshEventFocusPoint(event) != null)
                .toList(growable: false)
            : const <MeshEvent>[];
    final revealAllZoom = revealAllAtZoom ?? _defaultRevealAllZoom;
    final displayPercentage = (zoomPercentage ?? 100).clamp(0, 100).toInt();
    if (zoom != null &&
        onClusterSelected != null &&
        administrativeIndex != null &&
        zoom < revealAllZoom &&
        (zoomPercentage == null ||
            displayPercentage < MapLibreMapConfig.revealAllPercentage)) {
      final level = _administrativeLevelForZoom(
        zoom,
        zoomPercentage: zoomPercentage,
      );
      if (level != MapAdministrativeLevel.village &&
          administrativeIndex.counties.isNotEmpty &&
          administrativeIndex.subdivisions.isNotEmpty) {
        return _administrativeSummaryMarkers(
          visibleFacilities,
          visibleEvents,
          index: administrativeIndex,
          level: level,
          zoom: zoom,
          zoomPercentage: displayPercentage,
          revealAllAtZoom: revealAllZoom,
          onClusterSelected: onClusterSelected,
          currentLocation: currentLocation,
        );
      }
    }
    final rawMarkers = <MapMarkerData>[
      ..._facilityMarkers(
        visibleFacilities,
        onStaticFeatureSelected,
        compactMarkers: compactMarkers,
        administrativeIndex: administrativeIndex,
      ),
      ...visibleEvents.map(
        (event) =>
            _eventMarker(event, onEventSelected, compact: compactMarkers),
      ),
      if (currentLocation != null) _locationMarker(currentLocation),
    ];
    if (zoom == null || onClusterSelected == null) return rawMarkers;
    if (zoom >= revealAllZoom) return rawMarkers;
    if (zoomPercentage != null &&
        displayPercentage >= MapLibreMapConfig.revealAllPercentage) {
      return rawMarkers;
    }
    if (administrativeIndex != null) {
      return _administrativeMarkers(
        rawMarkers,
        zoom: zoom,
        zoomPercentage: displayPercentage,
        index: administrativeIndex,
        revealAllAtZoom: revealAllZoom,
        onClusterSelected: onClusterSelected,
        usePercentageLevel: zoomPercentage != null,
      );
    }
    return _clusterMarkers(
      rawMarkers,
      zoom: zoom,
      zoomPercentage: displayPercentage,
      countThreshold: _genericCountPercentage,
      onClusterSelected: onClusterSelected,
    );
  }

  static List<MapMarkerData> _administrativeMarkers(
    List<MapMarkerData> markers, {
    required double zoom,
    required int zoomPercentage,
    required MapAdministrativeIndex index,
    required double revealAllAtZoom,
    required MapClusterSelection onClusterSelected,
    required bool usePercentageLevel,
  }) {
    final level = _administrativeLevelForZoom(
      zoom,
      zoomPercentage: usePercentageLevel ? zoomPercentage : null,
    );
    if (level == MapAdministrativeLevel.village) return markers;
    final countThreshold = switch (level) {
      MapAdministrativeLevel.county => _countyCountPercentage,
      MapAdministrativeLevel.subdivision => _subdivisionCountPercentage,
      MapAdministrativeLevel.village => 100,
    };

    final groups = <String, _AdministrativeMarkerGroup>{};
    final unassigned = <MapMarkerData>[];
    final standalone = <MapMarkerData>[];

    for (final marker in markers) {
      if (marker.kind != MapMarkerKind.facility &&
          marker.kind != MapMarkerKind.event) {
        standalone.add(marker);
        continue;
      }
      final area = _areaForPoint(
        marker.point,
        index: index,
        level: level,
        hint: marker.administrativeAreaName,
      );
      if (area == null) {
        unassigned.add(marker);
        continue;
      }
      final group = groups.putIfAbsent(
        area.key,
        () => _AdministrativeMarkerGroup(area),
      );
      group.members.add(marker);
    }

    final output = <MapMarkerData>[...standalone];
    for (final group in groups.values) {
      final cluster = MapMarkerCluster(
        members: List<MapMarkerData>.unmodifiable(group.members),
        // County-level bubbles belong to their administrative label. This
        // keeps a low-zoom marker in each county instead of placing many
        // counties on the weighted centre of their facilities.
        point:
            level == MapAdministrativeLevel.county
                ? group.area.point
                : _clusterPoint(group.members),
      );
      output.add(
        _clusterMarker(
          cluster,
          onClusterSelected: onClusterSelected,
          zoomPercentage: zoomPercentage,
          targetZoom: _nextAdministrativeZoom(
            level,
            revealAllAtZoom: revealAllAtZoom,
          ),
          areaName: group.area.displayName,
          countThreshold: countThreshold,
          forceBubble: true,
        ),
      );
    }
    if (unassigned.isNotEmpty) {
      output.addAll(
        _clusterMarkers(
          unassigned,
          zoom: zoom,
          zoomPercentage: zoomPercentage,
          countThreshold: countThreshold,
          onClusterSelected: onClusterSelected,
        ),
      );
    }
    return _mergeAdministrativeBubbles(
      output,
      level: level,
      zoom: zoom,
      zoomPercentage: zoomPercentage,
      revealAllAtZoom: revealAllAtZoom,
      countThreshold: countThreshold,
      onClusterSelected: onClusterSelected,
    );
  }

  /// Overview bubbles need counts and one representative position per unique
  /// facility coordinate. Building a widget for every facility first makes a
  /// nationwide zoom transition wait for tens of thousands of unused widgets.
  static List<MapMarkerData> _administrativeSummaryMarkers(
    List<StaticFeature> facilities,
    List<MeshEvent> events, {
    required MapAdministrativeIndex index,
    required MapAdministrativeLevel level,
    required double zoom,
    required int zoomPercentage,
    required double revealAllAtZoom,
    required MapClusterSelection onClusterSelected,
    GeoPoint? currentLocation,
  }) {
    final points = <GeoPoint, _FacilityPointSummary>{};
    for (final facility in facilities) {
      final geometry = facility.geometry;
      if (geometry is! PointGeometry) continue;
      final summary = points.putIfAbsent(
        geometry.point,
        () => _FacilityPointSummary(),
      );
      summary.itemCount += 1;
      if (facility.kind == 'shelter') summary.shelterCount += 1;
      if (facility.kind == 'medical') summary.medicalCount += 1;
      final hint = _administrativeNameForFeature(facility, index);
      if (hint != null) summary.hints.add(hint);
    }

    final groups = <String, _AdministrativeSummaryGroup>{};
    void addPoint(
      GeoPoint point, {
      String? hint,
      required int itemCount,
      int shelterCount = 0,
      int medicalCount = 0,
      int eventCount = 0,
      bool hasCriticalEvent = false,
    }) {
      final area = _areaForPoint(point, index: index, level: level, hint: hint);
      if (area == null) return;
      final group = groups.putIfAbsent(
        area.key,
        () => _AdministrativeSummaryGroup(area),
      );
      group.add(
        point,
        itemCount: itemCount,
        shelterCount: shelterCount,
        medicalCount: medicalCount,
        eventCount: eventCount,
        hasCriticalEvent: hasCriticalEvent,
      );
    }

    for (final entry in points.entries) {
      final point = entry.key;
      final summary = entry.value;
      addPoint(
        point,
        hint: summary.hints.length == 1 ? summary.hints.single : null,
        itemCount: summary.itemCount,
        shelterCount: summary.shelterCount,
        medicalCount: summary.medicalCount,
      );
    }
    for (final event in events) {
      final point = meshEventFocusPoint(event);
      if (point == null) continue;
      addPoint(
        point,
        itemCount: 1,
        eventCount: 1,
        hasCriticalEvent:
            event.severity == 'CRITICAL' || event.severity == 'HIGH',
      );
    }

    final countThreshold = switch (level) {
      MapAdministrativeLevel.county => _countyCountPercentage,
      MapAdministrativeLevel.subdivision => _subdivisionCountPercentage,
      MapAdministrativeLevel.village => 100,
    };
    final bubbles = <MapMarkerData>[
      if (currentLocation != null) _locationMarker(currentLocation),
      for (final group in groups.values)
        _clusterMarker(
          MapMarkerCluster(
            members: <MapMarkerData>[
              MapMarkerData(
                key: ValueKey<String>(
                  'administrative-summary-${group.area.key}',
                ),
                point: group.pointForLevel(level),
                width: 0,
                height: 0,
                child: const SizedBox.shrink(),
                onTap: () {},
                kind: MapMarkerKind.facility,
                itemCount: group.itemCount,
                shelterCount: group.shelterCount,
                medicalCount: group.medicalCount,
                eventCount: group.eventCount,
                hasCriticalEvent: group.hasCriticalEvent,
              ),
            ],
            point: group.pointForLevel(level),
          ),
          onClusterSelected: onClusterSelected,
          zoomPercentage: zoomPercentage,
          targetZoom: _nextAdministrativeZoom(
            level,
            revealAllAtZoom: revealAllAtZoom,
          ),
          areaName: group.area.displayName,
          countThreshold: countThreshold,
          forceBubble: true,
        ),
    ];
    return _mergeAdministrativeBubbles(
      bubbles,
      level: level,
      zoom: zoom,
      zoomPercentage: zoomPercentage,
      revealAllAtZoom: revealAllAtZoom,
      countThreshold: countThreshold,
      onClusterSelected: onClusterSelected,
    );
  }

  static MapAdministrativeArea? _areaForPoint(
    GeoPoint point, {
    required MapAdministrativeIndex index,
    required MapAdministrativeLevel level,
    String? hint,
  }) {
    final buckets = _areaBuckets[index] ??= {};
    final pointBuckets = buckets.putIfAbsent(point, () => {});
    final bucketKey = '${level.name}:${hint ?? ''}';
    if (!pointBuckets.containsKey(bucketKey)) {
      final hinted =
          hint == null
              ? null
              : index.findByName(
                level,
                hint,
                parent:
                    level == MapAdministrativeLevel.subdivision
                        ? index
                            .nearest(point, MapAdministrativeLevel.county)
                            ?.name
                        : null,
              );
      pointBuckets[bucketKey] = hinted ?? index.areaFor(point, level);
    }
    return pointBuckets[bucketKey];
  }

  static List<MapMarkerData> _mergeAdministrativeBubbles(
    List<MapMarkerData> markers, {
    required MapAdministrativeLevel level,
    required double zoom,
    required int zoomPercentage,
    required double revealAllAtZoom,
    required int countThreshold,
    required MapClusterSelection onClusterSelected,
  }) {
    final bubbles = markers
        .where((marker) => marker.kind == MapMarkerKind.cluster)
        .toList(growable: false);
    final mergedBubbles = clusterMapMarkers(
      bubbles,
      zoom: zoom,
      mergeOverlappingBubbles: level == MapAdministrativeLevel.county,
    ).map((cluster) {
      if (cluster.members.length == 1) return cluster.members.single;
      return _clusterMarker(
        cluster,
        onClusterSelected: onClusterSelected,
        zoomPercentage: zoomPercentage,
        targetZoom: _nextAdministrativeZoom(
          level,
          revealAllAtZoom: revealAllAtZoom,
        ),
        countThreshold: countThreshold,
        forceBubble: true,
      );
    });
    return <MapMarkerData>[
      ...markers.where((marker) => marker.kind != MapMarkerKind.cluster),
      ...mergedBubbles,
    ];
  }

  static MapAdministrativeLevel _administrativeLevelForZoom(
    double zoom, {
    int? zoomPercentage,
  }) {
    if (zoomPercentage != null) {
      if (zoomPercentage <= _countyClusterMaxPercentage) {
        return MapAdministrativeLevel.county;
      }
      if (zoomPercentage < MapLibreMapConfig.revealAllPercentage) {
        return MapAdministrativeLevel.subdivision;
      }
      return MapAdministrativeLevel.village;
    }
    if (zoom < _countyClusterMaxZoom) {
      return MapAdministrativeLevel.county;
    }
    if (zoom < _subdivisionClusterMaxZoom) {
      return MapAdministrativeLevel.subdivision;
    }
    return MapAdministrativeLevel.village;
  }

  static double _nextAdministrativeZoom(
    MapAdministrativeLevel level, {
    required double revealAllAtZoom,
  }) => switch (level) {
    // Give adjacent districts enough screen space to avoid overlapping
    // bubbles immediately after a county-level drill-down.
    MapAdministrativeLevel.county => _countyDrillZoom,
    MapAdministrativeLevel.subdivision => _subdivisionDrillZoom,
    MapAdministrativeLevel.village => revealAllAtZoom,
  };

  static List<MapMarkerData> _facilityMarkers(
    List<StaticFeature> features,
    StaticFeatureSelection onSelected, {
    required bool compactMarkers,
    MapAdministrativeIndex? administrativeIndex,
  }) {
    final grouped = <String, List<StaticFeature>>{};
    for (final feature in features) {
      final geometry = feature.geometry;
      if (geometry is! PointGeometry) continue;
      final key = '${geometry.point.longitude}:${geometry.point.latitude}';
      grouped.putIfAbsent(key, () => <StaticFeature>[]).add(feature);
    }

    return grouped.values
        .map((group) {
          final point = (group.first.geometry! as PointGeometry).point;
          final names = group.map(featureName).join('、');
          final administrativeNames =
              group
                  .map(
                    (feature) => _administrativeNameForFeature(
                      feature,
                      administrativeIndex,
                    ),
                  )
                  .whereType<String>()
                  .toSet();
          final label = group.length == 1 ? names : '$names（地圖標記）';
          final isMedicalOnly = group.every(
            (feature) => feature.kind == 'medical',
          );
          return MapMarkerData(
            key: ValueKey<String>('static-marker-${group.first.id ?? names}'),
            point: point,
            width: compactMarkers ? _compactMarkerSize : _fullMarkerSize,
            height: compactMarkers ? _compactMarkerSize : _fullMarkerSize,
            child:
                compactMarkers
                    ? _MapMarkerDot(
                      semanticLabel: label,
                      color:
                          isMedicalOnly
                              ? medicalMarkerColor
                              : shelterMarkerColor,
                      onTap: () => onSelected(group),
                    )
                    : _MapMarkerButton(
                      semanticLabel: label,
                      icon:
                          isMedicalOnly
                              ? MapIconCatalog.medical
                              : MapIconCatalog.shelter,
                      color:
                          isMedicalOnly
                              ? medicalMarkerColor
                              : shelterMarkerColor,
                      shape:
                          isMedicalOnly
                              ? RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                                side: const BorderSide(
                                  color: Colors.white,
                                  width: 2,
                                ),
                              )
                              : const CircleBorder(
                                side: BorderSide(color: Colors.white, width: 2),
                              ),
                      onTap: () => onSelected(group),
                    ),
            onTap: () => onSelected(group),
            kind: MapMarkerKind.facility,
            administrativeAreaName:
                administrativeNames.length == 1
                    ? administrativeNames.single
                    : null,
            itemCount: group.length,
            shelterCount:
                group.where((feature) => feature.kind == 'shelter').length,
            medicalCount:
                group.where((feature) => feature.kind == 'medical').length,
          );
        })
        .toList(growable: false);
  }

  static String? _administrativeNameForFeature(
    StaticFeature feature,
    MapAdministrativeIndex? index,
  ) {
    if (index == null) return null;
    final names =
        _administrativeNames[feature] ??= <MapAdministrativeIndex, String?>{};
    if (names.containsKey(index)) return names[index];
    if (index.subdivisions.isEmpty) {
      names[index] = null;
      return null;
    }
    final pattern =
        _areaNamesPattern[index] ??= RegExp(
          (index.subdivisions.map((area) => area.name).toSet().toList()
                ..sort((a, b) => b.length.compareTo(a.length)))
              .map(RegExp.escape)
              .join('|'),
        );
    final matchedNames =
        feature.details.values
            .whereType<String>()
            .expand(
              (text) =>
                  pattern.allMatches(text).map((match) => match.group(0)!),
            )
            .toSet();
    final matches = index.subdivisions
        .where((area) => matchedNames.contains(area.name))
        .toList(growable: false);
    if (matches.isEmpty) {
      names[index] = null;
      return null;
    }
    final point = switch (feature.geometry) {
      PointGeometry(:final point) => point,
      _ => null,
    };
    matches.sort((left, right) {
      final lengthComparison = right.name.length.compareTo(left.name.length);
      if (lengthComparison != 0 || point == null) return lengthComparison;
      return _distanceSquared(
        point,
        left.point,
      ).compareTo(_distanceSquared(point, right.point));
    });
    return names[index] = matches.first.name;
  }

  static double _distanceSquared(GeoPoint left, GeoPoint right) {
    final latitudeRadians =
        ((left.latitude + right.latitude) / 2) * math.pi / 180;
    final longitudeDelta =
        (left.longitude - right.longitude) * math.cos(latitudeRadians);
    final latitudeDelta = left.latitude - right.latitude;
    return longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta;
  }

  static MapMarkerData _eventMarker(
    MeshEvent event,
    MeshEventSelection onSelected, {
    required bool compact,
  }) {
    final point = meshEventFocusPoint(event)!;
    final name = eventName(event);
    return MapMarkerData(
      key: ValueKey<String>('event-marker-${meshEventIdentity(event)}'),
      point: point,
      width: compact ? _compactMarkerSize : _fullMarkerSize,
      height: compact ? _compactMarkerSize : _fullMarkerSize,
      child:
          compact
              ? _MapMarkerDot(
                semanticLabel: '事件：$name${event.isExpired ? '，已過期' : ''}',
                color: eventColor(event),
                onTap: () => onSelected(event),
              )
              : _MapMarkerButton(
                semanticLabel: '事件：$name${event.isExpired ? '，已過期' : ''}',
                icon:
                    event.isExpired
                        ? MapIconCatalog.expiredEvent
                        : MapIconCatalog.disaster,
                color: eventColor(event),
                shape:
                    event.isExpired
                        ? const CircleBorder(
                          side: BorderSide(color: Colors.white, width: 2),
                        )
                        : BeveledRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                          side: const BorderSide(color: Colors.white, width: 2),
                        ),
                onTap: () => onSelected(event),
              ),
      onTap: () => onSelected(event),
      kind: MapMarkerKind.event,
      eventCount: 1,
      hasCriticalEvent:
          event.severity == 'CRITICAL' || event.severity == 'HIGH',
    );
  }

  static MapMarkerData _locationMarker(GeoPoint location) => MapMarkerData(
    key: const ValueKey<String>('current-location-marker'),
    point: location,
    width: 22,
    height: 22,
    child: const DecoratedBox(
      decoration: BoxDecoration(
        color: Color(0xFF1A73E8),
        shape: BoxShape.circle,
        border: Border.fromBorderSide(
          BorderSide(color: Colors.white, width: 3),
        ),
        boxShadow: <BoxShadow>[BoxShadow(color: Colors.black26, blurRadius: 4)],
      ),
    ),
    onTap: () {},
    kind: MapMarkerKind.currentLocation,
  );
}

class _AdministrativeMarkerGroup {
  _AdministrativeMarkerGroup(this.area);

  final MapAdministrativeArea area;
  final List<MapMarkerData> members = <MapMarkerData>[];
}

class _FacilityPointSummary {
  int itemCount = 0;
  int shelterCount = 0;
  int medicalCount = 0;
  final Set<String> hints = <String>{};
}

class _AdministrativeSummaryGroup {
  _AdministrativeSummaryGroup(this.area);

  final MapAdministrativeArea area;
  int itemCount = 0;
  int shelterCount = 0;
  int medicalCount = 0;
  int eventCount = 0;
  bool hasCriticalEvent = false;
  int pointCount = 0;
  double longitudeSum = 0;
  double latitudeSum = 0;

  void add(
    GeoPoint point, {
    required int itemCount,
    required int shelterCount,
    required int medicalCount,
    required int eventCount,
    required bool hasCriticalEvent,
  }) {
    this.itemCount += itemCount;
    this.shelterCount += shelterCount;
    this.medicalCount += medicalCount;
    this.eventCount += eventCount;
    this.hasCriticalEvent |= hasCriticalEvent;
    pointCount += 1;
    longitudeSum += point.longitude;
    latitudeSum += point.latitude;
  }

  GeoPoint pointForLevel(MapAdministrativeLevel level) =>
      level == MapAdministrativeLevel.county
          ? area.point
          : GeoPoint(
            longitude: longitudeSum / pointCount,
            latitude: latitudeSum / pointCount,
          );
}

List<MapMarkerData> _clusterMarkers(
  List<MapMarkerData> markers, {
  required double zoom,
  required int zoomPercentage,
  required int countThreshold,
  required MapClusterSelection onClusterSelected,
}) {
  final clusters = clusterMapMarkers(markers, zoom: zoom);
  return clusters
      .map((cluster) {
        if (cluster.members.length == 1 && cluster.itemCount == 1) {
          return cluster.members.single;
        }
        return _clusterMarker(
          cluster,
          onClusterSelected: onClusterSelected,
          zoomPercentage: zoomPercentage,
          countThreshold: countThreshold,
        );
      })
      .toList(growable: false);
}

MapMarkerData _clusterMarker(
  MapMarkerCluster cluster, {
  required MapClusterSelection onClusterSelected,
  required int zoomPercentage,
  required int countThreshold,
  double? targetZoom,
  String? areaName,
  bool forceBubble = false,
}) {
  if (!forceBubble && cluster.members.length == 1 && cluster.itemCount == 1) {
    return cluster.members.single;
  }
  final key = cluster.members.map((marker) => marker.key).join('|');
  final label = _clusterLabel(cluster, areaName: areaName);
  final showCount = zoomPercentage >= countThreshold;
  final diameter = _clusterDiameter(
    itemCount: cluster.itemCount,
    zoomPercentage: zoomPercentage,
    showCount: showCount,
  );
  final child = _MapClusterBubble(
    itemCount: cluster.itemCount,
    shelterCount: cluster.shelterCount,
    medicalCount: cluster.medicalCount,
    eventCount: cluster.eventCount,
    hasCriticalEvent: cluster.hasCriticalEvent,
    semanticLabel: label,
    onTap: () => onClusterSelected(cluster.point, targetZoom: targetZoom),
    diameter: diameter,
    showCount: showCount,
  );
  return MapMarkerData(
    key: ValueKey<String>('map-cluster-$key'),
    point: cluster.point,
    width: diameter,
    height: diameter,
    child: child,
    onTap: () => onClusterSelected(cluster.point, targetZoom: targetZoom),
    kind: MapMarkerKind.cluster,
    itemCount: cluster.itemCount,
    shelterCount: cluster.shelterCount,
    medicalCount: cluster.medicalCount,
    eventCount: cluster.eventCount,
    hasCriticalEvent: cluster.hasCriticalEvent,
  );
}

double _clusterDiameter({
  required int itemCount,
  required int zoomPercentage,
  required bool showCount,
}) {
  if (!showCount) return 18;
  final digitContribution = math.max(0, itemCount.toString().length - 1) * 5.5;
  final zoomShrink = (zoomPercentage / 100).clamp(0, 1) * 3;
  return (25 + digitContribution - zoomShrink).clamp(24, 48).toDouble();
}

List<MapMarkerCluster> clusterMapMarkers(
  List<MapMarkerData> markers, {
  required double zoom,
  double radius = 44,
  bool mergeOverlappingBubbles = false,
}) {
  final cellSize =
      mergeOverlappingBubbles
          ? markers.fold<double>(
            1,
            (largest, marker) =>
                math.max(largest, math.max(marker.width, marker.height)),
          )
          : radius;
  final clusterable = <int>[];
  final positions = <int, Offset>{};
  final cells = <({int x, int y}), List<int>>{};
  for (var index = 0; index < markers.length; index += 1) {
    final marker = markers[index];
    if (marker.kind != MapMarkerKind.facility &&
        marker.kind != MapMarkerKind.event &&
        marker.kind != MapMarkerKind.cluster) {
      continue;
    }
    final point = _worldPixel(marker.point, zoom);
    final cell = (
      x: (point.dx / cellSize).floor(),
      y: (point.dy / cellSize).floor(),
    );
    clusterable.add(index);
    positions[index] = point;
    cells.putIfAbsent(cell, () => <int>[]).add(index);
  }

  final parent = <int, int>{for (final index in clusterable) index: index};

  int root(int index) {
    var current = index;
    while (parent[current] != current) {
      current = parent[current]!;
    }
    var compressed = index;
    while (parent[compressed] != compressed) {
      final next = parent[compressed]!;
      parent[compressed] = current;
      compressed = next;
    }
    return current;
  }

  void join(int left, int right) {
    final leftRoot = root(left);
    final rightRoot = root(right);
    if (leftRoot != rightRoot) parent[rightRoot] = leftRoot;
  }

  for (final entry in cells.entries) {
    for (var dx = -1; dx <= 1; dx += 1) {
      for (var dy = -1; dy <= 1; dy += 1) {
        final neighbour = cells[(x: entry.key.x + dx, y: entry.key.y + dy)];
        if (neighbour == null) continue;
        for (final left in entry.value) {
          for (final right in neighbour) {
            if (left >= right) continue;
            final difference = positions[left]! - positions[right]!;
            final overlaps =
                mergeOverlappingBubbles
                    ? difference.distance <=
                        (math.max(markers[left].width, markers[left].height) +
                                math.max(
                                  markers[right].width,
                                  markers[right].height,
                                )) /
                            2
                    : difference.distance <= radius;
            if (overlaps) join(left, right);
          }
        }
      }
    }
  }

  final grouped = <int, List<MapMarkerData>>{};
  for (final index in clusterable) {
    grouped
        .putIfAbsent(root(index), () => <MapMarkerData>[])
        .add(markers[index]);
  }

  final output = <MapMarkerCluster>[];
  final emittedRoots = <int>{};
  for (var index = 0; index < markers.length; index += 1) {
    final marker = markers[index];
    if (marker.kind != MapMarkerKind.facility &&
        marker.kind != MapMarkerKind.event &&
        marker.kind != MapMarkerKind.cluster) {
      output.add(
        MapMarkerCluster(members: <MapMarkerData>[marker], point: marker.point),
      );
      continue;
    }
    final markerRoot = root(index);
    if (!emittedRoots.add(markerRoot)) continue;
    final members = grouped[markerRoot]!;
    output.add(
      MapMarkerCluster(members: members, point: _clusterPoint(members)),
    );
  }
  return output;
}

Offset _worldPixel(GeoPoint point, double zoom) {
  final scale = 512 * math.pow(2, zoom).toDouble();
  final x = (point.longitude + 180) / 360;
  final latitudeRadians = point.latitude * math.pi / 180;
  final y =
      (1 -
          (math.log(
                math.tan(latitudeRadians) + (1 / math.cos(latitudeRadians)),
              ) /
              math.pi)) /
      2;
  return Offset(x * scale, y * scale);
}

GeoPoint _clusterPoint(List<MapMarkerData> members) {
  var longitude = 0.0;
  var latitude = 0.0;
  for (final member in members) {
    longitude += member.point.longitude;
    latitude += member.point.latitude;
  }
  return GeoPoint(
    longitude: longitude / members.length,
    latitude: latitude / members.length,
  );
}

String _clusterLabel(MapMarkerCluster cluster, {String? areaName}) {
  final details = <String>[];
  if (cluster.shelterCount > 0) details.add('避難所${cluster.shelterCount}');
  if (cluster.medicalCount > 0) details.add('醫療${cluster.medicalCount}');
  if (cluster.eventCount > 0) details.add('事件${cluster.eventCount}');
  final prefix = areaName == null ? '資料聚合' : '資料聚合：$areaName';
  return '$prefix，${cluster.itemCount}筆${details.isEmpty ? '' : '，${details.join('、')}'}';
}

List<MapMarkerData> hitTestMapMarkers({
  required List<MapMarkerData> markers,
  required Map<Key, Offset> positions,
  required Offset point,
  Offset translation = Offset.zero,
}) => markers
    .where((marker) {
      final cachedCenter = positions[marker.key];
      if (cachedCenter == null) return false;
      final center = cachedCenter + translation;
      final halfWidth = marker.width / 2;
      final halfHeight = marker.height / 2;
      return point.dx >= center.dx - halfWidth &&
          point.dx <= center.dx + halfWidth &&
          point.dy >= center.dy - halfHeight &&
          point.dy <= center.dy + halfHeight;
    })
    .toList(growable: false);

String featureName(StaticFeature feature) {
  final name = feature.details['name'];
  return name is String && name.isNotEmpty ? name : (feature.id ?? '未命名設施');
}

String eventName(MeshEvent event) {
  final attributes = event.attributes;
  if (event.eventType == 'CROWD_REPORT') {
    return '民眾回報：${crowdCategoryLabel(attributes?['category'])}';
  }
  for (final key in <String>[
    'name',
    'title',
    'road_name',
    'source_description',
    'alert_id',
  ]) {
    final value = attributes?[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return event.eventType ?? event.eventId ?? '未命名事件';
}

/// Crowd reports get their own colours so they can never be mistaken for
/// official data: purple while unverified, teal once officially confirmed.
const unverifiedEventColor = Color(0xFF7C3AED);
const confirmedCrowdEventColor = Color(0xFF0F766E);

Color eventColor(MeshEvent event) {
  if (event.isExpired) return const Color(0xFF64748B);
  if (event.verification == CrowdVerification.confirmed) {
    return confirmedCrowdEventColor;
  }
  if (event.isUnverified) return unverifiedEventColor;
  return switch (event.severity) {
    'CRITICAL' => const Color(0xFFD92D20),
    'HIGH' => const Color(0xFFF97316),
    'MEDIUM' => const Color(0xFFD97706),
    _ => const Color(0xFF2563EB),
  };
}

class _MapMarkerButton extends StatelessWidget {
  const _MapMarkerButton({
    required this.semanticLabel,
    required this.icon,
    required this.color,
    required this.shape,
    required this.onTap,
  });

  final String semanticLabel;
  final IconData icon;
  final Color color;
  final ShapeBorder shape;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    container: true,
    label: semanticLabel,
    child: SizedBox.expand(
      child: Material(
        color: color,
        elevation: 4,
        shadowColor: color.withValues(alpha: 0.55),
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          customBorder: shape,
          onTap: onTap,
          splashColor: Colors.white.withValues(alpha: 0.24),
          highlightColor: Colors.white.withValues(alpha: 0.12),
          child: Icon(icon, color: Colors.white, size: 15),
        ),
      ),
    ),
  );
}

class _MapMarkerDot extends StatelessWidget {
  const _MapMarkerDot({
    required this.semanticLabel,
    required this.color,
    required this.onTap,
  });

  final String semanticLabel;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    container: true,
    label: semanticLabel,
    child: SizedBox.expand(
      child: Center(
        child: SizedBox(
          width: 10,
          height: 10,
          child: Material(
            color: color,
            elevation: 2,
            shadowColor: color.withValues(alpha: 0.5),
            shape: const CircleBorder(
              side: BorderSide(color: Colors.white, width: 1.5),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onTap,
              splashColor: Colors.white.withValues(alpha: 0.3),
            ),
          ),
        ),
      ),
    ),
  );
}

class _MapClusterBubble extends StatelessWidget {
  const _MapClusterBubble({
    required this.itemCount,
    required this.shelterCount,
    required this.medicalCount,
    required this.eventCount,
    required this.hasCriticalEvent,
    required this.semanticLabel,
    required this.onTap,
    required this.diameter,
    required this.showCount,
  });

  final int itemCount;
  final int shelterCount;
  final int medicalCount;
  final int eventCount;
  final bool hasCriticalEvent;
  final String semanticLabel;
  final VoidCallback onTap;
  final double diameter;
  final bool showCount;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    container: true,
    label: semanticLabel,
    child: SizedBox.expand(
      child: Material(
        color: hasCriticalEvent ? const Color(0xFFB42318) : shelterMarkerColor,
        elevation: 2,
        shadowColor: Colors.black45,
        shape: const CircleBorder(
          side: BorderSide(color: Colors.white, width: 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          splashColor: Colors.white.withValues(alpha: 0.3),
          child:
              showCount
                  ? Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      Text(
                        '$itemCount',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          height: 1,
                        ),
                      ),
                      if (shelterCount > 0 ||
                          medicalCount > 0 ||
                          eventCount > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              if (shelterCount > 0)
                                _categoryDot(shelterMarkerColor),
                              if (medicalCount > 0)
                                _categoryDot(medicalMarkerColor),
                              if (eventCount > 0)
                                _categoryDot(
                                  hasCriticalEvent
                                      ? const Color(0xFFFFD6D1)
                                      : const Color(0xFF93C5FD),
                                ),
                            ],
                          ),
                        ),
                    ],
                  )
                  : Center(
                    child: SizedBox(
                      width: math.min(7, diameter * 0.4),
                      height: math.min(7, diameter * 0.4),
                      child: const DecoratedBox(
                        decoration: BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
        ),
      ),
    ),
  );

  Widget _categoryDot(Color color) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 1),
    child: DecoratedBox(
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: const SizedBox(width: 3, height: 3),
    ),
  );
}

String eventKey(MeshEvent event) => meshEventIdentity(event);
