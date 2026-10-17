import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/ncdr_map_filter.dart';
import 'package:resilientgeo_flutter/screens/notifications_screen.dart';

MeshEvent _announcement({required bool hasLocation}) => MeshEvent(
  namespace: 'official.announcement',
  eventId: 'announcement:device:test',
  eventVersion: 3,
  eventType: 'GOVERNMENT_ANNOUNCEMENT',
  severity: 'HIGH',
  source: 'GOVERNMENT',
  issuedAt: '2026-11-23T11:39:04.000Z',
  expiresAt: '2099-11-23T11:39:04.000Z',
  applyState: 'CURRENT',
  geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
  attributes: <String, dynamic>{
    'title': '測試官方警告',
    'content': '官方發布內容',
    'area_id': 'tw.national',
    'theme': 'announcement',
    'has_map_location': hasLocation,
  },
);

void main() {
  test(
    'official device warnings use the map only when a location was supplied',
    () {
      final nationwide = _announcement(hasLocation: false);
      final located = _announcement(hasLocation: true);
      final revocation = MeshEvent(
        namespace: 'official.device-revocation',
        eventId: 'device-revocation:private',
        eventVersion: 1,
        eventType: 'GOVERNMENT_DEVICE_REVOKED',
        severity: 'LOW',
        source: 'GOVERNMENT',
        issuedAt: '2026-11-23T11:39:04.000Z',
        expiresAt: '2100-01-01T00:00:00.000Z',
        applyState: 'CURRENT',
        geometry: null,
        attributes: const <String, dynamic>{'internal_only': true},
      );

      expect(isAppSupportedEvent(nationwide), isTrue);
      expect(isMapVisibleEvent(nationwide), isFalse);
      expect(isMapVisibleEvent(located), isTrue);
      expect(isAppSupportedEvent(revocation), isFalse);
    },
  );

  testWidgets(
    'notifications show verified nationwide warning details and keep reports unverified',
    (tester) async {
      final report = MeshEvent(
        namespace: 'crowd.reports',
        eventId: 'report:test',
        eventVersion: 1,
        eventType: 'CROWD_REPORT',
        severity: 'MEDIUM',
        source: 'CITIZEN',
        issuedAt: '2026-11-23T11:39:04.000Z',
        expiresAt: '2099-11-23T11:39:04.000Z',
        applyState: 'UNVERIFIED',
        geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
        attributes: const <String, dynamic>{'category': 'FLOOD'},
      );

      await tester.pumpWidget(
        MaterialApp(
          home: NotificationsScreen(
            events: <MeshEvent>[_announcement(hasLocation: true), report],
            onEventRead: (_) {},
          ),
        ),
      );

      expect(find.text('測試官方警告'), findsOneWidget);
      expect(find.textContaining('狀態：官方簽章已驗證'), findsOneWidget);
      expect(find.textContaining('範圍：全台灣'), findsOneWidget);
      expect(find.textContaining('版本：3'), findsOneWidget);
      expect(
        find.textContaining('地圖位置：緯度 25.000000，經度 121.500000'),
        findsOneWidget,
      );
      expect(find.textContaining('發布：2026/11/23 19:39:04'), findsOneWidget);
      expect(find.textContaining('內容：官方發布內容'), findsOneWidget);
      expect(find.textContaining('狀態：未經查證，僅供參考'), findsOneWidget);
    },
  );
}
