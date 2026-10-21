import 'dart:convert';
import 'dart:js_interop';

import 'government_feed_scope.dart';
import 'government_feed_models.dart';
import 'map_models.dart';

@JS('loadNLSCGovernmentFeed')
external JSPromise<JSString> _loadNLSCGovernmentFeed(JSString areaScope);

@JS('getNLSCGovernmentFeedRevision')
external JSPromise<JSNumber> _getNLSCGovernmentFeedRevision();

Future<WebGovernmentFeedSnapshot> loadWebGovernmentFeed() async {
  final areaScope = await loadGovernmentFeedAreaScope();
  final raw = (await _loadNLSCGovernmentFeed(areaScope.toJS).toDart).toDart;
  final decoded = jsonDecode(raw);
  if (decoded is! Map) {
    throw const FormatException('Government feed response must be an object');
  }
  final response = Map<String, dynamic>.from(decoded);
  final events = response['events'];
  final revision = response['revision'];
  if (events is! List || revision is! int) {
    throw const FormatException('Government feed response is incomplete');
  }
  return WebGovernmentFeedSnapshot(
    revision: revision,
    stale: response['stale'] == true,
    warning:
        response['warning'] is String ? response['warning'] as String : null,
    events: events
        .whereType<Map>()
        .map((event) => MeshEvent.fromJson(Map<String, dynamic>.from(event)))
        .toList(growable: false),
  );
}

Future<int> loadWebGovernmentFeedRevision() async =>
    (await _getNLSCGovernmentFeedRevision().toDart).toDartDouble.toInt();
