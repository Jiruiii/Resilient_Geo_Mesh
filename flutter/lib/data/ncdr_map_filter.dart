import 'map_models.dart';

const Set<String> _actionableNcdrRelevance = <String>{
  'EVACUATION',
  'ROUTE_CHANGE',
  'HIGH_IMPACT',
};

/// Official alerts in the App come from CWA and NCDR. Local crowd reports
/// remain a separate, explicitly unverified event stream.
bool isAppSupportedEvent(MeshEvent event) =>
    event.namespace?.startsWith('crowd.') == true ||
    _isCwaEvent(event) ||
    _isNcdrEvent(event);

/// Keeps NCDR background notices out of the operational map. CWA events use
/// their own source semantics and are not filtered by NCDR relevance fields.
bool isMapVisibleEvent(MeshEvent event) {
  if (event.namespace?.startsWith('crowd.') == true) return true;
  if (_isCwaEvent(event)) return true;
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

bool _isCwaEvent(MeshEvent event) {
  final namespace = event.namespace ?? '';
  final isCwaNamespace =
      namespace == 'official.cwa' ||
      namespace.startsWith('official.cwa.') ||
      namespace == 'official.live.cwa' ||
      namespace.startsWith('official.live.cwa.') ||
      const <String>{
        'official.live.cwa-earthquake',
        'official.live.cwa-warning',
        'official.live.cwa-typhoon',
      }.contains(namespace);
  final source = event.source?.toUpperCase();
  return isCwaNamespace && (source == null || source == 'CWA');
}
