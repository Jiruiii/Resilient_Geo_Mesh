import 'offline_government_feed_stub.dart'
    if (dart.library.html) 'offline_government_feed_web.dart'
    as implementation;
import 'government_feed_models.dart';

export 'government_feed_models.dart';

Future<WebGovernmentFeedSnapshot> loadWebGovernmentFeed() =>
    implementation.loadWebGovernmentFeed();
