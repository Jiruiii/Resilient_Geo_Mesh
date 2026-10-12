import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/screens/profile_screen.dart';

class _FakeGovernmentApi extends GovernmentApiClient {
  GovernmentUser? current;
  String? lastAccount;
  GovernmentUser? createdUser;

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

void main() {
  testWidgets('profile keeps preferences without a basemap picker', (
    tester,
  ) async {
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
    expect(find.byType(DropdownButtonFormField<ThemeMode>), findsOneWidget);
  });

  testWidgets(
    'profile logs in with a non-email account and opens the workbench',
    (tester) async {
      final api = _FakeGovernmentApi();
      final auth = GovernmentAuthController(api: api);
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
    final auth = GovernmentAuthController(api: api);
    await auth.login('admin-01', 'correct-password');
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
