import 'package:flutter/material.dart';

import '../data/government_announcement_time.dart';
import '../data/government_api.dart';
import '../data/map_bridge.dart';
import '../data/taiwan_administrative_area_directory.dart';
import '../data/taiwan_administrative_area_index.dart';
import 'notification_area_selection_screen.dart';
import 'sync_status_screen.dart';
import 'government_sync_screen.dart';
import 'government_workbench_screen.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({
    super.key,
    required this.themeMode,
    required this.animationEnabled,
    required this.onThemeModeChanged,
    required this.onAnimationChanged,
    this.bridge,
    this.governmentAuth,
    this.onWebGovernmentFeedRefresh,
    this.notificationAreaDirectory,
    this.notificationAreaIds = const <String>{
      TaiwanAdministrativeAreaDirectory.nationalAreaId,
    },
    this.onNotificationAreaIdsChanged,
    this.governmentAreaDirectory,
    this.governmentAreaIndex,
  }) : assert(
         (governmentAreaDirectory == null) == (governmentAreaIndex == null),
       );

  final ThemeMode themeMode;
  final bool animationEnabled;
  final ValueChanged<ThemeMode> onThemeModeChanged;
  final ValueChanged<bool> onAnimationChanged;
  final MapBridge? bridge;
  final GovernmentAuthController? governmentAuth;
  final Future<void> Function()? onWebGovernmentFeedRefresh;
  final TaiwanAdministrativeAreaDirectory? notificationAreaDirectory;
  final Set<String> notificationAreaIds;
  final Future<void> Function(Set<String> areaIds)?
  onNotificationAreaIdsChanged;
  final TaiwanAdministrativeAreaDirectory? governmentAreaDirectory;
  final TaiwanAdministrativeAreaIndex? governmentAreaIndex;

  Future<void> _openNotificationAreaSettings(BuildContext context) async {
    final directory = notificationAreaDirectory;
    final onSave = onNotificationAreaIdsChanged;
    if (directory == null || onSave == null) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => NotificationAreaSelectionScreen(
              directory: directory,
              selectedAreaIds: notificationAreaIds,
              onSave: onSave,
            ),
      ),
    );
  }

  String _notificationAreaSummary() {
    final directory = notificationAreaDirectory;
    if (directory == null) return '全台灣 · 行政區目錄載入中';
    final names = notificationAreaIds
        .map(directory.displayName)
        .whereType<String>()
        .toList(growable: false);
    return names.isEmpty ? '全台灣' : names.join('、');
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        '個人設定',
        style: Theme.of(
          context,
        ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
      ),
    ),
    body: ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
      children: <Widget>[
        GovernmentAccountSection(
          controller: governmentAuth,
          areaDirectory: governmentAreaDirectory,
          areaIndex: governmentAreaIndex,
        ),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            leading: const Icon(Icons.cloud_download_outlined),
            title: const Text('政府資料更新'),
            titleTextStyle: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            subtitle: const Text('取得最新警報與道路、收容所狀態'),
            trailing: const Icon(Icons.chevron_right),
            onTap:
                () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder:
                        (_) => GovernmentSyncScreen(
                          bridge: bridge ?? MapBridge(),
                          onWebAreaChanged: onWebGovernmentFeedRefresh,
                        ),
                  ),
                ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            leading: const Icon(Icons.sync),
            title: const Text('同步狀態'),
            titleTextStyle: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            subtitle: const Text('查看緊急模式、附近節點與同步結果'),
            trailing: const Icon(Icons.chevron_right),
            onTap:
                () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder:
                        (_) => SyncStatusScreen(bridge: bridge ?? MapBridge()),
                  ),
                ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            leading: const Icon(Icons.notifications_active_outlined),
            title: const Text('通知接收區域'),
            titleTextStyle: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            subtitle: Text(_notificationAreaSummary()),
            trailing: const Icon(Icons.chevron_right),
            onTap:
                notificationAreaDirectory == null ||
                        onNotificationAreaIdsChanged == null
                    ? null
                    : () => _openNotificationAreaSettings(context),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '偏好設定',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: '繁體中文',
                  decoration: const InputDecoration(labelText: '語言'),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: '繁體中文', child: Text('繁體中文')),
                    DropdownMenuItem(value: 'English', child: Text('English')),
                  ],
                  onChanged: (_) {},
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<ThemeMode>(
                  value: themeMode,
                  decoration: const InputDecoration(labelText: '畫面主題'),
                  items: const <DropdownMenuItem<ThemeMode>>[
                    DropdownMenuItem(
                      value: ThemeMode.system,
                      child: Text('跟隨系統'),
                    ),
                    DropdownMenuItem(value: ThemeMode.light, child: Text('淺色')),
                    DropdownMenuItem(value: ThemeMode.dark, child: Text('深色')),
                  ],
                  onChanged: (value) {
                    if (value != null) onThemeModeChanged(value);
                  },
                ),
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('事件動畫'),
                  subtitle: const Text('新事件以短暫脈動提醒'),
                  value: animationEnabled,
                  onChanged: onAnimationChanged,
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

class GovernmentAccountSection extends StatefulWidget {
  const GovernmentAccountSection({
    super.key,
    this.controller,
    this.areaDirectory,
    this.areaIndex,
  }) : assert((areaDirectory == null) == (areaIndex == null));

  final GovernmentAuthController? controller;
  final TaiwanAdministrativeAreaDirectory? areaDirectory;
  final TaiwanAdministrativeAreaIndex? areaIndex;

  @override
  State<GovernmentAccountSection> createState() =>
      _GovernmentAccountSectionState();
}

class _GovernmentAccountSectionState extends State<GovernmentAccountSection> {
  late final GovernmentAuthController _auth;
  late final bool _ownsController;
  final _loginAccount = TextEditingController();
  final _loginPassword = TextEditingController();

  @override
  void initState() {
    super.initState();
    _ownsController = widget.controller == null;
    _auth = widget.controller ?? GovernmentAuthController();
    _auth.restore();
  }

  @override
  void dispose() {
    if (_ownsController) _auth.dispose();
    _loginAccount.dispose();
    _loginPassword.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _auth,
    builder: (context, _) {
      if (_auth.loading) {
        return Card(
          child: ListTile(
            leading: const Icon(Icons.badge_outlined),
            title: const Text('政府人員帳號'),
            titleTextStyle: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            subtitle: const Text('正在確認登入狀態…'),
          ),
        );
      }
      final user = _auth.user;
      if (user == null) {
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '政府人員登入',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                const Text('由系統管理者建立帳號，完成身分核實的政府人員可使用。'),
                if (_auth.error != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Text(
                    _errorText(_auth.error!),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  children: <Widget>[
                    FilledButton.icon(
                      onPressed: _auth.busy ? null : _showLogin,
                      icon: const Icon(Icons.login),
                      label: const Text('登入'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      }
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Icon(
                    Icons.verified_user_outlined,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          user.displayName,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.bold),
                        ),
                        Text(
                          '${user.agency} · ${user.role == 'SYSTEM_ADMIN' ? '系統管理者' : '政府人員'}',
                        ),
                      ],
                    ),
                  ),
                  Chip(
                    label: Text(
                      _auth.restoredOffline
                          ? '離線工作台'
                          : user.status == 'ACTIVE'
                          ? '已登入'
                          : '已停用',
                    ),
                  ),
                ],
              ),
              if (_auth.deviceAuthorization?['certificate_expires_at']
                  is String)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    '手機憑證有效期限：${_formatCertificateExpiry(_auth.deviceAuthorization!['certificate_expires_at'] as String)}',
                  ),
                ),
              if (_auth.restoredOffline && _auth.lastRevocationSyncAt != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('撤銷資訊最近同步：${_auth.lastRevocationSyncAt}'),
                ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: <Widget>[
                  FilledButton.icon(
                    onPressed:
                        () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder:
                                (_) => GovernmentWorkbenchScreen(
                                  auth: _auth,
                                  areaDirectory: widget.areaDirectory,
                                  areaIndex: widget.areaIndex,
                                ),
                          ),
                        ),
                    icon: const Icon(Icons.dashboard_outlined),
                    label: const Text('開啟政府工作台'),
                  ),
                  OutlinedButton.icon(
                    onPressed: _auth.busy ? null : _auth.logout,
                    icon: const Icon(Icons.logout),
                    label: const Text('登出'),
                  ),
                ],
              ),
              if (_auth.error != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  _errorText(_auth.error!),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );

  Future<void> _showLogin() async {
    final account = _loginAccount;
    final password = _loginPassword;
    var busy = false;
    String? error;
    Future<void> submit(
      BuildContext dialogContext,
      StateSetter setDialogState,
    ) async {
      setDialogState(() {
        busy = true;
        error = null;
      });
      final success = await _auth.login(account.text.trim(), password.text);
      if (!mounted || !dialogContext.mounted) return;
      if (success) {
        Navigator.pop(dialogContext);
      } else {
        setDialogState(() {
          busy = false;
          error = _errorText(_auth.error ?? '登入失敗');
        });
      }
    }

    await showDialog<void>(
      context: context,
      builder:
          (dialogContext) => StatefulBuilder(
            builder:
                (context, setDialogState) => AlertDialog(
                  title: const Text('政府人員登入'),
                  content: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      TextField(
                        controller: account,
                        decoration: const InputDecoration(labelText: '帳號'),
                      ),
                      TextField(
                        controller: password,
                        obscureText: true,
                        decoration: const InputDecoration(labelText: '密碼'),
                        onSubmitted:
                            (_) => submit(dialogContext, setDialogState),
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            error!,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                    ],
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed:
                          busy ? null : () => Navigator.pop(dialogContext),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      onPressed:
                          busy
                              ? null
                              : () => submit(dialogContext, setDialogState),
                      child: Text(busy ? '登入中…' : '登入'),
                    ),
                  ],
                ),
          ),
    );
    account.clear();
    password.clear();
  }

  String _errorText(Object error) =>
      error is GovernmentApiException ? error.message : '登入服務暫時無法使用';

  String _formatCertificateExpiry(String value) {
    final expiry = DateTime.tryParse(value);
    return expiry == null
        ? value
        : GovernmentAnnouncementTime.formatTaiwan(expiry.toUtc());
  }
}
