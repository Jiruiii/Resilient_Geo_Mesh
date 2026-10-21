import 'map_models.dart';
import 'taiwan_administrative_area_directory.dart';

bool eventMatchesNotificationAreas(
  MeshEvent event,
  Set<String> selectedAreaIds,
  TaiwanAdministrativeAreaDirectory directory,
) {
  final selected = directory.normalizeSelection(selectedAreaIds);
  if (selected.contains(TaiwanAdministrativeAreaDirectory.nationalAreaId)) {
    return true;
  }

  final targetIds = _eventAreaIds(
    event.attributes ?? const <String, dynamic>{},
  );
  if (targetIds.contains(TaiwanAdministrativeAreaDirectory.nationalAreaId)) {
    return true;
  }
  if (targetIds.any((areaId) => directory.areaById(areaId) == null)) {
    return true;
  }
  final targets = targetIds
      .map(directory.areaById)
      .whereType<TaiwanAdministrativeArea>()
      .toList(growable: false);
  if (targets.isEmpty) return true;

  for (final target in targets) {
    if (target.isCounty) {
      if (selected.contains(target.areaId) ||
          selected.any(
            (areaId) =>
                directory.areaById(areaId)?.parentAreaId == target.areaId,
          )) {
        return true;
      }
      continue;
    }
    if (target.isTown &&
        (selected.contains(target.areaId) ||
            selected.contains(target.parentAreaId))) {
      return true;
    }
  }
  return false;
}

List<String> _eventAreaIds(Map<String, dynamic> attributes) {
  final affectedAreaIds = attributes['affected_area_ids'];
  if (affectedAreaIds is List) {
    final ids = affectedAreaIds.whereType<String>().toList(growable: false);
    if (ids.isNotEmpty) return ids;
  }
  final legacyAreaId = attributes['area_id'];
  return legacyAreaId is String ? <String>[legacyAreaId] : const <String>[];
}
