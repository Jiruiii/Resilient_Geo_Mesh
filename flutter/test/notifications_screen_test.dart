import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
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
      await tester.tap(find.text('政府公告・安全提醒'));
      await tester.pumpAndSettle();

      expect(
        find.byWidgetPredicate(
          (widget) => widget is Icon && widget.semanticLabel == '未讀',
        ),
        findsOneWidget,
      );
      expect(find.text('全部已讀'), findsOneWidget);
      expect(find.text('全部刪除'), findsOneWidget);
      await tester.tap(find.text('測試通知'));
      expect(reads, <MeshEvent>[notice]);

      await tester.tap(find.byTooltip('展開通知詳情'));
      await tester.pumpAndSettle();
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

    await tester.tap(find.text('政府公告・安全提醒'));
    await tester.pumpAndSettle();

    expect(find.text('測試通知'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Icon && widget.semanticLabel == '未讀',
      ),
      findsNothing,
    );
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

    await tester.tap(find.text('政府公告・物資站'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('展開通知詳情'));
    await tester.pumpAndSettle();

    expect(find.textContaining('公告類別：物資站'), findsOneWidget);
    expect(find.byIcon(MapIconCatalog.supplyStation), findsOneWidget);
  });

  testWidgets(
    'shelter announcement is categorized and shows its town impact area',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final directory = await TaiwanAdministrativeAreaDirectory.load();
      final event = MeshEvent(
        namespace: 'official.announcement',
        eventId: 'announcement:shelter-notice',
        eventVersion: 1,
        eventType: 'GOVERNMENT_ANNOUNCEMENT',
        severity: 'MEDIUM',
        source: 'GOVERNMENT',
        issuedAt: '2026-10-21T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        applyState: null,
        geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
        attributes: const <String, dynamic>{
          'title': '新北市避難收容公告',
          'category': 'SHELTER',
          'area_id': 'tw.national',
          'affected_area_ids': <String>['tw.65000040'],
          'content': '前往指定收容處所',
          'has_map_location': true,
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: NotificationsScreen(
            events: <MeshEvent>[event],
            areaDirectory: directory,
            onEventRead: (_) {},
          ),
        ),
      );

      expect(find.text('政府公告・避難收容'), findsOneWidget);
      await tester.tap(find.text('政府公告・避難收容'));
      await tester.pumpAndSettle();
      expect(find.byIcon(MapIconCatalog.shelter), findsOneWidget);
      await tester.tap(find.byTooltip('展開通知詳情'));
      await tester.pumpAndSettle();
      expect(find.textContaining('範圍：新北市 永和區'), findsOneWidget);
    },
  );

  testWidgets('NCDR notification shows its normalized alert category', (
    tester,
  ) async {
    const event = MeshEvent(
      namespace: 'official.live.ncdr',
      eventId: 'ncdr:fire:notification',
      eventVersion: 1,
      eventType: 'FIRE_WARNING',
      severity: 'LOW',
      source: 'NCDR',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: 'CURRENT',
      geometry: PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
      attributes: <String, dynamic>{
        'title': '火災臨時屋',
        'ncdr_category_code': 'fire',
        'ncdr_category_label': '火災',
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: NotificationsScreen(
          events: const <MeshEvent>[event],
          onEventRead: (_) {},
        ),
      ),
    );

    await tester.tap(find.text('火災'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('展開通知詳情'));
    await tester.pumpAndSettle();

    expect(find.textContaining('告警分類：火災'), findsOneWidget);
    expect(find.textContaining('事件類型：FIRE_WARNING'), findsOneWidget);
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
          'source_description': '陸上強風',
          'theme': 'weather',
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

      await tester.tap(find.text('強風'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('展開通知詳情'));
      await tester.pumpAndSettle();

      expect(find.textContaining('影響範圍：新北市（縣市級警報）'), findsOneWidget);
      expect(find.textContaining('告警分類：強風'), findsOneWidget);
      expect(find.textContaining('地圖位置：影響範圍參考點'), findsOneWidget);
    },
  );

  testWidgets('forecast warning shows affected period and upcoming status', (
    tester,
  ) async {
    final start = DateTime.now().toUtc().add(const Duration(days: 1));
    final warning = MeshEvent(
      namespace: 'official.live.cwa-warning',
      eventId: 'cwa:warning:w-c0033-001:10004:2026-10-21-11:00:00:0',
      eventVersion: 1,
      eventType: 'WEATHER_WARNING',
      severity: 'UNKNOWN',
      source: 'CWA',
      issuedAt: start.toIso8601String(),
      expiresAt: start.add(const Duration(hours: 12)).toIso8601String(),
      applyState: 'CURRENT',
      geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
      attributes: const <String, dynamic>{
        'affected_area': '新竹縣',
        'coverage_level': 'county',
        'map_location_kind': 'area_reference',
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        home: NotificationsScreen(
          events: <MeshEvent>[warning],
          onEventRead: (_) {},
        ),
      ),
    );

    await tester.tap(find.text('氣象警報'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('展開通知詳情'));
    await tester.pumpAndSettle();

    expect(find.textContaining('狀態：尚未生效'), findsOneWidget);
    expect(find.textContaining('發布時間：來源未提供'), findsOneWidget);
    expect(find.textContaining('影響時段開始：'), findsOneWidget);
    expect(find.textContaining('影響時段結束：'), findsOneWidget);
    expect(find.textContaining('發布：${warning.issuedAt}'), findsNothing);
  });
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
