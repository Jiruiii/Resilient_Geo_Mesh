import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/rescue-service');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  final draft = RescueDraft.initial().copyWith(
    type: RescueRequestType.trapped,
    location: const GeoPoint(longitude: 121.5, latitude: 25.0),
    locationSource: CrowdReportLocationSource.mapPick,
  );

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('Android errors become typed rescue failures', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'submitRescueRequest');
      expect((call.arguments as Map)['request_type'], 'TRAPPED');
      throw PlatformException(code: 'rate_limited', message: 'cooldown', details: <String, Object?>{'retry_after_seconds': 12});
    });
    final service = AndroidRescueService(MapBridge(methodChannel: channel));
    await expectLater(
      service.submit(draft),
      throwsA(isA<RescueFailure>()
          .having((failure) => failure.code, 'code', RescueFailureCode.rateLimited)
          .having((failure) => failure.retryAfterSeconds, 'retry', 12)),
    );
  });

  test('a missing Android host is reported as unsupported, not as success', () async {
    final service = AndroidRescueService(MapBridge(methodChannel: const MethodChannel('test/no-host')));
    await expectLater(
      service.submit(draft),
      throwsA(isA<RescueFailure>().having((failure) => failure.code, 'code', RescueFailureCode.unsupported)),
    );
  });

  test('bounds around a point stay inside the server limit', () {
    final bounds = RescueBounds.around(const GeoPoint(longitude: 121.5, latitude: 25.0));
    final values = bounds.toList();
    expect(values[2] - values[0], lessThanOrEqualTo(0.05));
    expect(values[3] - values[1], lessThanOrEqualTo(0.05));
  });

  test('failure messages are user facing and never echo the description', () {
    expect(const RescueFailure(code: RescueFailureCode.conflict, message: 'rescue_active_exists').userMessage(), '此裝置已有進行中的求救，請先更新或結束它');
    expect(const RescueFailure(code: RescueFailureCode.unsupported, message: 'x').userMessage(), '此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲');
  });
}
