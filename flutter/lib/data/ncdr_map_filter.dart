import 'map_models.dart';
import 'ncdr_category.dart';

export 'ncdr_category.dart' show isNcdrEvent;

/// Official alerts in the App come from CWA and NCDR. Local crowd reports
/// remain a separate, explicitly unverified event stream.
bool isAppSupportedEvent(MeshEvent event) =>
    event.namespace?.startsWith('crowd.') == true ||
    event.namespace == 'official.announcement' &&
        event.source == 'GOVERNMENT' ||
    event.namespace == 'official.verified' &&
        event.source == 'GOV_ATTEST' &&
        event.eventType == 'ATTESTATION' ||
    _isCwaEvent(event) ||
    isNcdrEvent(event);

/// Shows categorized NCDR events on the map, independent of source operational
/// relevance. CWA events use their own source semantics.
bool isMapVisibleEvent(MeshEvent event) {
  if (event.namespace?.startsWith('crowd.') == true) return true;
  if (event.namespace == 'official.announcement') {
    if (event.attributes?['has_map_location'] != true ||
        event.geometry is! PointGeometry) {
      return false;
    }
    final point = (event.geometry! as PointGeometry).point;
    return point.longitude >= 116.5 &&
        point.longitude <= 122.5 &&
        point.latitude >= 20.5 &&
        point.latitude <= 26.8;
  }
  if (event.namespace == 'official.verified') {
    return false;
  }
  if (_isCwaEvent(event)) return true;
  if (!isNcdrEvent(event)) return false;
  return isNcdrCategoryVisibleInApp(event);
}

List<MeshEvent> filterMapEvents(Iterable<MeshEvent> events) =>
    List<MeshEvent>.unmodifiable(events.where(isMapVisibleEvent));

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
