import 'map_models.dart';

class WebGovernmentFeedSnapshot {
  const WebGovernmentFeedSnapshot({
    required this.revision,
    required this.events,
    this.stale = false,
    this.warning,
  });

  final int revision;
  final List<MeshEvent> events;
  final bool stale;
  final String? warning;
}
