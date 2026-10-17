import 'government_feed_models.dart';

Future<WebGovernmentFeedSnapshot> loadWebGovernmentFeed() async =>
    const WebGovernmentFeedSnapshot(revision: 0, events: []);

Future<int> loadWebGovernmentFeedRevision() async => 0;
