import 'dart:convert';

import 'map_models.dart';

enum CrowdReportCategory {
  roadBlockage,
  flood,
  fireSmoke,
  trappedInjured,
  other,
}

extension CrowdReportCategoryWire on CrowdReportCategory {
  String get wireValue => switch (this) {
    CrowdReportCategory.roadBlockage => 'ROAD_BLOCKAGE',
    CrowdReportCategory.flood => 'FLOOD',
    CrowdReportCategory.fireSmoke => 'FIRE_SMOKE',
    CrowdReportCategory.trappedInjured => 'TRAPPED_INJURED',
    CrowdReportCategory.other => 'OTHER',
  };

  String get label => switch (this) {
    CrowdReportCategory.roadBlockage => '道路阻斷',
    CrowdReportCategory.flood => '淹水',
    CrowdReportCategory.fireSmoke => '火災／煙霧',
    CrowdReportCategory.trappedInjured => '受困／受傷',
    CrowdReportCategory.other => '其他',
  };
}

/// Label for a category as it arrives on a stored event; unknown values are
/// shown as-is rather than guessed.
String crowdCategoryLabel(Object? wireValue) {
  for (final category in CrowdReportCategory.values) {
    if (category.wireValue == wireValue) return category.label;
  }
  return wireValue is String && wireValue.isNotEmpty ? wireValue : '未分類';
}

enum CrowdReportLocationSource { currentLocation, mapPick }

extension CrowdReportLocationSourceWire on CrowdReportLocationSource {
  String get wireValue => switch (this) {
    CrowdReportLocationSource.currentLocation => 'CURRENT_LOCATION',
    CrowdReportLocationSource.mapPick => 'MAP_PICK',
  };
}

enum CrowdReportLocationHintKind { county, district, village, road, facility }

extension CrowdReportLocationHintKindWire on CrowdReportLocationHintKind {
  String get wireValue => switch (this) {
    CrowdReportLocationHintKind.county => 'COUNTY',
    CrowdReportLocationHintKind.district => 'DISTRICT',
    CrowdReportLocationHintKind.village => 'VILLAGE',
    CrowdReportLocationHintKind.road => 'ROAD',
    CrowdReportLocationHintKind.facility => 'FACILITY',
  };
}

enum CrowdReportLocationPrecision { area, road, point }

extension CrowdReportLocationPrecisionWire on CrowdReportLocationPrecision {
  String get wireValue => switch (this) {
    CrowdReportLocationPrecision.area => 'AREA',
    CrowdReportLocationPrecision.road => 'ROAD',
    CrowdReportLocationPrecision.point => 'POINT',
  };
}

final class CrowdReportLocationHint {
  const CrowdReportLocationHint({
    required this.query,
    required this.label,
    required this.kind,
    required this.precision,
  });

  final String query;
  final String label;
  final CrowdReportLocationHintKind kind;
  final CrowdReportLocationPrecision precision;

  Map<String, Object?> toChannelArguments() => <String, Object?>{
    'method': 'ADDRESS',
    'query': query.trim(),
    'label': label.trim(),
    'kind': kind.wireValue,
    'precision': precision.wireValue,
  };
}

final class CrowdReportDraft {
  const CrowdReportDraft({
    required this.category,
    required this.location,
    required this.locationSource,
    this.locationHint,
    required this.description,
  });

  final CrowdReportCategory category;
  final GeoPoint? location;
  final CrowdReportLocationSource? locationSource;
  final CrowdReportLocationHint? locationHint;
  final String description;

  CrowdReportDraft copyWith({
    CrowdReportCategory? category,
    Object? location = _unchangedLocation,
    Object? locationSource = _unchangedLocation,
    Object? locationHint = _unchangedLocation,
    String? description,
  }) => CrowdReportDraft(
    category: category ?? this.category,
    location:
        identical(location, _unchangedLocation)
            ? this.location
            : location as GeoPoint?,
    locationSource:
        identical(locationSource, _unchangedLocation)
            ? this.locationSource
            : locationSource as CrowdReportLocationSource?,
    locationHint:
        identical(locationHint, _unchangedLocation)
            ? this.locationHint
            : locationHint as CrowdReportLocationHint?,
    description: description ?? this.description,
  );

  static String? validateDescription(String value) {
    return value.runes.length > 160 ? '描述不可超過 160 字' : null;
  }

  String? validate() {
    final point = location;
    if (point == null) return '請選擇警示位置';
    if (locationSource == null) return '請選擇位置來源';
    if (!point.longitude.isFinite ||
        !point.latitude.isFinite ||
        point.longitude < -180 ||
        point.longitude > 180 ||
        point.latitude < -90 ||
        point.latitude > 90) {
      return '警示位置座標無效';
    }
    return validateDescription(description);
  }

  Map<String, Object?> toChannelArguments() {
    final error = validate();
    if (error != null) throw FormatException(error);
    final point = location!;
    return <String, Object?>{
      'category': category.wireValue,
      'location': <String, Object?>{
        'lon': point.longitude,
        'lat': point.latitude,
        'source': locationSource!.wireValue,
      },
      if (locationHint != null)
        'location_hint': locationHint!.toChannelArguments(),
      'description': description.trim(),
    };
  }
}

const Object _unchangedLocation = Object();

final class CrowdReportSubmission {
  const CrowdReportSubmission({
    required this.eventId,
    required this.applyState,
    required this.deliveryState,
    this.event,
  });

  final String eventId;
  final String applyState;
  final String deliveryState;
  final Map<String, dynamic>? event;

  factory CrowdReportSubmission.fromMessage(Map<String, dynamic> message) {
    final eventId = message['event_id'];
    final applyState = message['apply_state'];
    final deliveryState = message['delivery_state'];
    final rawEvent = message['event_json'];
    final event =
        rawEvent is String
            ? _decodeEvent(rawEvent)
            : rawEvent is Map
            ? Map<String, dynamic>.from(rawEvent)
            : null;
    if (eventId is! String ||
        eventId.isEmpty ||
        !eventId.startsWith('report:') ||
        applyState != 'UNVERIFIED' ||
        !<String>{'PENDING', 'UPLOADED'}.contains(deliveryState)) {
      throw const FormatException(
        'submitCrowdReport response is not UNVERIFIED with a delivery state',
      );
    }
    return CrowdReportSubmission(
      eventId: eventId,
      applyState: applyState as String,
      deliveryState: deliveryState as String,
      event: event,
    );
  }

  static Map<String, dynamic>? _decodeEvent(String raw) {
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } on Object {
      return null;
    }
  }
}
