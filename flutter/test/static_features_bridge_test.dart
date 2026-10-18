import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'getStaticFeatures parses verified features and rejects a malformed reply',
    () async {
      const channel = MethodChannel('test/map-bridge/static-features');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      Object? reply = <String, dynamic>{
        'static_features': <Object?>[
          <String, dynamic>{
            'id': 'shelter:5427',
            'kind': 'shelter',
            'name': '潭美國小',
            'geometry': <String, dynamic>{
              'type': 'Point',
              'coordinates': <double>[121.5908, 25.0609],
            },
          },
        ],
        'snapshot_at': '2026-09-03T02:00:32Z',
      };
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'getStaticFeatures');
        return reply;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final bridge = MapBridge(methodChannel: channel);

      final features = await bridge.getStaticFeatures();
      expect(features.features.single.id, 'shelter:5427');
      expect(features.features.single.kind, 'shelter');
      expect(features.snapshotAt, '2026-09-03T02:00:32Z');

      reply = <String, dynamic>{'features': <Object?>[]};
      await expectLater(bridge.getStaticFeatures(), throwsFormatException);

      reply = <String, dynamic>{
        'static_features': <Object?>[],
        'snapshot_at': 42,
      };
      await expectLater(bridge.getStaticFeatures(), throwsFormatException);
    },
  );
}
