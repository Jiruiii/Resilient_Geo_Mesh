import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/screens/government_sync_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(MapBridge.methodChannelName);
  testWidgets(
    'shows source freshness and keeps offline fallback visible after failed sync',
    (tester) async {
      final calls = <MethodCall>[];
      final state = <String, dynamic>{
        'url': 'https://test.pages.dev/',
        'enabled': true,
        'syncing': false,
        'last_success': null,
        'revision': 0,
        'sources': [
          {
            'id': 'tdx-road',
            'status': 'blocked_by_auth',
            'last_success_at': null,
            'event_count': 0,
          },
        ],
      };
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            if (call.method == 'syncGovernmentNow') {
              return {...state, 'error': '暫時無法取得更新；離線資料與附近轉傳仍可使用。'};
            }
            return state;
          });
      await tester.pumpWidget(
        MaterialApp(home: GovernmentSyncScreen(bridge: MapBridge())),
      );
      await tester.pump();
      expect(find.text('憑證待設定'), findsOneWidget);
      expect(find.textContaining('尚未更新'), findsWidgets);
      await tester.tap(find.text('儲存並立即更新'));
      await tester.pump();
      expect(
        calls
            .where((call) => call.method == 'configureGovernmentSync')
            .single
            .arguments,
        {'url': 'https://test.pages.dev/', 'enabled': true, 'area': 'all'},
      );
      expect(
        calls.where((call) => call.method == 'syncGovernmentNow'),
        hasLength(1),
      );
      expect(find.textContaining('離線資料與附近轉傳仍可使用'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );
}
