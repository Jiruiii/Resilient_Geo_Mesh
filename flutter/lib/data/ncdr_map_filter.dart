import 'map_models.dart';

const Set<String> _actionableNcdrRelevance = <String>{
  'EVACUATION',
  'ROUTE_CHANGE',
  'HIGH_IMPACT',
};

/// Official alerts in the App come from NCDR. Local crowd reports remain a
/// separate, explicitly unverified event stream.
bool isAppSupportedEvent(MeshEvent event) =>
    event.namespace?.startsWith('crowd.') == true || _isNcdrEvent(event);

/// Keeps NCDR background notices out of the operational map. Other official
/// feeds are not part of this App's alert source.
bool isMapVisibleEvent(MeshEvent event) {
  if (event.namespace?.startsWith('crowd.') == true) return true;
  if (!_isNcdrEvent(event)) return false;

  final mapVisible = event.attributes?['map_visible'];
  if (mapVisible is bool) return mapVisible;

  final relevance = event.attributes?['operational_relevance'];
  return relevance is String && _actionableNcdrRelevance.contains(relevance);
}

List<MeshEvent> filterMapEvents(Iterable<MeshEvent> events) =>
    List<MeshEvent>.unmodifiable(events.where(isMapVisibleEvent));

bool _isNcdrEvent(MeshEvent event) {
  final namespace = event.namespace ?? '';
  return event.source?.toUpperCase() == 'NCDR' ||
      namespace == 'official.ncdr' ||
      namespace.startsWith('official.ncdr.') ||
      namespace == 'official.live.ncdr' ||
      namespace.startsWith('official.live.ncdr.');
}
