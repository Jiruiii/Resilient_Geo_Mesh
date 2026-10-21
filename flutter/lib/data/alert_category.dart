import 'map_models.dart';
import 'ncdr_category.dart';

/// Human-readable category shown on official warning notifications.
///
/// NCDR categories use the server-normalized taxonomy. CWA uses its warning
/// kind and source description because the feed's `event_type` is a broad
/// transport type such as `WEATHER_WARNING`.
String? alertCategoryLabelFor(MeshEvent event) {
  final ncdrCategory = ncdrCategoryLabelFor(event);
  if (ncdrCategory != null) return ncdrCategory;
  if (event.source?.toUpperCase() != 'CWA') return null;

  switch (event.eventType) {
    case 'TYPHOON_WARNING':
      return '颱風';
    case 'EARTHQUAKE_INTENSITY':
      return '地震';
    case 'WEATHER_WARNING':
      return _weatherWarningCategory(event);
    default:
      return null;
  }
}

String _weatherWarningCategory(MeshEvent event) {
  final description = event.attributes?['source_description'];
  final title = event.attributes?['title'];
  final name = event.attributes?['name'];
  final warningText =
      <Object?>[
        title,
        name,
        description,
        event.attributes?['warning_type'],
      ].whereType<String>().join(' ').toLowerCase();

  final categories = <(RegExp, String)>[
    (RegExp(r'颱風|typhoon|tropical cyclone'), '颱風'),
    (RegExp(r'地震|earthquake'), '地震'),
    (RegExp(r'海嘯|tsunami'), '海嘯'),
    (RegExp(r'土石流|崩塌|landslide'), '土石流及大規模崩塌'),
    (RegExp(r'火災|火警|野火|wildfire|fire'), '火災'),
    (RegExp(r'淹水|積水|洪水|flood'), '淹水'),
    (RegExp(r'強風|暴風|strong wind|gale'), '強風'),
    (RegExp(r'高溫|熱浪|heat wave|high temperature'), '高溫'),
    (RegExp(r'低溫|寒流|low temperature'), '低溫'),
    (RegExp(r'濃霧|霧|fog'), '濃霧'),
    (RegExp(r'雷雨|雷電|thunderstorm'), '雷雨'),
    (RegExp(r'降雨|豪雨|大雨|rain|precipitation'), '降雨'),
  ];
  for (final (pattern, label) in categories) {
    if (pattern.hasMatch(warningText)) return label;
  }
  return '氣象警報';
}
