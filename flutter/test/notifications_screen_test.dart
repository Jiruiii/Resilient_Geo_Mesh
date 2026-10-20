import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/notifications_screen.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';

void main() {
  testWidgets(
    'notification actions show read state, deletion undo and bulk controls',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final notice = _notice('notice:one');
      final reads = <MeshEvent>[];
      final deletes = <MeshEvent>[];
      final undos = <MeshEvent>[];
      var markAllCount = 0;
      var deleteAllCount = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: NotificationsScreen(
            events: <MeshEvent>[notice],
            onEventRead: reads.add,
            onMarkAllRead: () => markAllCount += 1,
            onEventDeleted: deletes.add,
            onDeleteAll: () => deleteAllCount += 1,
            onUndoDelete: undos.add,
          ),
        ),
      );

      expect(find.text('未讀'), findsOneWidget);
      expect(find.text('全部已讀'), findsOneWidget);
      expect(find.text('全部刪除'), findsOneWidget);
      expect(find.text('標為已讀'), findsOneWidget);

      await tester.tap(find.text('標為已讀'));
      expect(reads, <MeshEvent>[notice]);

      await tester.tap(find.text('刪除通知'));
      await tester.pumpAndSettle();
      expect(deletes, <MeshEvent>[notice]);
      expect(find.text('通知已刪除'), findsOneWidget);
      tester.widget<SnackBarAction>(find.byType(SnackBarAction)).onPressed();
      await tester.pump();
      expect(undos, <MeshEvent>[notice]);

      await tester.tap(find.text('全部已讀'));
      expect(markAllCount, 1);
      await tester.tap(find.text('全部刪除'));
      await tester.pumpAndSettle();
      expect(find.textContaining('不會刪除地圖上的公告資料'), findsOneWidget);
      await tester.tap(find.text('刪除全部'));
      await tester.pumpAndSettle();
      expect(deleteAllCount, 1);
    },
  );

  testWidgets('read notifications remain in the list with a read label', (
    tester,
  ) async {
    final notice = _notice('notice:read');
    await tester.pumpWidget(
      MaterialApp(
        home: NotificationsScreen(
          events: <MeshEvent>[notice],
          readEventKeys: <String>{meshEventIdentity(notice)},
          onEventRead: (_) {},
        ),
      ),
    );

    expect(find.text('測試通知'), findsOneWidget);
    expect(find.text('已讀'), findsOneWidget);
    expect(find.text('標為已讀'), findsNothing);
  });

  testWidgets('supply station notification reuses the map station icon', (
    tester,
  ) async {
    final event = MeshEvent(
      namespace: 'official.announcement',
      eventId: 'station:notification',
      eventVersion: 1,
      eventType: 'GOVERNMENT_ANNOUNCEMENT',
      severity: 'MEDIUM',
      source: 'GOVERNMENT',
      issuedAt: '2026-10-12T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: null,
      geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
      attributes: const <String, dynamic>{
        'title': '三重物資站',
        'category': 'SUPPLY_STATION',
        'has_map_location': true,
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: NotificationsScreen(
          events: <MeshEvent>[event],
          onEventRead: (_) {},
        ),
      ),
    );

    expect(find.textContaining('公告類別：物資站'), findsOneWidget);
    expect(find.byIcon(MapIconCatalog.supplyStation), findsOneWidget);
  });

  testWidgets(
    'CWA county warning names its affected area and reference point',
    (tester) async {
      const warning = MeshEvent(
        namespace: 'official.cwa',
        eventId: 'wind:new-taipei',
        eventVersion: 1,
        eventType: 'WEATHER_WARNING',
        severity: 'UNKNOWN',
        source: 'CWA',
        issuedAt: '2026-10-21T03:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        applyState: 'CURRENT',
        geometry: PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
        attributes: <String, dynamic>{
          'affected_area': '新北市',
          'coverage_level': 'county',
          'map_location_kind': 'area_reference',
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: NotificationsScreen(
            events: const <MeshEvent>[warning],
            onEventRead: (_) {},
          ),
        ),
      );

      expect(find.textContaining('影響範圍：新北市（縣市級警報）'), findsOneWidget);
      expect(find.textContaining('地圖位置：影響範圍參考點'), findsOneWidget);
    },
  );
}

MeshEvent _notice(String id) => MeshEvent(
  namespace: 'official.announcement',
  eventId: id,
  eventVersion: 1,
  eventType: 'GOVERNMENT_ANNOUNCEMENT',
  severity: 'MEDIUM',
  source: 'GOVERNMENT',
  issuedAt: '2026-10-12T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  applyState: null,
  geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
  attributes: const <String, dynamic>{
    'title': '測試通知',
    'category': 'SAFETY',
    'has_map_location': true,
  },
);
