/// Suppresses the initial live-feed snapshot from moving the startup camera.
/// Later event snapshots can still focus newly added events.
class MapEventFocusGate {
  MapEventFocusGate({required bool hasInitialSnapshot})
    : _hasInitialSnapshot = hasInitialSnapshot;

  bool _hasInitialSnapshot;

  bool shouldFocusSnapshot(Iterable<Object?> events) {
    if (events.isEmpty) return false;
    if (!_hasInitialSnapshot) {
      _hasInitialSnapshot = true;
      return false;
    }
    return true;
  }
}
