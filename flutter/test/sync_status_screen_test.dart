import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/sync_status.dart';
import 'package:resilientgeo_flutter/screens/sync_status_screen.dart';

Map<String, dynamic> message() => {
  'emergency_mode_enabled': true,
  'bluetooth_available': true,
  'bluetooth_enabled': true,
  'ble_permissions_granted': true,
  'notifications_enabled': true,
  'service_running': true,
  'discovery_active': true,
  'nearby_peers': 2,
  'active_sessions': 1,
  'sync_completions': 3,
  'chunks_received': 4,
  'observed_at': '2026-09-27T12:00:00Z',
  'last_success_at': '2026-09-27T11:00:00Z',
  'last_failure_at': '2026-09-27T10:00:00Z',
  'last_failure_code': 'hello_timeout',
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'adaptive setting and manual search call native bridge, with mode locked while running',
    (tester) async {
      const channel = MethodChannel('test/discovery-controls');
      var enabled = false, searches = 0;
      var mode = 'balanced';
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'setDiscoveryMode') {
          mode = (call.arguments as Map)['mode'] as String;
        }
        if (call.method == 'searchPeersNow') searches++;
        if (call.method == 'setEmergencyMode') {
          enabled = (call.arguments as Map)['enabled'] as bool;
          return {'enabled': enabled};
        }
        return {
          ...message(),
          'transport': 'wifi_direct',
          'discovery_mode': mode,
          'emergency_mode_enabled': enabled,
          'service_running': enabled,
          'wifi_direct_available': true,
          'wifi_enabled': true,
          'wifi_permissions_granted': true,
          'location_enabled': true,
        };
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      await tester.pumpWidget(
        MaterialApp(
          home: SyncStatusScreen(bridge: MapBridge(methodChannel: channel)),
        ),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('discovery-mode')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('自適應間歇搜尋（實驗）').last);
      await tester.pumpAndSettle();
      expect(mode, 'adaptive');
      await tester.ensureVisible(find.byType(Switch));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(
              find.byKey(const ValueKey('discovery-mode')),
            )
            .onChanged,
        isNull,
      );
      await tester.ensureVisible(find.text('立即搜尋'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('立即搜尋'));
      await tester.pump();
      expect(searches, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('measurement log switch appears only when the build offers it', (
    tester,
  ) async {
    const channel = MethodChannel('test/measurement-log');
    var available = false, logging = false;
    final calls = <bool>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'setMeasurementLog') {
        logging = (call.arguments as Map)['enabled'] as bool;
        calls.add(logging);
      }
      return {
        ...message(),
        'measurement_log_available': available,
        'measurement_log_enabled': logging,
        'measurement_log_directory':
            available ? '/sdcard/Android/data/app/files/measurements' : null,
      };
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    // Tall enough that the lazy list builds every card, so findsNothing is meaningful.
    tester.view.physicalSize = const Size(1080, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    Future<void> show() async {
      await tester.pumpWidget(
        MaterialApp(
          home: SyncStatusScreen(
            key: UniqueKey(),
            bridge: MapBridge(methodChannel: channel),
          ),
        ),
      );
      await tester.pump();
    }

    await show();
    expect(find.byKey(const ValueKey('measurement-log')), findsNothing);

    available = true;
    await show();
    final toggle = find.byKey(const ValueKey('measurement-log'));
    await tester.ensureVisible(toggle);
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pump();
    expect(calls, [true]);
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    expect(find.textContaining('files/measurements'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  test('Wi-Fi Direct readiness does not depend on Bluetooth', () {
    final wifi =
        message()..addAll({
          'transport': 'wifi_direct',
          'wifi_direct_available': true,
          'wifi_enabled': true,
          'wifi_permissions_granted': true,
          'location_enabled': true,
          'bluetooth_enabled': false,
          'ble_permissions_granted': false,
        });
    expect(SyncStatus.fromMessage(wifi).activityLabel, '正在與附近節點同步');
    expect(
      SyncStatus.fromMessage({
        ...wifi,
        'location_enabled': false,
      }).activityLabel,
      contains('定位服務'),
    );
    expect(
      SyncStatus.fromMessage({
        ...wifi,
        'wifi_permissions_granted': false,
      }).activityLabel,
      contains('Wi-Fi 附近裝置權限'),
    );
    expect(
      SyncStatus.fromMessage({...wifi, 'wifi_enabled': false}).activityLabel,
      '請開啟 Wi-Fi',
    );
  });

  testWidgets(
    'transport selection is persisted through native bridge and locked while running',
    (tester) async {
      const channel = MethodChannel('test/sync-transport');
      var mode = 'ble';
      var enabled = false;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'setSyncTransport') {
          mode = (call.arguments as Map)['transport'] as String;
        }
        if (call.method == 'setEmergencyMode') {
          enabled = (call.arguments as Map)['enabled'] as bool;
          return {'enabled': enabled};
        }
        return message()
          ..addAll({'transport': mode, 'emergency_mode_enabled': enabled});
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      await tester.pumpWidget(
        MaterialApp(
          home: SyncStatusScreen(bridge: MapBridge(methodChannel: channel)),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('進階：指定傳輸方式'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Wi-Fi Direct').last);
      await tester.pumpAndSettle();
      expect(mode, 'wifi_direct');
      await tester.ensureVisible(find.byType(Switch));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(
              find.byKey(const ValueKey('sync-transport')),
            )
            .onChanged,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
  test(
    'does not confuse enabled mode with permission or service readiness',
    () {
      expect(SyncStatus.fromMessage(message()).activityLabel, '正在與附近節點同步');
      expect(
        SyncStatus.fromMessage(
          message()..['ble_permissions_granted'] = false,
        ).activityLabel,
        '尚未取得附近裝置權限',
      );
      expect(
        SyncStatus.fromMessage(
          message()..['bluetooth_enabled'] = false,
        ).activityLabel,
        '請開啟藍牙',
      );
      expect(
        SyncStatus.fromMessage(
          message()..['service_running'] = false,
        ).activityLabel,
        contains('尚未確認服務運作'),
      );
      expect(
        () => SyncStatus.fromMessage(message()..remove('service_running')),
        throwsFormatException,
      );
      expect(
        () => SyncStatus.fromMessage(message()..['chunks_received'] = -1),
        throwsFormatException,
      );
    },
  );

  test(
    'automatic mode keeps working without GMS when native Wi-Fi is ready',
    () {
      final status = SyncStatus.fromMessage({
        ...message(),
        'transport': 'auto',
        'active_transports': ['wifi_direct'],
        'bluetooth_enabled': false,
        'ble_permissions_granted': false,
        'nearby_available': false,
        'fallback_reason': 'nearby_discovery_failed',
        'last_failure_code': 'send_failed',
        'last_failure_transport': 'nearby',
      });
      expect(status.activityLabel, '正在與附近節點同步');
      expect(status.activeTransportLabel, 'Wi-Fi Direct');
      expect(status.fallbackDescription, contains('Nearby 嘗試失敗'));
      expect(status.failureDescription, 'Nearby 訊息傳送失敗');
    },
  );

  testWidgets('web explains offline exchange without polling native APIs', (
    tester,
  ) async {
    const channel = MethodChannel('test/web-sync');
    var calls = 0;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async {
      calls++;
      return message();
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(
      MaterialApp(
        home: SyncStatusScreen(
          bridge: MapBridge(methodChannel: channel),
          isWeb: true,
        ),
      ),
    );
    await tester.pump(const Duration(seconds: 10));
    expect(find.text('請使用 Android App 交換'), findsOneWidget);
    expect(find.byType(Switch), findsNothing);
    expect(calls, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('auto shows live transports and leaves overrides collapsed', (
    tester,
  ) async {
    const channel = MethodChannel('test/auto-sync');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        ...message(),
        'transport': 'auto',
        'active_transports': ['nearby', 'ble'],
        'nearby_available': true,
      },
    );
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(
      MaterialApp(
        home: SyncStatusScreen(bridge: MapBridge(methodChannel: channel)),
      ),
    );
    await tester.pump();
    expect(find.text('Nearby + 藍牙 BLE'), findsOneWidget);
    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'polls real bridge data and clearly marks retained data on failure',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1500);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const channel = MethodChannel('test/sync-screen');
      var calls = 0;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls++;
        if (calls > 1) throw PlatformException(code: 'map_bridge_error');
        return message();
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      await tester.pumpWidget(
        MaterialApp(
          home: SyncStatusScreen(bridge: MapBridge(methodChannel: channel)),
        ),
      );
      await tester.pump();
      expect(find.text('正在與附近節點同步'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(find.text('無法取得同步狀態，請重新整理'), findsOneWidget);
      expect(find.textContaining('以下為上次取得的狀態'), findsOneWidget);
      expect(find.text('狀態待重新確認'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
      expect(calls, 2);
    },
  );

  testWidgets(
    'emergency toggle sends a native command rather than a local flag',
    (tester) async {
      const channel = MethodChannel('test/sync-toggle');
      var enabled = false;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'setEmergencyMode') {
          enabled = (call.arguments as Map)['enabled'] as bool;
          return {'enabled': enabled};
        }
        return message()..['emergency_mode_enabled'] = enabled;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      await tester.pumpWidget(
        MaterialApp(
          home: SyncStatusScreen(bridge: MapBridge(methodChannel: channel)),
        ),
      );
      await tester.pump();
      await tester.tap(find.byType(Switch));
      await tester.pump();
      expect(enabled, isTrue);
      expect(find.text('正在與附近節點同步'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
