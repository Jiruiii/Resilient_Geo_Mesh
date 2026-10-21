import 'dart:convert';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:resilientgeo_flutter/data/government_account_cache.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_index.dart';
import 'package:resilientgeo_flutter/screens/profile_screen.dart';
import 'package:resilientgeo_flutter/screens/government_workbench_screen.dart';

final _profileAreaDirectory = TaiwanAdministrativeAreaDirectory.fromJson(
  <String, Object?>{
    'schema_version': 'taiwan-area-directory-v1',
    'coverage': 'TW',
    'target_coordinate_system': 'EPSG:4326',
    'source_version': 'sha256:${'a' * 64}',
    'area_count': 1,
    'areas': <Map<String, Object?>>[
      <String, Object?>{
        'area_id': 'tw.63000',
        'level': 'county',
        'parent_area_id': null,
        'county_name': '臺北市',
        'town_name': null,
      },
    ],
  },
);
final _profileAreaIndex = TaiwanAdministrativeAreaIndex.fromJson(
  _profileAreaDirectory,
  <String, Object?>{
    'schema_version': 'taiwan-area-index-v1',
    'coverage': 'TW',
    'target_coordinate_system': 'EPSG:4326',
    'source_version': _profileAreaDirectory.sourceVersion,
    'area_count': 0,
    'coordinate_encoding': 'flat-pairs-v1',
    'areas': <Object?>[],
    'coordinates': <double>[],
  },
);

class _FakeGovernmentApi extends GovernmentApiClient {
  GovernmentUser? current;
  String? lastAccount;
  GovernmentUser? createdUser;
  final uploadedWarnings = <Map<String, dynamic>>[];

  @override
  Future<GovernmentUser?> currentUser() async => current;

  @override
  Future<GovernmentUser> login(String account, String password) async {
    lastAccount = account;
    if (password != 'correct-password') {
      throw const GovernmentApiException('credentials_invalid', 401);
    }
    current = GovernmentUser(
      id: 'staff-1',
      account: account.trim().toLowerCase(),
      displayName: account == 'admin-01' ? '系統管理者' : '值班人員',
      agency: '試辦機關',
      role: account == 'admin-01' ? 'SYSTEM_ADMIN' : 'GOVERNMENT',
      status: 'ACTIVE',
    );
    return current!;
  }

  @override
  Future<List<Map<String, dynamic>>> listReports({
    String status = 'PENDING',
  }) async => <Map<String, dynamic>>[];

  @override
  Future<List<Map<String, dynamic>>> listAnnouncements() async =>
      <Map<String, dynamic>>[];

  @override
  Future<List<Map<String, dynamic>>> listUsers() async =>
      <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> uploadGovernmentWarning(
    Map<String, dynamic> event,
  ) async {
    uploadedWarnings.add(Map<String, dynamic>.from(event));
    return <String, dynamic>{
      'event_id': event['event_id'],
      'payload_hash': event['payload_hash'],
      'publication_status': 'QUEUED',
    };
  }

  @override
  Future<GovernmentUser> createGovernmentUser({
    required String account,
    required String displayName,
    required String agency,
    required String password,
  }) async {
    createdUser = GovernmentUser(
      id: 'new-staff',
      account: account.trim().toLowerCase(),
      displayName: displayName,
      agency: agency,
      role: 'GOVERNMENT',
      status: 'ACTIVE',
    );
    return createdUser!;
  }

  @override
  Future<void> logout() async {
    current = null;
  }
}

class _OfflineGovernmentApi extends GovernmentApiClient {
  @override
  Future<GovernmentUser?> currentUser() async =>
      throw const GovernmentApiException('network_unavailable', 0);
}

class _MemoryGovernmentAccountCache implements GovernmentAccountCache {
  Map<String, dynamic>? value;

  @override
  Future<Map<String, dynamic>?> read() async => value;

  @override
  Future<void> write(Map<String, dynamic> user) async => value = user;

  @override
  Future<void> clear() async => value = null;
}

class _DeviceAuthorizationBridge extends MapBridge {
  _DeviceAuthorizationBridge(
    this.status, {
    this.warningStatuses = const [],
    this.pendingUploads = const [],
  });

  final String status;
  final List<Map<String, dynamic>> warningStatuses;
  final List<Map<String, dynamic>> pendingUploads;
  final acknowledgedUploads = <String>[];

  @override
  Future<Map<String, dynamic>> getGovernmentDeviceAuthorization() async =>
      <String, dynamic>{
        'status': status,
        'certificate_expires_at':
            DateTime.now()
                .toUtc()
                .add(const Duration(days: 2))
                .toIso8601String(),
      };

  @override
  Future<MapInitialState> getInitialState() async =>
      const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: true);

  @override
  Future<List<Map<String, dynamic>>> listGovernmentWarningStatuses() async =>
      warningStatuses;

  @override
  Future<List<Map<String, dynamic>>>
  listPendingGovernmentWarningUploads() async => pendingUploads;

  @override
  Future<bool> markGovernmentWarningUploaded({
    required String eventId,
    required String payloadHash,
  }) async {
    acknowledgedUploads.add(eventId);
    return true;
  }

  @override
  Future<bool> markGovernmentWarningExpired({
    required String eventId,
    required String payloadHash,
  }) async => true;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test(
    'offline restore requires a currently valid cached government certificate',
    () async {
      final cache =
          _MemoryGovernmentAccountCache()
            ..value =
                const GovernmentUser(
                  id: 'staff-1',
                  account: 'staff-01',
                  displayName: '值班人員',
                  agency: '試辦機關',
                  role: 'GOVERNMENT',
                  status: 'ACTIVE',
                ).toJson();
      final auth = GovernmentAuthController(
        api: _OfflineGovernmentApi(),
        accountCache: cache,
        mapBridge: _DeviceAuthorizationBridge('AUTHORIZED'),
        androidDeviceMode: true,
      );
      await auth.restore();
      expect(auth.user?.account, 'staff-01');
      expect(auth.restoredOffline, isTrue);
      auth.dispose();

      final expired = GovernmentAuthController(
        api: _OfflineGovernmentApi(),
        accountCache: cache,
        mapBridge: _DeviceAuthorizationBridge('CERTIFICATE_EXPIRED_OR_INVALID'),
        androidDeviceMode: true,
      );
      await expired.restore();
      expect(expired.user, isNull);
      expect(expired.restoredOffline, isFalse);
      expired.dispose();
    },
  );

  testWidgets(
    'government workbench displays real mesh and cloud warning states',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = _FakeGovernmentApi();
      final bridge = _DeviceAuthorizationBridge(
        'AUTHORIZED',
        warningStatuses: <Map<String, dynamic>>[
          <String, dynamic>{
            'event_id': 'announcement:pending',
            'upload_status': 'PENDING',
          },
          <String, dynamic>{
            'event_id': 'announcement:uploaded',
            'upload_status': 'UPLOADED',
          },
          <String, dynamic>{
            'event_id': 'announcement:published',
            'upload_status': 'PUBLISHED',
          },
        ],
        pendingUploads: <Map<String, dynamic>>[
          <String, dynamic>{
            'event_id': 'announcement:auto-upload',
            'payload_hash': 'sha256:auto-upload',
            'event_json': jsonEncode(<String, dynamic>{
              'event_id': 'announcement:auto-upload',
              'payload_hash': 'sha256:auto-upload',
              'expires_at':
                  DateTime.now()
                      .toUtc()
                      .add(const Duration(hours: 1))
                      .toIso8601String(),
              'signature': 'original-signature',
            }),
          },
        ],
      );
      final auth =
          GovernmentAuthController(
              api: api,
              mapBridge: bridge,
              accountCache: _MemoryGovernmentAccountCache(),
              androidDeviceMode: true,
            )
            ..user = const GovernmentUser(
              id: 'staff-1',
              account: 'staff-01',
              displayName: '值班人員',
              agency: '試辦機關',
              role: 'GOVERNMENT',
              status: 'ACTIVE',
            )
            ..restoredOffline = true
            ..loading = false;
      addTearDown(auth.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: GovernmentWorkbenchScreen(
            auth: auth,
            areaDirectory: _profileAreaDirectory,
            areaIndex: _profileAreaIndex,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('官方公告'));
      await tester.pumpAndSettle();

      expect(find.text('待 Mesh 同步'), findsWidgets);
      expect(find.text('待雲端補傳'), findsOneWidget);
      expect(find.text('待官方 feed 發布'), findsOneWidget);
      expect(find.text('已發布'), findsOneWidget);
      await tester.pump();
      expect(
        api.uploadedWarnings.single['event_id'],
        'announcement:auto-upload',
      );
      expect(bridge.acknowledgedUploads, <String>['announcement:auto-upload']);
    },
  );

  testWidgets('profile hides offline data explanation and keeps preferences', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        home: ProfileScreen(
          themeMode: ThemeMode.system,
          animationEnabled: true,
          onThemeModeChanged: (_) {},
          onAnimationChanged: (_) {},
        ),
      ),
    );

    expect(find.text('地圖底圖'), findsNothing);
    expect(find.text('離線資料說明'), findsNothing);
    expect(find.textContaining('版本化快照'), findsNothing);
    expect(find.byType(DropdownButtonFormField<ThemeMode>), findsOneWidget);
  });

  testWidgets(
    'profile opens notification area settings and saves a town selection',
    (tester) async {
      final directory = await TaiwanAdministrativeAreaDirectory.load();
      Set<String>? savedAreas;
      await tester.pumpWidget(
        MaterialApp(
          home: ProfileScreen(
            themeMode: ThemeMode.system,
            animationEnabled: true,
            notificationAreaDirectory: directory,
            notificationAreaIds: const <String>{'tw.national'},
            onNotificationAreaIdsChanged:
                (areaIds) async => savedAreas = areaIds,
            onThemeModeChanged: (_) {},
            onAnimationChanged: (_) {},
          ),
        ),
      );

      await tester.tap(find.text('通知接收區域'));
      await tester.pumpAndSettle();
      expect(find.textContaining('只會篩選已同步到本機的事件'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('notification-area-choose')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('administrative-area-search')),
        '永和區',
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('administrative-area-option-tw.65000040')),
      );
      await tester.tap(find.text('確認'));
      await tester.pumpAndSettle();
      expect(find.text('新北市 永和區'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('notification-area-save')));
      await tester.pumpAndSettle();
      expect(savedAreas, <String>{'tw.65000040'});
    },
  );

  testWidgets(
    'profile logs in with a non-email account and opens the workbench',
    (tester) async {
      final api = _FakeGovernmentApi();
      final auth = GovernmentAuthController(api: api, androidDeviceMode: false);
      await tester.pumpWidget(
        MaterialApp(
          home: ProfileScreen(
            themeMode: ThemeMode.system,
            animationEnabled: true,
            governmentAuth: auth,
            onThemeModeChanged: (_) {},
            onAnimationChanged: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('政府人員登入'), findsOneWidget);
      expect(find.text('啟用邀請'), findsNothing);
      expect(find.textContaining('由系統管理者建立帳號'), findsOneWidget);
      await tester.tap(find.text('登入'));
      await tester.pumpAndSettle();
      expect(find.text('帳號'), findsOneWidget);
      await tester.enterText(find.byType(TextField).at(0), 'staff-01');
      await tester.enterText(find.byType(TextField).at(1), 'wrong-password');
      await tester.tap(find.widgetWithText(FilledButton, '登入').last);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('帳號或密碼錯誤'),
        ),
        findsOneWidget,
      );

      await tester.enterText(find.byType(TextField).at(1), 'correct-password');
      await tester.tap(find.widgetWithText(FilledButton, '登入').last);
      await tester.pumpAndSettle();
      expect(api.lastAccount, 'staff-01');
      expect(find.text('值班人員'), findsOneWidget);
      expect(find.text('開啟政府工作台'), findsOneWidget);

      await tester.ensureVisible(find.text('登出'));
      await tester.tap(find.text('登出'));
      await tester.pumpAndSettle();
      expect(find.text('政府人員登入'), findsOneWidget);
      auth.dispose();
    },
  );

  test('not_found explains the government API path problem', () {
    expect(
      const GovernmentApiException('not_found', 404).message,
      contains('政府工作台服務目前無法連線'),
    );
  });

  test('Android debug defaults to the government API host port', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);

    expect(
      await governmentApiDefaultBaseUri(),
      Uri.parse('http://10.0.2.2:8788/api/v1/'),
    );
  });

  testWidgets('system administrator creates a government account directly', (
    tester,
  ) async {
    final api = _FakeGovernmentApi();
    final auth = GovernmentAuthController(api: api, androidDeviceMode: false);
    await auth.login('admin-01', 'correct-password');
    await tester.pumpWidget(
      MaterialApp(
        home: ProfileScreen(
          themeMode: ThemeMode.system,
          animationEnabled: true,
          governmentAuth: auth,
          governmentAreaDirectory: _profileAreaDirectory,
          governmentAreaIndex: _profileAreaIndex,
          onThemeModeChanged: (_) {},
          onAnimationChanged: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('開啟政府工作台'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('帳號管理'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新增政府人員'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'reviewer-01');
    await tester.enterText(find.byType(TextField).at(1), '查證人員');
    await tester.enterText(find.byType(TextField).at(3), 'x-strong-passphrase');
    await tester.enterText(find.byType(TextField).at(4), 'x-strong-passphrase');
    await tester.tap(find.widgetWithText(FilledButton, '建立帳號'));
    await tester.pumpAndSettle();

    expect(api.createdUser?.account, 'reviewer-01');
    expect(api.createdUser?.displayName, '查證人員');
    expect(find.text('已建立帳號：reviewer-01'), findsOneWidget);
    auth.dispose();
  });
}
