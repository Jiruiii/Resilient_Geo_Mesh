import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/screens/government_workbench_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeGovernmentApi extends GovernmentApiClient {
  _FakeGovernmentApi({this.announcements = const <Map<String, dynamic>>[]});

  final List<Map<String, dynamic>> announcements;
  Map<String, Object?>? createdAnnouncement;
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
    return <String, dynamic>{'event_id': 'announcement:test'};
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

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets(
    'announcement editor uses nationwide scope and human time input',
    (tester) async {
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

      await tester.pumpWidget(
        MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('官方公告'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('新增公告'));
      await tester.pumpAndSettle();

      expect(find.text('目標行政範圍代碼'), findsNothing);
      expect(find.text('全台灣公告'), findsOneWidget);
      expect(find.text('有效期限（台灣時間）'), findsOneWidget);
      expect(find.text('選擇地圖位置'), findsOneWidget);
      expect(find.text('經度'), findsNothing);
      expect(find.text('緯度'), findsNothing);
    },
  );

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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新增公告'));
    await tester.pumpAndSettle();
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
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認位置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('建立並發布'));
    await tester.pumpAndSettle();

    expect(api.createdAnnouncement?['category'], 'SUPPLY_STATION');
    expect(api.createdAnnouncement?['severity'], 'LOW');
    expect(api.createdAnnouncement?['longitude'], isA<double>());
    expect(api.createdAnnouncement?['latitude'], isA<double>());
  });

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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新增公告'));
    await tester.pumpAndSettle();
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
    final api = _FakeGovernmentApi(
      announcements: <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': 'announcement:later-published',
          'event_version': 1,
          'title': '較晚發布',
          'content': '公告內容',
          'category': 'SAFETY',
          'area_id': 'tw.national',
          'created_at': '2026-10-20T04:00:00Z',
          'expires_at': '2099-10-24T00:00:00Z',
          'retracted': false,
        },
        <String, dynamic>{
          'event_id': 'announcement:earlier-deadline',
          'event_version': 1,
          'title': '較早截止',
          'content': '公告內容',
          'category': 'SAFETY',
          'area_id': 'tw.national',
          'created_at': '2026-10-19T04:00:00Z',
          'expires_at': '2099-10-22T00:00:00Z',
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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();

    expect(find.text('安全提醒（2）'), findsOneWidget);
    expect(find.text('發布日期：2026/10/20 12:00:00'), findsNothing);
    await tester.tap(find.text('安全提醒（2）'));
    await tester.pumpAndSettle();
    expect(find.text('發布日期：2026/10/20 12:00:00'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('較晚發布')).dy,
      lessThan(tester.getTopLeft(find.text('較早截止')).dy),
    );

    await tester.tap(find.text('發布日期（新到舊）'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('截止日期（近到遠）'));
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(find.text('較早截止')).dy,
      lessThan(tester.getTopLeft(find.text('較晚發布')).dy),
    );
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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.text('官方公告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新增公告'));
    await tester.pumpAndSettle();
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

    await tester.pumpWidget(
      MaterialApp(home: GovernmentWorkbenchScreen(auth: auth)),
    );
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
