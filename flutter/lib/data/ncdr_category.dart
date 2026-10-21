import 'map_models.dart';

const Map<String, String> ncdrCategoryLabelsByCode = <String, String>{
  'typhoon': '颱風',
  'earthquake': '地震',
  'tsunami': '海嘯',
  'flood': '淹水',
  'debris_landslide': '土石流及大規模崩塌',
  'rainfall': '降雨',
  'road_closed': '道路封閉',
  'air_defense': '防空',
  'thunderstorm': '雷雨',
  'infectious_disease': '傳染病',
  'low_temperature': '低溫',
  'strong_wind': '強風',
  'fog': '濃霧',
  'fire': '火災',
  'wildfire_risk': '林火危險度預警',
  'diversion_alarm': '分洪警報',
  'evacuation': '疏散避難',
  'radiation': '輻射災害',
  'high_temperature': '高溫',
  'volcano': '火山',
  'ramp_connector_flood': '交流道下地方連絡道淹水',
  'wind_control_road': '強風管制路段',
  'railway_accident': '鐵路事故',
  'urgent_clinic': '急門診通報',
  'highway_condition': '高速公路路況事件',
  'landslide_dam_warning': '堰塞湖警戒',
  'national_park_admission': '國家公園入園示警',
  'local_government_report': '各直轄市縣市政府災情通報',
  'public_natural_gas_report': '公用天然氣事業災情通報',
  'national_forest_recreation': '國家森林遊樂區',
  'flood_sensor': '淹水感測',
  'giant_wave': '巨浪',
};

final Set<String> visibleNcdrCategoryCodes =
    ncdrCategoryLabelsByCode.keys.toSet();
final Map<String, String> _ncdrCategoryCodesByLabel = <String, String>{
  for (final entry in ncdrCategoryLabelsByCode.entries) entry.value: entry.key,
};

bool isNcdrEvent(MeshEvent event) {
  final namespace = event.namespace ?? '';
  return event.source?.toUpperCase() == 'NCDR' ||
      namespace == 'official.ncdr' ||
      namespace.startsWith('official.ncdr.') ||
      namespace == 'official.live.ncdr' ||
      namespace.startsWith('official.live.ncdr.');
}

/// Returns the normalized NCDR category sent in the signed event.
///
/// The fallback keeps older cached feeds readable until the next server
/// publication includes the ncdr_category_label field.
String? ncdrCategoryCodeFor(MeshEvent event) {
  if (!isNcdrEvent(event)) return null;

  // The selected app taxonomy excludes water-supply and marine-pollution
  // alerts plus fire-safety inspection failures. Older feeds mislabeled the
  // latter as 「火災」, so inspect preserved source fields as well.
  if (_isNonDisplayNcdrSourceEvent(event)) return 'other';

  final code = event.attributes?['ncdr_category_code'];
  if (code is String && code.trim().isNotEmpty) return code.trim();

  final label = event.attributes?['ncdr_category_label'];
  if (label is String && label.trim().isNotEmpty) {
    return _ncdrCategoryCodesByLabel[label.trim()] ?? 'other';
  }

  return switch (event.eventType) {
    'FIRE_WARNING' => 'fire',
    'HEAT_WARNING' => 'high_temperature',
    'FOREST_ALERT' => 'national_forest_recreation',
    'HEALTH_ALERT' => 'urgent_clinic',
    'FLOOD_WARNING' => 'flood',
    'DEBRIS_FLOW_WARNING' || 'LANDSLIDE_WARNING' => 'debris_landslide',
    'RAINFALL_WARNING' => 'rainfall',
    'EARTHQUAKE_WARNING' => 'earthquake',
    _ => 'other',
  };
}

String? ncdrCategoryLabelFor(MeshEvent event) {
  final code = ncdrCategoryCodeFor(event);
  if (code == null) return null;
  return ncdrCategoryLabelsByCode[code] ?? '其他 NCDR 事件';
}

/// Keeps complete NCDR events in the verified feed while hiding categories
/// the app does not present to users.
bool isNcdrCategoryVisibleInApp(MeshEvent event) =>
    !isNcdrEvent(event) ||
    visibleNcdrCategoryCodes.contains(ncdrCategoryCodeFor(event));

bool _isNonDisplayNcdrSourceEvent(MeshEvent event) {
  final sourceEventType =
      (event.attributes?['ncdr_source_event_type'] ?? '')
          .toString()
          .trim()
          .toLowerCase();
  final sourceEventCode =
      (event.attributes?['ncdr_source_event_code'] ?? '')
          .toString()
          .trim()
          .toLowerCase();
  final normalizedEventType = (event.eventType ?? '').toUpperCase();
  final sourceRecordText =
      (event.attributes?['source_record'] ?? '').toString().toLowerCase();
  final exclusionText =
      '$sourceEventType $sourceEventCode $normalizedEventType $sourceRecordText';

  final fireSafetyInspection =
      exclusionText.contains('消防安全檢查') ||
      exclusionText.contains('重大不合格場所') ||
      exclusionText.contains('dangerfield') ||
      normalizedEventType == 'SAFETY_ALERT';
  final marinePollution =
      normalizedEventType == 'MARINE_POLLUTION_ALERT' ||
      exclusionText.contains('海洋污染') ||
      exclusionText.contains('marinepollution') ||
      exclusionText.contains('marine pollution');
  final waterSupply =
      normalizedEventType == 'WATER_SUPPLY_ALERT' ||
      exclusionText.contains('停水') ||
      exclusionText.contains('供水') ||
      exclusionText.contains('water supply') ||
      exclusionText.contains('watersupply') ||
      exclusionText.contains('wateroutage');

  return fireSafetyInspection || marinePollution || waterSupply;
}
