import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'government_http.dart';
import 'government_session_store.dart';
import 'map_bridge.dart';

class GovernmentApiException implements Exception {
  const GovernmentApiException(this.code, this.statusCode);

  final String code;
  final int statusCode;

  String get message => switch (code) {
    'credentials_invalid' => '帳號或密碼錯誤',
    'session_invalid' => '登入狀態已失效，請重新登入',
    'not_found' => '政府工作台服務目前無法連線，請確認伺服器已提供 /api/v1/ 服務',
    'api_url_not_configured' => '尚未設定政府工作台 API 網址',
    'account_exists' => '此帳號已存在，請使用其他帳號名稱',
    'invalid_account' => '請輸入有效帳號（最多 120 個字元）',
    'invalid_display_name' => '請輸入姓名（最多 120 個字元）',
    'invalid_agency' => '請輸入服務機關（最多 120 個字元）',
    'invalid_password' => '密碼至少需要 12 個字元',
    'role_forbidden' => '此帳號沒有執行這項操作的權限',
    'csrf_invalid' => '安全驗證已更新，請重新操作',
    'crowd_report_expired' => '回報已超過有效期限，無法上傳或查證',
    'payload_hash_mismatch' => '回報內容已變更，請重新整理後再查證',
    'announcement_retracted' => '公告已撤回，無法再修改',
    _ when statusCode >= 500 => '服務暫時無法使用，請稍後重試',
    _ => '操作失敗（$code）',
  };

  @override
  String toString() => message;
}

class GovernmentUser {
  const GovernmentUser({
    required this.id,
    required this.account,
    required this.displayName,
    required this.agency,
    required this.role,
    required this.status,
  });

  final String id;
  final String account;
  final String displayName;
  final String agency;
  final String role;
  final String status;

  bool get isSystemAdmin => role == 'SYSTEM_ADMIN';

  factory GovernmentUser.fromJson(Map<String, dynamic> json) => GovernmentUser(
    id: json['id'] as String? ?? '',
    account: json['account'] as String? ?? '',
    displayName: json['display_name'] as String? ?? '',
    agency: json['agency'] as String? ?? '',
    role: json['role'] as String? ?? '',
    status: json['status'] as String? ?? '',
  );
}

typedef GovernmentApiBaseUri = Future<Uri> Function();

class GovernmentApiClient {
  GovernmentApiClient({
    GovernmentApiBaseUri? baseUri,
    GovernmentSessionStore? sessionStore,
  }) : _baseUri = baseUri ?? governmentApiDefaultBaseUri,
       _sessionStore = sessionStore ?? createGovernmentSessionStore();

  final GovernmentApiBaseUri _baseUri;
  final GovernmentSessionStore _sessionStore;
  String? _token;
  String? _csrfToken;

  Future<String?> _readToken() async => _token ??= await _sessionStore.read();

  Future<Uri> _uri(String path) async {
    var base = await _baseUri();
    if (!base.path.endsWith('/')) base = base.replace(path: '${base.path}/');
    return base.resolve(path.replaceFirst(RegExp(r'^/'), ''));
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    bool authenticated = true,
  }) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      final token = await _readToken();
      if (token != null) headers['Authorization'] = 'Bearer $token';
      if (_csrfToken != null) headers['X-CSRF-Token'] = _csrfToken!;
    }
    final response = await sendGovernmentHttp(
      method: method,
      uri: await _uri(path),
      headers: headers,
      body: body == null ? null : jsonEncode(body),
    );
    if (response.statusCode == 204 || response.body.isEmpty) {
      return <String, dynamic>{};
    }
    Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      decoded = null;
    }
    final data =
        decoded is Map
            ? Map<String, dynamic>.from(decoded)
            : <String, dynamic>{};
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final code =
          data['error'] is String ? data['error'] as String : 'request_failed';
      if (response.statusCode == 401) await _clearSession();
      throw GovernmentApiException(code, response.statusCode);
    }
    return data;
  }

  Future<void> _clearSession() async {
    _token = null;
    _csrfToken = null;
    await _sessionStore.clear();
  }

  Future<GovernmentUser?> currentUser() async {
    try {
      final result = await _send('GET', 'auth/me');
      final user = result['user'];
      _csrfToken = result['csrf_token'] as String? ?? _csrfToken;
      return user is Map
          ? GovernmentUser.fromJson(Map<String, dynamic>.from(user))
          : null;
    } on GovernmentApiException catch (error) {
      if (error.statusCode == 401) return null;
      rethrow;
    }
  }

  Future<GovernmentUser> login(String account, String password) async {
    final result = await _send(
      'POST',
      'auth/sessions',
      authenticated: false,
      body: <String, Object?>{'account': account, 'password': password},
    );
    _csrfToken = result['csrf_token'] as String?;
    final token = result['access_token'] as String?;
    if (token != null) {
      _token = token;
      await _sessionStore.write(token);
    }
    final user = result['user'];
    if (user is! Map) {
      throw const GovernmentApiException('invalid_response', 502);
    }
    return GovernmentUser.fromJson(Map<String, dynamic>.from(user));
  }

  Future<void> logout() async {
    try {
      await _send('DELETE', 'auth/sessions/current');
    } finally {
      await _clearSession();
    }
  }

  Future<GovernmentUser> createGovernmentUser({
    required String account,
    required String displayName,
    required String agency,
    required String password,
  }) async {
    final result = await _send(
      'POST',
      'government/users',
      body: <String, Object?>{
        'account': account,
        'display_name': displayName,
        'agency': agency,
        'password': password,
      },
    );
    final user = result['user'];
    if (user is! Map) {
      throw const GovernmentApiException('invalid_response', 502);
    }
    return GovernmentUser.fromJson(Map<String, dynamic>.from(user));
  }

  Future<List<Map<String, dynamic>>> listUsers() async =>
      ((await _send('GET', 'government/users'))['users'] as List? ??
              const <Object>[])
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList(growable: false);

  Future<void> setUserStatus(String id, String status) async => _send(
    'PATCH',
    'government/users/${Uri.encodeComponent(id)}',
    body: <String, Object?>{'status': status},
  );

  Future<List<Map<String, dynamic>>> listReports({
    String status = 'PENDING',
  }) async =>
      ((await _send('GET', 'government/reports?status=$status'))['reports']
                  as List? ??
              const <Object>[])
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList(growable: false);

  Future<Map<String, dynamic>> attestReport({
    required String eventId,
    required String payloadHash,
    required String verdict,
    String? note,
  }) => _send(
    'POST',
    'government/reports/${Uri.encodeComponent(eventId)}/attestations',
    body: <String, Object?>{
      'payload_hash': payloadHash,
      'verdict': verdict,
      if (note != null && note.isNotEmpty) 'note': note,
    },
  );

  Future<List<Map<String, dynamic>>> listAnnouncements() async =>
      ((await _send('GET', 'government/announcements'))['announcements']
                  as List? ??
              const <Object>[])
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList(growable: false);

  Future<Map<String, dynamic>> createAnnouncement(Map<String, Object?> input) =>
      _send('POST', 'government/announcements', body: input);

  Future<Map<String, dynamic>> reviseAnnouncement(
    String eventId,
    Map<String, Object?> input,
  ) => _send(
    'PUT',
    'government/announcements/${Uri.encodeComponent(eventId)}',
    body: input,
  );

  Future<Map<String, dynamic>> retractAnnouncement(String eventId) => _send(
    'DELETE',
    'government/announcements/${Uri.encodeComponent(eventId)}',
  );

  Future<Map<String, dynamic>> uploadCrowdReport(Map<String, dynamic> event) =>
      _send('POST', 'crowd-reports', body: event, authenticated: false);
}

Future<Uri> governmentApiDefaultBaseUri() async {
  if (kIsWeb) return Uri.base.resolve('/api/v1/');
  const configured = String.fromEnvironment('GOVERNMENT_API_BASE_URL');
  if (configured.isNotEmpty) {
    final uri = Uri.tryParse(configured);
    if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
      return uri;
    }
  }
  if (kDebugMode && defaultTargetPlatform == TargetPlatform.android) {
    return Uri.parse('http://10.0.2.2:8788/api/v1/');
  }
  try {
    final status = await MapBridge().getGovernmentSyncStatus();
    final feedUrl = status['url'];
    if (feedUrl is String && feedUrl.isNotEmpty) {
      return Uri.parse(feedUrl).resolve('/api/v1/');
    }
  } on Object {
    // A bridge-less host reports a configuration error below.
  }
  throw const GovernmentApiException('api_url_not_configured', 0);
}

class GovernmentAuthController extends ChangeNotifier {
  GovernmentAuthController({GovernmentApiClient? api})
    : api = api ?? GovernmentApiClient();

  final GovernmentApiClient api;
  GovernmentUser? user;
  bool loading = true;
  bool busy = false;
  Object? error;
  bool _restoreStarted = false;
  bool _disposed = false;

  void _notifyIfAlive() {
    if (!_disposed) notifyListeners();
  }

  Future<void> restore() async {
    if (_restoreStarted) return;
    _restoreStarted = true;
    loading = true;
    _notifyIfAlive();
    try {
      user = await api.currentUser();
      error = null;
    } on Object catch (value) {
      error = value;
    } finally {
      loading = false;
      _notifyIfAlive();
    }
  }

  Future<bool> login(String account, String password) async {
    busy = true;
    error = null;
    _notifyIfAlive();
    try {
      user = await api.login(account, password);
      return true;
    } on Object catch (value) {
      error = value;
      return false;
    } finally {
      busy = false;
      _notifyIfAlive();
    }
  }

  Future<void> logout() async {
    busy = true;
    error = null;
    _notifyIfAlive();
    try {
      await api.logout();
    } on Object catch (value) {
      error = value;
    } finally {
      user = null;
      busy = false;
      _notifyIfAlive();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
