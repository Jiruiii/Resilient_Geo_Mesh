import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_index.dart';
import 'package:resilientgeo_flutter/screens/government_workbench_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeGovernmentApi extends GovernmentApiClient {
  _FakeGovernmentApi({
    List<Map<String, dynamic>> announcements = const <Map<String, dynamic>>[],
    this.persistRevisedScope = true,
    this.persistCreatedScope = true,
  }) : announcements = announcements
           .map(Map<String, dynamic>.from)
           .toList(growable: true);

  final List<Map<String, dynamic>> announcements;
  final bool persistRevisedScope;
  final bool persistCreatedScope;
  Map<String, Object?>? createdAnnouncement;
  Map<String, Object?>? revisedAnnouncement;
  String? revisedEventId;
  String? createdGovernmentPassword;

  @override
  Future<List<Map<String, dynamic>>> listReports({
    String status = 'PENDING',
  }) async => <Map<String, dynamic>>[];

  @override
  Future<List<Map<String, dynamic>>> listAnnouncements() async =>
      announcements.map(Map<String, dynamic>.from).toList(growable: false);

  @override
  Future<List<Map<String, dynamic>>> listUsers() async =>
      <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> createAnnouncement(
    Map<String, Object?> input,
  ) async {
    createdAnnouncement = Map<String, Object?>.from(input);
    announcements.insert(0, <String, dynamic>{
      'event_id': 'announcement:test',
      'event_version': 1,
      'area_id': 'tw.national',
      'retracted': false,
      ...input,
      if (!persistCreatedScope) 'affected_area_ids': null,
    });
    return <String, dynamic>{
      'event_id': 'announcement:test',
      'event_version': 1,
    };
  }

  @override
  Future<Map<String, dynamic>> reviseAnnouncement(
    String eventId,
    Map<String, Object?> input,
  ) async {
    revisedEventId = eventId;
    revisedAnnouncement = Map<String, Object?>.from(input);
    final index = announcements.indexWhere(
      (announcement) => announcement['event_id'] == eventId,
    );
    final version =
        index < 0
            ? 2
            : (announcements[index]['event_version'] as int? ?? 1) + 1;
    if (index >= 0) {
      announcements[index] = <String, dynamic>{
        ...announcements[index],
        'event_version': version,
        if (persistRevisedScope)
          'affected_area_ids': input['affected_area_ids'],
      };
    }
    return <String, dynamic>{'event_id': eventId, 'event_version': version};
  }

  @override
  Future<GovernmentUser> createGovernmentUser({
    required String account,
    required String displayName,
    required String agency,
    required String password,
  }) async {
    createdGovernmentPassword = password;
    return const GovernmentUser(
      id: 'staff-1',
      account: 'staff',
      displayName: '值班人員',
      agency: '試辦機關',
      role: 'GOVERNMENT',
      status: 'ACTIVE',
    );
  }
}

final _testAreaDirectory = TaiwanAdministrativeAreaDirectory.fromJson(
  <String, Object?>{
    'schema_version': 'taiwan-area-directory-v1',
    'coverage': 'TW',
    'target_coordinate_system': 'EPSG:4326',
    'source_version': 'sha256:${List<String>.filled(64, '0').join()}',
    'area_count': 5,
    'areas': <Map<String, Object?>>[
      <String, Object?>{
        'area_id': 'tw.63000',
        'level': 'county',
        'parent_area_id': null,
        'county_name': '臺北市',
        'town_name': null,
      },
      <String, Object?>{
        'area_id': 'tw.63000050',
        'level': 'town',
        'parent_area_id': 'tw.63000',
        'county_name': '臺北市',
        'town_name': '中正區',
      },
      <String, Object?>{
        'area_id': 'tw.64000',
        'level': 'county',
        'parent_area_id': null,
        'county_name': '高雄市',
        'town_name': null,
      },
      <String, Object?>{
        'area_id': 'tw.68000',
        'level': 'county',
        'parent_area_id': null,
        'county_name': '桃園市',
        'town_name': null,
      },
      <String, Object?>{
        'area_id': 'tw.68000010',
        'level': 'town',
        'parent_area_id': 'tw.68000',
        'county_name': '桃園市',
        'town_name': '桃園區',
      },
    ],
  },
);

final _testAreaIndex = TaiwanAdministrativeAreaIndex.fromJson(
  _testAreaDirectory,
  <String, Object?>{
    'schema_version': 'taiwan-area-index-v1',
    'coverage': 'TW',
    'target_coordinate_system': 'EPSG:4326',
    'source_version': _testAreaDirectory.sourceVersion,
    'area_count': 2,
    'coordinate_encoding': 'flat-pairs-v1',
    'areas': <Map<String, Object?>>[
      <String, Object?>{
        'area_id': 'tw.63000050',
        'level': 'town',
        'parent_area_id': 'tw.63000',
        'county_name': '臺北市',
        'town_name': '中正區',
        'geometry_type': 'Polygon',
        'coordinate_offset': 0,
        'ring_offsets': <int>[0, 5],
        'polygon_offsets': <int>[0, 1],
        'bbox': <double>[121.4, 24.9, 121.6, 25.2],
      },
      <String, Object?>{
        'area_id': 'tw.68000010',
        'level': 'town',
        'parent_area_id': 'tw.68000',
        'county_name': '桃園市',
        'town_name': '桃園區',
        'geometry_type': 'Polygon',
        'coordinate_offset': 5,
        'ring_offsets': <int>[0, 5],
        'polygon_offsets': <int>[0, 1],
        'bbox': <double>[121.2, 24.9, 121.4, 25.1],
      },
    ],
    'coordinates': <double>[
      121.4,
      24.9,
      121.6,
      24.9,
      121.6,
      25.2,
      121.4,
      25.2,
      121.4,
      24.9,
      121.2,
      24.9,
      121.4,
      24.9,
      121.4,
      25.1,
      121.2,
      25.1,
      121.2,
      24.9,
    ],
  },
);

Widget _workbench(GovernmentAuthController auth) => GovernmentWorkbenchScreen(
  auth: auth,
  areaDirectory: _testAreaDirectory,
  areaIndex: _testAreaIndex,
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('announcement editor requires an explicit impact range', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth =
        GovernmentAuthController(api: api)
          ..user = const GovernmentUser(
            id: 'admin',
            account: 'admin',
            displayName: '管理者',
            agency: '試辦機關',
            role: 'SYSTEM_ADMIN',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await _openAnnouncementEditor(tester);

    expect(find.text('目標行政範圍代碼'), findsNothing);
    expect(find.text('全台灣公告'), findsNothing);
    expect(find.text('尚未選擇影響範圍。請依座標建議或手動選擇。'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '建立並發布'))
          .onPressed,
      isNull,
    );
    expect(find.text('有效期限（台灣時間）'), findsOneWidget);
    expect(find.text('選擇地圖位置'), findsOneWidget);
    expect(find.text('經度'), findsNothing);
    expect(find.text('緯度'), findsNothing);
  });

  testWidgets('supply station category requires a selected map location', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await _openAnnouncementEditor(tester);
    await tester.tap(find.text('安全提醒'));
    await tester.pumpAndSettle();
    expect(find.text('物資站'), findsOneWidget);
    await tester.tap(find.text('物資站').last);
    await tester.pumpAndSettle();

    expect(find.text('物資站公告必須設定地圖位置。'), findsOneWidget);
    expect(find.text('嚴重程度'), findsNothing);
    final publishButton = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '建立並發布'),
    );
    expect(publishButton.onPressed, isNull);

    Finder field(String label) => find.byWidgetPredicate(
      (widget) => widget is TextField && widget.decoration?.labelText == label,
    );
    await tester.enterText(field('標題'), '三重物資站');
    await tester.enterText(field('內容'), '提供飲水與乾糧');
    await tester.ensureVisible(find.text('選擇地圖位置'));
    await tester.tap(find.text('選擇地圖位置'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('確認位置'));
    await tester.pumpAndSettle();
    await _selectNationwideRange(tester);
    await tester.tap(find.text('建立並發布'));
    await tester.pumpAndSettle();

    expect(api.createdAnnouncement?['category'], 'SUPPLY_STATION');
    expect(api.createdAnnouncement?['severity'], 'LOW');
    expect(api.createdAnnouncement?['longitude'], isA<double>());
    expect(api.createdAnnouncement?['latitude'], isA<double>());
    expect(api.createdAnnouncement?['affected_area_ids'], <String>[
      'tw.national',
    ]);
  });

  testWidgets('new announcement reports an API that drops the selected scope', (
    tester,
  ) async {
    final api = _FakeGovernmentApi(persistCreatedScope: false);
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await _openAnnouncementEditor(tester);
    Finder field(String label) => find.byWidgetPredicate(
      (widget) => widget is TextField && widget.decoration?.labelText == label,
    );
    await tester.enterText(field('標題'), '中壢公告');
    await tester.enterText(field('內容'), '測試內容');
    await _selectNationwideRange(tester);
    await tester.tap(find.text('建立並發布'));
    await tester.pumpAndSettle();

    expect(api.createdAnnouncement?['affected_area_ids'], <String>[
      'tw.national',
    ]);
    expect(
      find.text('伺服器回讀的公告版本或影響範圍與所選內容不同。請更新工作台 API 後重新發布。'),
      findsOneWidget,
    );
  });

  testWidgets(
    'suggests a coordinate area and requires acknowledgement for a mismatched override',
    (tester) async {
      final api = _FakeGovernmentApi(
        announcements: <Map<String, dynamic>>[
          <String, dynamic>{
            'event_id': 'announcement:range-edit',
            'event_version': 1,
            'title': '臺北公告',
            'content': '測試範圍調整',
            'category': 'SAFETY',
            'area_id': 'tw.national',
            'affected_area_ids': <String>['tw.national'],
            'location': <String, Object?>{
              'longitude': 121.517,
              'latitude': 25.0478,
            },
            'updated_at': '2026-10-20T04:00:00Z',
            'expires_at': '2026-11-20T00:00:00Z',
            'retracted': false,
          },
        ],
      );
      final auth =
          GovernmentAuthController(api: api, androidDeviceMode: false)
            ..user = const GovernmentUser(
              id: 'staff',
              account: 'staff',
              displayName: '值班人員',
              agency: '試辦機關',
              role: 'GOVERNMENT',
              status: 'ACTIVE',
            )
            ..loading = false;
      addTearDown(auth.dispose);

      await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
      await tester.pumpAndSettle();
      await tester.tap(find.text('官方公告'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('安全提醒（1）'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('公告操作'));
      await tester.pumpAndSettle();
      await _openExistingAnnouncementEditor(tester);

      expect(
        find.byKey(const ValueKey('announcement-area-point-suggestion')),
        findsOneWidget,
      );
      expect(find.text('套用座標建議：臺北市 中正區'), findsOneWidget);
      expect(find.text('全台灣'), findsOneWidget);
      await tester.ensureVisible(
        find.byKey(const ValueKey('announcement-area-apply-suggestion')),
      );
      await tester.tap(
        find.byKey(const ValueKey('announcement-area-apply-suggestion')),
      );
      await tester.pumpAndSettle();
      expect(find.text('臺北市 中正區'), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(const ValueKey('announcement-area-selector')),
      );
      await tester.tap(
        find.byKey(const ValueKey('announcement-area-selector')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('administrative-area-search')),
        '高雄市',
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('administrative-area-option-tw.64000')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('確認'));
      await tester.pumpAndSettle();

      expect(find.text('高雄市'), findsOneWidget);
      await tester.ensureVisible(
        find.byKey(const ValueKey('announcement-area-selector')),
      );
      await tester.tap(
        find.byKey(const ValueKey('announcement-area-selector')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('administrative-area-search')),
        '中正區',
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('administrative-area-option-tw.63000050')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('確認'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(
          const ValueKey('announcement-area-mismatch-acknowledgement'),
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '修訂並發布'))
            .onPressed,
        isNull,
      );
      await tester.ensureVisible(
        find.byKey(
          const ValueKey('announcement-area-mismatch-acknowledgement'),
        ),
      );
      await tester.tap(
        find.byKey(
          const ValueKey('announcement-area-mismatch-acknowledgement'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '修訂並發布'))
            .onPressed,
        isNotNull,
      );
    },
  );

  testWidgets('road and shelter categories require a selected map location', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    Finder field(String label) => find.byWidgetPredicate(
      (widget) => widget is TextField && widget.decoration?.labelText == label,
    );

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await _openAnnouncementEditor(tester);
    await tester.enterText(field('標題'), '位置必填公告');
    await tester.enterText(field('內容'), '需選擇地圖位置');

    await tester.tap(find.text('安全提醒'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('道路').last);
    await tester.pumpAndSettle();
    expect(find.text('道路公告必須設定地圖位置。'), findsOneWidget);

    await tester.tap(find.text('道路').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('避難收容').last);
    await tester.pumpAndSettle();
    expect(find.text('避難收容公告必須設定地圖位置。'), findsOneWidget);
    expect(api.createdAnnouncement, isNull);
  });

  testWidgets('announcement groups show dates and sort by selected date', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _FakeGovernmentApi(
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': 'z-announcement:later-published',
          'event_version': 1,
          'title': '較晚發布',
          'content': '公告內容',
          'category': 'SAFETY',
          'area_id': 'tw.national',
          'updated_at': '2026-10-20T04:00:00Z',
          'expires_at': '2026-11-20T00:00:00Z',
          'retracted': false,
        },
        <String, dynamic>{
          'event_id': 'a-announcement:earlier-deadline',
          'event_version': 1,
          'title': '較早截止',
          'content': '公告內容',
          'category': 'SAFETY',
          'area_id': 'tw.national',
          'updated_at': '2026-10-19T04:00:00Z',
          'expires_at': '2000-10-22T00:00:00Z',
          'retracted': false,
        },
      ],
    );
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();

    expect(find.text('安全提醒（2）'), findsOneWidget);
    expect(find.text('發布日期：2026/10/20 12:00:00'), findsNothing);
    await tester.tap(find.text('安全提醒（2）'));
    await tester.pumpAndSettle();
    expect(find.text('發布日期：2026/10/20 12:00:00'), findsOneWidget);
    final expiredTitle = find.text('較早截止 · 已過期');
    expect(
      tester.getTopLeft(find.text('較晚發布')).dy,
      lessThan(tester.getTopLeft(expiredTitle).dy),
    );

    await tester.tap(find.text('發布日期（新到舊）'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('截止日期（近到遠）'));
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(expiredTitle).dy,
      lessThan(tester.getTopLeft(find.text('較晚發布')).dy),
    );
  });

  testWidgets(
    'legacy nationwide transport scope does not override saved impact areas',
    (tester) async {
      final api = _FakeGovernmentApi(
        announcements: <Map<String, dynamic>>[
          <String, dynamic>{
            'event_id': 'announcement:local-area',
            'event_version': 2,
            'title': '三重公告',
            'content': '三重範圍內容',
            'category': 'SAFETY',
            'area_id': 'tw.national',
            'affected_area_ids': <String>['tw.63000050'],
            'updated_at': '2026-10-20T04:00:00Z',
            'expires_at': '2099-10-24T00:00:00Z',
            'retracted': false,
          },
        ],
      );
      final auth =
          GovernmentAuthController(api: api, androidDeviceMode: false)
            ..user = const GovernmentUser(
              id: 'staff',
              account: 'staff',
              displayName: '值班人員',
              agency: '試辦機關',
              role: 'GOVERNMENT',
              status: 'ACTIVE',
            )
            ..loading = false;
      addTearDown(auth.dispose);

      await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
      await tester.pumpAndSettle();
      await tester.tap(find.text('官方公告'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('安全提醒（1）'));
      await tester.pumpAndSettle();

      expect(find.text('臺北市 中正區 · 版本 2'), findsOneWidget);
      expect(find.text('全台灣 · 版本 2'), findsNothing);
    },
  );

  testWidgets('legacy nationwide scope keeps coordinate area as a suggestion', (
    tester,
  ) async {
    final api = _FakeGovernmentApi(
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': 'announcement:legacy-national',
          'event_version': 1,
          'title': 'Asupport',
          'content': 'support',
          'category': 'SUPPLY_STATION',
          'severity': 'LOW',
          'area_id': 'tw.national',
          'location': <String, Object?>{
            'longitude': 121.517,
            'latitude': 25.0478,
          },
          'updated_at': '2026-10-20T04:00:00Z',
          'expires_at': '2026-11-20T00:00:00Z',
          'retracted': false,
        },
      ],
    );
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('物資站（1）'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('公告操作'));
    await tester.pumpAndSettle();
    await _openExistingAnnouncementEditor(tester);

    expect(find.text('全台灣'), findsOneWidget);
    expect(find.text('現有範圍尚無細部行政區資料'), findsOneWidget);
    expect(find.text('座標建議（尚未套用）：臺北市 中正區'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
      findsOneWidget,
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
    );
    await tester.tap(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
    );
    await tester.pumpAndSettle();
    expect(find.text('臺北市 中正區'), findsOneWidget);
    expect(find.text('已儲存影響範圍'), findsOneWidget);
    expect(find.text('本次修訂影響範圍'), findsOneWidget);
    expect(find.text('現有範圍尚無細部行政區資料'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
      findsNothing,
    );
    await tester.tap(find.text('修訂並發布'));
    await tester.pumpAndSettle();

    expect(api.revisedEventId, 'announcement:legacy-national');
    expect(api.revisedAnnouncement?['affected_area_ids'], <String>[
      'tw.63000050',
    ]);
    expect(find.text('臺北市 中正區 · 版本 2'), findsOneWidget);
    expect(find.text('全台灣 · 版本 2'), findsNothing);

    await tester.tap(find.byTooltip('公告操作'));
    await tester.pumpAndSettle();
    await _openExistingAnnouncementEditor(tester);
    expect(find.text('已儲存影響範圍'), findsOneWidget);
    expect(find.text('臺北市 中正區'), findsOneWidget);
    expect(find.text('現有範圍尚無細部行政區資料'), findsNothing);
    expect(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
      findsNothing,
    );
  });

  testWidgets('shows an error when the API does not persist revised scope', (
    tester,
  ) async {
    final api = _FakeGovernmentApi(
      persistRevisedScope: false,
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': 'announcement:old-api',
          'event_version': 1,
          'title': '舊 API 公告',
          'content': '測試內容',
          'category': 'SUPPLY_STATION',
          'severity': 'LOW',
          'area_id': 'tw.national',
          'location': <String, Object?>{
            'longitude': 121.517,
            'latitude': 25.0478,
          },
          'updated_at': '2026-10-20T04:00:00Z',
          'expires_at': '2026-11-20T00:00:00Z',
          'retracted': false,
        },
      ],
    );
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('物資站（1）'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('公告操作'));
    await tester.pumpAndSettle();
    await _openExistingAnnouncementEditor(tester);
    await tester.ensureVisible(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
    );
    await tester.tap(
      find.byKey(const ValueKey('announcement-area-apply-suggestion')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('修訂並發布'));
    await tester.pumpAndSettle();

    expect(
      find.text('修訂已送出，但伺服器回讀的公告版本或影響範圍與所選內容不同。請更新工作台 API 後重新修訂。'),
      findsOneWidget,
    );
    expect(find.text('全台灣 · 版本 2'), findsOneWidget);
    expect(find.text('臺北市 中正區 · 版本 2'), findsNothing);
  });

  testWidgets('manually selected Taoyuan District is sent when revising', (
    tester,
  ) async {
    final api = _FakeGovernmentApi(
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': 'announcement:legacy-national-manual-range',
          'event_version': 1,
          'title': '桃園公告',
          'content': '桃園範圍內容',
          'category': 'SAFETY',
          'area_id': 'tw.national',
          'updated_at': '2026-10-20T04:00:00Z',
          'expires_at': '2026-11-20T00:00:00Z',
          'retracted': false,
        },
      ],
    );
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('安全提醒（1）'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('公告操作'));
    await tester.pumpAndSettle();
    await _openExistingAnnouncementEditor(tester);

    await tester.ensureVisible(
      find.byKey(const ValueKey('announcement-area-selector')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('announcement-area-selector')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('administrative-area-search')),
      '桃園區',
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('administrative-area-option-tw.68000010')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();

    expect(find.text('桃園市 桃園區'), findsOneWidget);
    await tester.tap(find.text('修訂並發布'));
    await tester.pumpAndSettle();

    expect(api.revisedEventId, 'announcement:legacy-national-manual-range');
    expect(api.revisedAnnouncement?['affected_area_ids'], <String>[
      'tw.68000010',
    ]);
  });

  testWidgets('expired announcements are gray and can be hidden locally', (
    tester,
  ) async {
    const eventId = 'announcement:expired';
    final api = _FakeGovernmentApi(
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': eventId,
          'event_version': 2,
          'title': '已過期公告',
          'content': '已截止',
          'category': 'ROAD',
          'area_id': 'tw.national',
          'created_at': '2026-10-19T04:00:00Z',
          'expires_at': '2000-01-01T00:00:00Z',
          'retracted': false,
        },
      ],
    );
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('道路（1）'));
    await tester.pumpAndSettle();

    final title = find.text('已過期公告 · 已過期');
    expect(title, findsOneWidget);
    final card = find.ancestor(of: title, matching: find.byType(Card)).first;
    expect(tester.widget<Card>(card).color, Colors.grey.shade200);

    await tester.tap(find.byTooltip('公告操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('從此工作台刪除'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('刪除'));
    await tester.pumpAndSettle();

    expect(find.text('目前沒有可顯示的公告'), findsOneWidget);
    final preferences = await SharedPreferences.getInstance();
    expect(
      preferences.getStringList(
        'government.workbench.hidden_announcements.v1.staff',
      ),
      <String>['$eventId:2'],
    );
  });

  testWidgets('announcement title and content display required when empty', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth =
        GovernmentAuthController(api: api, androidDeviceMode: false)
          ..user = const GovernmentUser(
            id: 'staff',
            account: 'staff',
            displayName: '值班人員',
            agency: '試辦機關',
            role: 'GOVERNMENT',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await _openAnnouncementEditor(tester);
    await _selectNationwideRange(tester);
    await tester.tap(find.text('建立並發布'));
    await tester.pumpAndSettle();

    expect(find.text('required'), findsNWidgets(2));
    expect(api.createdAnnouncement, isNull);
  });

  testWidgets('government account form requires 12 password characters', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth =
        GovernmentAuthController(api: api)
          ..user = const GovernmentUser(
            id: 'admin',
            account: 'admin',
            displayName: '管理者',
            agency: '試辦機關',
            role: 'SYSTEM_ADMIN',
            status: 'ACTIVE',
          )
          ..loading = false;
    addTearDown(auth.dispose);

    Finder field(String label) => find.byWidgetPredicate(
      (widget) => widget is TextField && widget.decoration?.labelText == label,
    );

    await tester.pumpWidget(MaterialApp(home: _workbench(auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('帳號管理'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新增政府人員'));
    await tester.pumpAndSettle();
    await tester.enterText(field('帳號'), 'staff');
    await tester.enterText(field('姓名'), '值班人員');
    await tester.enterText(field('服務機關'), '試辦機關');
    await tester.enterText(field('設定密碼'), 'short');
    await tester.enterText(field('確認密碼'), 'short');
    await tester.tap(find.text('建立帳號'));
    await tester.pumpAndSettle();

    expect(find.text('密碼至少需要 12 個字元'), findsOneWidget);
    expect(api.createdGovernmentPassword, isNull);

    final unrestrictedPassword = List<String>.filled(12, '!').join();
    await tester.enterText(field('設定密碼'), unrestrictedPassword);
    await tester.enterText(field('確認密碼'), unrestrictedPassword);
    await tester.tap(find.text('建立帳號'));
    await tester.pumpAndSettle();

    expect(api.createdGovernmentPassword, unrestrictedPassword);
  });
}

Future<void> _selectNationwideRange(WidgetTester tester) async {
  await tester.ensureVisible(
    find.byKey(const ValueKey('announcement-area-selector')),
  );
  await tester.tap(find.byKey(const ValueKey('announcement-area-selector')));
  await tester.pumpAndSettle();
  await tester.tap(
    find.byKey(const ValueKey('administrative-area-option-tw.national')),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('確認'));
  await tester.pumpAndSettle();
}

Future<void> _openAnnouncementEditor(WidgetTester tester) async {
  await tester.tap(find.text('新增公告'));
  await tester.pump();
  if (find.text('載入行政區資料…').evaluate().isNotEmpty) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 5)),
    );
  }
  await tester.pumpAndSettle();
}

Future<void> _openExistingAnnouncementEditor(WidgetTester tester) async {
  await tester.tap(find.text('修訂'));
  await tester.pump();
  if (find.text('載入行政區資料…').evaluate().isNotEmpty) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 5)),
    );
  }
  await tester.pumpAndSettle();
}
