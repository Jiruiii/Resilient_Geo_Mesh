import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/map_app_controller.dart';
import 'package:resilientgeo_flutter/data/government_feed_models.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/rescue_events.dart';
import 'support/fake_rescue_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('on the web, verified server rescue points join the event stream', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final service = FakeRescueService()..nearbyResult = <MeshEvent>[rescue(expiresAt: '2999-01-01T00:00:00Z')];
    final controller = MapAppController(
      bridge: MapBridge(methodChannel: const MethodChannel('test/no-native')),
      isWeb: true,
      webStaticLayerLoader: () async => '',
      webGovernmentFeedLoader: () async => const WebGovernmentFeedSnapshot(revision: 1, stale: false, warning: null, events: <MeshEvent>[]),
      rescueService: service,
    );
    await controller.load();
    final next = controller.eventUpdates.first;
    controller.setRescueViewport(const GeoPoint(longitude: 121.5, latitude: 25.0));
    final events = await next;
    expect(events.any((event) => event.namespace == 'crowd.rescue'), isTrue);
    expect(service.nearbyCalls.single.toList()[0], closeTo(121.476, 0.001));
    controller.dispose();
  });
}
