import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/crowd_report_models.dart';
import '../data/government_announcement_time.dart';
import '../data/government_api.dart';
import '../data/government_warning_upload_queue.dart';
import '../data/map_models.dart';
import 'government_announcement_location_picker.dart';

class _AnnouncementTimeParts {
  const _AnnouncementTimeParts(this.hour, this.minute, this.second);

  final int hour;
  final int minute;
  final int second;
}

enum _AnnouncementSort {
  publishedNewest('發布日期（新到舊）'),
  publishedOldest('發布日期（舊到新）'),
  deadlineSoonest('截止日期（近到遠）'),
  deadlineLatest('截止日期（遠到近）');

  const _AnnouncementSort(this.label);

  final String label;
}

const Map<String, String> _announcementCategoryLabels = <String, String>{
  'SAFETY': '安全提醒',
  'WEATHER': '天氣',
  'ROAD': '道路',
  'SHELTER': '避難收容',
  'SUPPLY_STATION': '物資站',
  'OTHER': '其他',
};

const Set<String> _announcementCategoriesRequiringLocation = <String>{
  'ROAD',
  'SHELTER',
  'SUPPLY_STATION',
};

class GovernmentWorkbenchScreen extends StatefulWidget {
  const GovernmentWorkbenchScreen({super.key, required this.auth});

  final GovernmentAuthController auth;

  @override
  State<GovernmentWorkbenchScreen> createState() =>
      _GovernmentWorkbenchScreenState();
}

class _GovernmentWorkbenchScreenState extends State<GovernmentWorkbenchScreen>
    with WidgetsBindingObserver {
  final _attestationNote = TextEditingController();
  final _announcementTitle = TextEditingController();
  final _announcementContent = TextEditingController();
  final _newAccount = TextEditingController();
  final _newDisplayName = TextEditingController();
  final _newAgency = TextEditingController();
  final _newPassword = TextEditingController();
  final _newPasswordConfirmation = TextEditingController();
  List<Map<String, dynamic>> _reports = const <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _announcements = const <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _users = const <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _deviceWarnings = const <Map<String, dynamic>>[];
  bool? _emergencyModeEnabled;
  bool _loading = true;
  bool _busy = false;
  bool _warningUploadActive = false;
  Object? _error;
  Timer? _automaticWarningUploadTimer;
  Timer? _announcementExpiryTimer;
  final Set<String> _hiddenAnnouncementKeys = <String>{};
  final Set<String> _expandedAnnouncementCategories = <String>{};
  _AnnouncementSort _announcementSort = _AnnouncementSort.publishedNewest;
  bool _hiddenAnnouncementsLoaded = false;

  static const String _hiddenAnnouncementsPreferencePrefix =
      'government.workbench.hidden_announcements.v1.';

  bool get _isAdmin => widget.auth.user?.isSystemAdmin == true;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _automaticWarningUploadTimer?.cancel();
    _announcementExpiryTimer?.cancel();
    _attestationNote.dispose();
    _announcementTitle.dispose();
    _announcementContent.dispose();
    _newAccount.dispose();
    _newDisplayName.dispose();
    _newAgency.dispose();
    _newPassword.dispose();
    _newPasswordConfirmation.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    if (widget.auth.androidDeviceMode &&
        widget.auth.user?.role == 'GOVERNMENT') {
      _automaticWarningUploadTimer = Timer.periodic(
        const Duration(minutes: 5),
        (_) => unawaited(_retryPendingDeviceWarnings()),
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (mounted) setState(() {});
    _scheduleAnnouncementExpiryUpdate();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await _loadHiddenAnnouncements();
      if (widget.auth.androidDeviceMode &&
          widget.auth.user?.role == 'GOVERNMENT') {
        if (!widget.auth.restoredOffline) {
          try {
            await widget.auth.refreshDeviceAuthorization();
          } on Object {
            // Keep local signed alerts visible when device or network refresh fails.
          }
        }
        final localWarnings =
            await widget.auth.mapBridge.listGovernmentWarningStatuses();
        if (mounted) setState(() => _deviceWarnings = localWarnings);
        try {
          final localState = await widget.auth.mapBridge.getInitialState();
          if (mounted) {
            setState(
              () => _emergencyModeEnabled = localState.emergencyModeEnabled,
            );
          }
        } on Object {
          // Unknown mode is not reported as enabled or disabled.
        }
      }
      final values = await Future.wait<Object>(<Future<Object>>[
        widget.auth.api.listReports(),
        widget.auth.api.listAnnouncements(),
        if (_isAdmin) widget.auth.api.listUsers(),
      ]);
      if (!mounted) return;
      setState(() {
        _reports = values[0] as List<Map<String, dynamic>>;
        _announcements = (values[1] as List<Map<String, dynamic>>)
            .where((announcement) => announcement['retracted'] != true)
            .toList(growable: false);
        if (_isAdmin) _users = values[2] as List<Map<String, dynamic>>;
      });
      _scheduleAnnouncementExpiryUpdate();
      if (widget.auth.androidDeviceMode &&
          widget.auth.user?.role == 'GOVERNMENT') {
        unawaited(_retryPendingDeviceWarnings());
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tabs = <Tab>[
      const Tab(text: '待查回報'),
      const Tab(text: '官方公告'),
      if (_isAdmin) const Tab(text: '帳號管理'),
    ];
    final pages = <Widget>[
      _reportsPage(),
      _announcementsPage(),
      if (_isAdmin) _usersPage(),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('政府工作台'),
          actions: <Widget>[
            IconButton(
              tooltip: '重新整理',
              onPressed: _loading ? null : _refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
          bottom: TabBar(tabs: tabs),
        ),
        body: Column(
          children: <Widget>[
            if (_error != null)
              MaterialBanner(
                content: Text(_errorText(_error!)),
                actions: <Widget>[
                  TextButton(onPressed: _refresh, child: const Text('重試')),
                ],
              ),
            if (_loading) const LinearProgressIndicator(),
            Expanded(child: TabBarView(children: pages)),
          ],
        ),
      ),
    );
  }

  Widget _reportsPage() {
    if (!_loading && _reports.isEmpty) {
      return const Center(child: Text('目前沒有待查回報'));
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _reports.length,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, index) {
          final report = _reports[index];
          final event =
              report['event'] is Map
                  ? Map<String, dynamic>.from(report['event'] as Map)
                  : <String, dynamic>{};
          final attributes =
              event['attributes'] is Map
                  ? Map<String, dynamic>.from(event['attributes'] as Map)
                  : <String, dynamic>{};
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      const Icon(Icons.report_outlined),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          crowdCategoryLabel(attributes['category']),
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      const Chip(label: Text('未經查證')),
                    ],
                  ),
                  if (attributes['description'] is String &&
                      (attributes['description'] as String).isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(attributes['description'] as String),
                    ),
                  const SizedBox(height: 8),
                  SelectableText(
                    '事件：${report['event_id'] ?? event['event_id'] ?? '無資料'}',
                  ),
                  SelectableText('內容雜湊：${report['payload_hash'] ?? '無資料'}'),
                  Text(
                    '有效期限：${report['expires_at'] ?? event['expires_at'] ?? '無資料'}',
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    children: <Widget>[
                      FilledButton.icon(
                        onPressed:
                            _busy ? null : () => _decide(report, 'CONFIRMED'),
                        icon: const Icon(Icons.verified_outlined),
                        label: const Text('確認屬實'),
                      ),
                      OutlinedButton.icon(
                        onPressed:
                            _busy ? null : () => _decide(report, 'REFUTED'),
                        icon: const Icon(Icons.do_not_disturb_alt_outlined),
                        label: const Text('確認不實'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Future<void> _decide(Map<String, dynamic> report, String verdict) async {
    final noteController = _attestationNote..clear();
    final note = await showDialog<String?>(
      context: context,
      builder:
          (context) => AlertDialog(
            title: Text(verdict == 'CONFIRMED' ? '確認回報屬實' : '確認回報不實'),
            content: TextField(
              controller: noteController,
              maxLength: 160,
              maxLines: 3,
              decoration: const InputDecoration(labelText: '查證說明（選填）'),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed:
                    () => Navigator.pop(context, noteController.text.trim()),
                child: const Text('送出查證'),
              ),
            ],
          ),
    );
    noteController.clear();
    if (note == null) return;
    await _perform(() async {
      await widget.auth.api.attestReport(
        eventId: report['event_id'] as String,
        payloadHash: report['payload_hash'] as String,
        verdict: verdict,
        note: note,
      );
      await _refresh();
    });
  }

  Widget _announcementsPage() {
    final items = _visibleAnnouncements();
    final groups = _groupAnnouncements(items);
    return Column(
      children: <Widget>[
        if (widget.auth.androidDeviceMode &&
            widget.auth.user?.role == 'GOVERNMENT')
          _deviceWarningStatusPanel(),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Align(
            alignment: Alignment.centerRight,
            child: FilledButton.icon(
              onPressed: _busy ? null : () => _editAnnouncement(),
              icon: const Icon(Icons.add),
              label: const Text('新增公告'),
            ),
          ),
        ),
        if (items.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
            child: Align(
              alignment: Alignment.centerLeft,
              child: PopupMenuButton<_AnnouncementSort>(
                tooltip: '公告排序方式',
                initialValue: _announcementSort,
                onSelected: (sort) => setState(() => _announcementSort = sort),
                itemBuilder:
                    (context) => _AnnouncementSort.values
                        .map(
                          (sort) => PopupMenuItem<_AnnouncementSort>(
                            value: sort,
                            child: Text(sort.label),
                          ),
                        )
                        .toList(growable: false),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 8,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const Icon(Icons.sort),
                      const SizedBox(width: 4),
                      Text(_announcementSort.label),
                      const Icon(Icons.arrow_drop_down),
                    ],
                  ),
                ),
              ),
            ),
          ),
        Expanded(
          child:
              !_loading && items.isEmpty
                  ? Center(
                    child: Text(
                      _announcements.isEmpty ? '目前沒有公告' : '目前沒有可顯示的公告',
                    ),
                  )
                  : RefreshIndicator(
                    onRefresh: _refresh,
                    child: ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                      itemCount: groups.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 12),
                      itemBuilder: (context, index) {
                        final entry = groups.entries.elementAt(index);
                        final expanded = _expandedAnnouncementCategories
                            .contains(entry.key);
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            Card(
                              child: ListTile(
                                title: Text(
                                  '${_announcementCategoryLabel(entry.key)}（${entry.value.length}）',
                                ),
                                trailing: Icon(
                                  expanded
                                      ? Icons.expand_less
                                      : Icons.expand_more,
                                ),
                                onTap:
                                    () => setState(() {
                                      if (expanded) {
                                        _expandedAnnouncementCategories.remove(
                                          entry.key,
                                        );
                                      } else {
                                        _expandedAnnouncementCategories.add(
                                          entry.key,
                                        );
                                      }
                                    }),
                              ),
                            ),
                            if (expanded) ...<Widget>[
                              for (final item in entry.value) ...<Widget>[
                                const SizedBox(height: 8),
                                _announcementCard(item),
                              ],
                            ],
                          ],
                        );
                      },
                    ),
                  ),
        ),
      ],
    );
  }

  String get _hiddenAnnouncementsPreferenceKey {
    final accountId = widget.auth.user?.id ?? 'unknown';
    return '$_hiddenAnnouncementsPreferencePrefix${Uri.encodeComponent(accountId)}';
  }

  String _announcementIdentity(Map<String, dynamic> item) =>
      '${item['event_id'] ?? ''}:${item['event_version'] ?? 1}';

  Future<void> _loadHiddenAnnouncements() async {
    if (_hiddenAnnouncementsLoaded) return;
    final preferences = await SharedPreferences.getInstance();
    _hiddenAnnouncementKeys
      ..clear()
      ..addAll(
        preferences.getStringList(_hiddenAnnouncementsPreferenceKey) ??
            const <String>[],
      );
    _hiddenAnnouncementsLoaded = true;
  }

  Future<void> _saveHiddenAnnouncements(Set<String> keys) async {
    final preferences = await SharedPreferences.getInstance();
    final sortedKeys = keys.toList()..sort();
    await preferences.setStringList(
      _hiddenAnnouncementsPreferenceKey,
      sortedKeys,
    );
  }

  List<Map<String, dynamic>> _visibleAnnouncements() {
    final items =
        _announcements
            .where(
              (item) =>
                  !_hiddenAnnouncementKeys.contains(
                    _announcementIdentity(item),
                  ),
            )
            .toList();
    items.sort(_compareAnnouncements);
    return items;
  }

  Map<String, List<Map<String, dynamic>>> _groupAnnouncements(
    List<Map<String, dynamic>> items,
  ) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final item in items) {
      final category = item['category'] as String? ?? 'OTHER';
      groups.putIfAbsent(category, () => <Map<String, dynamic>>[]).add(item);
    }
    return groups;
  }

  int _compareAnnouncements(
    Map<String, dynamic> first,
    Map<String, dynamic> second,
  ) {
    final firstPublished = _announcementPublishedDate(first);
    final secondPublished = _announcementPublishedDate(second);
    final firstDeadline = _announcementDate(first['expires_at']);
    final secondDeadline = _announcementDate(second['expires_at']);
    final (firstDate, secondDate, newestFirst) = switch (_announcementSort) {
      _AnnouncementSort.publishedNewest => (
        firstPublished,
        secondPublished,
        true,
      ),
      _AnnouncementSort.publishedOldest => (
        firstPublished,
        secondPublished,
        false,
      ),
      _AnnouncementSort.deadlineSoonest => (
        firstDeadline,
        secondDeadline,
        false,
      ),
      _AnnouncementSort.deadlineLatest => (firstDeadline, secondDeadline, true),
    };
    final firstValue = firstDate?.millisecondsSinceEpoch ?? -1;
    final secondValue = secondDate?.millisecondsSinceEpoch ?? -1;
    final dateOrder =
        newestFirst
            ? secondValue.compareTo(firstValue)
            : firstValue.compareTo(secondValue);
    if (dateOrder != 0) return dateOrder;
    return (first['event_id'] as String? ?? '').compareTo(
      second['event_id'] as String? ?? '',
    );
  }

  DateTime? _announcementDate(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toUtc() : null;

  DateTime? _announcementPublishedDate(Map<String, dynamic> item) =>
      _announcementDate(item['updated_at']) ??
      _announcementDate(item['created_at']) ??
      _announcementDate(item['issued_at']);

  String _announcementDateLabel(Object? value) {
    final date = _announcementDate(value);
    return date == null ? '未提供' : GovernmentAnnouncementTime.formatTaiwan(date);
  }

  String _announcementPublishedDateLabel(Map<String, dynamic> item) {
    final date = _announcementPublishedDate(item);
    return date == null ? '未提供' : GovernmentAnnouncementTime.formatTaiwan(date);
  }

  bool _isAnnouncementExpired(Map<String, dynamic> item) {
    final expiry = _announcementDate(item['expires_at']);
    return expiry != null && !expiry.isAfter(DateTime.now().toUtc());
  }

  String _announcementCategoryLabel(String category) =>
      _announcementCategoryLabels[category] ?? '其他';

  void _scheduleAnnouncementExpiryUpdate() {
    _announcementExpiryTimer?.cancel();
    final now = DateTime.now().toUtc();
    final futureDeadlines =
        _announcements
            .map((item) => _announcementDate(item['expires_at']))
            .whereType<DateTime>()
            .where((deadline) => deadline.isAfter(now))
            .toList();
    if (futureDeadlines.isEmpty) return;
    futureDeadlines.sort();
    _announcementExpiryTimer = Timer(futureDeadlines.first.difference(now), () {
      if (!mounted) return;
      setState(() {});
      _scheduleAnnouncementExpiryUpdate();
    });
  }

  Widget _announcementCard(Map<String, dynamic> item) {
    final expired = _isAnnouncementExpired(item);
    final muted = expired ? Colors.grey.shade700 : null;
    final area =
        item['area_id'] == 'tw.national'
            ? '全台灣'
            : item['area_id'] as String? ?? '未指定範圍';
    return Card(
      color: expired ? Colors.grey.shade200 : null,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Text(
                    '${item['title'] as String? ?? '未命名公告'}${expired ? ' · 已過期' : ''}',
                    style: Theme.of(
                      context,
                    ).textTheme.titleMedium?.copyWith(color: muted),
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: '公告操作',
                  iconColor: muted,
                  onSelected: (value) {
                    if (value == 'edit') unawaited(_editAnnouncement(item));
                    if (value == 'retract') unawaited(_retract(item));
                    if (value == 'hide') {
                      unawaited(_confirmHideExpiredAnnouncement(item));
                    }
                  },
                  itemBuilder:
                      (_) => <PopupMenuEntry<String>>[
                        const PopupMenuItem<String>(
                          value: 'edit',
                          child: Text('修訂'),
                        ),
                        const PopupMenuItem<String>(
                          value: 'retract',
                          child: Text('撤回並隱藏'),
                        ),
                        if (expired)
                          const PopupMenuItem<String>(
                            value: 'hide',
                            child: Text('從此工作台刪除'),
                          ),
                      ],
                ),
              ],
            ),
            Text(
              '$area · 版本 ${item['event_version'] ?? 1}',
              style: TextStyle(color: muted),
            ),
            const SizedBox(height: 4),
            Text(
              '發布日期：${_announcementPublishedDateLabel(item)}',
              style: TextStyle(color: muted),
            ),
            Text(
              '截止日期：${_announcementDateLabel(item['expires_at'])}',
              style: TextStyle(color: muted),
            ),
            const SizedBox(height: 8),
            Text(
              item['content'] as String? ?? '',
              style: TextStyle(color: muted),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmHideExpiredAnnouncement(
    Map<String, dynamic> item,
  ) async {
    if (!_isAnnouncementExpired(item)) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder:
          (dialogContext) => AlertDialog(
            title: const Text('從此工作台刪除公告？'),
            content: const Text('公告只會從目前帳號在這個瀏覽器或裝置的工作台隱藏，不會撤回官方公告。'),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: const Text('刪除'),
              ),
            ],
          ),
    );
    if (confirmed != true || !mounted) return;
    final key = _announcementIdentity(item);
    final next = Set<String>.of(_hiddenAnnouncementKeys)..add(key);
    await _saveHiddenAnnouncements(next);
    if (!mounted) return;
    setState(() {
      _hiddenAnnouncementKeys
        ..clear()
        ..addAll(next);
    });
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: const Text('公告已從此工作台隱藏'),
          action: SnackBarAction(
            label: '復原',
            onPressed: () => unawaited(_restoreHiddenAnnouncement(key)),
          ),
        ),
      );
  }

  Future<void> _restoreHiddenAnnouncement(String key) async {
    final next = Set<String>.of(_hiddenAnnouncementKeys)..remove(key);
    await _saveHiddenAnnouncements(next);
    if (!mounted) return;
    setState(() {
      _hiddenAnnouncementKeys
        ..clear()
        ..addAll(next);
    });
  }

  Widget _deviceWarningStatusPanel() {
    final authorization =
        widget.auth.deviceAuthorization ??
        const <String, dynamic>{'status': 'NOT_ENROLLED'};
    final status = authorization['status'] as String? ?? 'NOT_ENROLLED';
    final expiresAt = DateTime.tryParse(
      authorization['certificate_expires_at'] as String? ?? '',
    );
    final canSync = !_busy && !widget.auth.restoredOffline;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('手機官方警告狀態', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(switch (status) {
              'AUTHORIZED' => '手機簽章憑證有效',
              'PENDING_CERTIFICATE' || 'ENROLLMENT_PENDING' => '等待中央核發手機憑證',
              'REVOKED' => '手機憑證已撤銷',
              'CERTIFICATE_EXPIRED_OR_INVALID' => '手機憑證已過期或無效',
              _ => '手機尚未完成官方簽章授權',
            }),
            if (expiresAt != null)
              Text(
                '憑證有效至：${GovernmentAnnouncementTime.formatTaiwan(expiresAt.toUtc())}',
              ),
            Text(
              widget.auth.restoredOffline
                  ? '目前使用離線帳號狀態'
                  : '撤銷資訊最近同步：${widget.auth.lastRevocationSyncAt ?? '尚無同步紀錄'}',
            ),
            if (widget.auth.restoredOffline)
              const Text('目前離線；已簽署警告會保留並等待 mesh 或雲端同步。'),
            if (_deviceWarnings.isNotEmpty) ...<Widget>[
              const Divider(height: 16),
              ..._deviceWarnings.map(_deviceWarningStatusRow),
            ],
            if (_emergencyModeEnabled == false &&
                _deviceWarnings.any(
                  (row) => row['upload_status'] != 'EXPIRED',
                )) ...<Widget>[
              const SizedBox(height: 8),
              const Text('緊急模式未開啟；公告已保存在本機，Mesh 尚未啟動。'),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: _busy ? null : _enableEmergencyMode,
                  icon: const Icon(Icons.wifi_tethering),
                  label: const Text('啟用緊急模式以進行 Mesh 傳播'),
                ),
              ),
            ],
            if (_deviceWarnings.any((row) => row['upload_status'] == 'PENDING'))
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: canSync ? _syncPendingDeviceWarnings : null,
                  icon: const Icon(Icons.cloud_upload_outlined),
                  label: const Text('補傳待上傳警告'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _deviceWarningStatusRow(Map<String, dynamic> row) {
    final event = _eventFromUploadRow(row);
    final attributes =
        event['attributes'] is Map
            ? Map<String, dynamic>.from(event['attributes'] as Map)
            : const <String, dynamic>{};
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            attributes['title'] as String? ??
                row['event_id'] as String? ??
                '官方警告',
          ),
          Wrap(
            spacing: 6,
            children: <Widget>[
              Chip(
                label: Text(
                  governmentWarningCloudStatusLabel(row['upload_status']),
                ),
              ),
              if (row['upload_status'] != 'EXPIRED')
                Chip(
                  label: Text(switch (_emergencyModeEnabled) {
                    true => '待 Mesh 同步',
                    false => 'Mesh 未啟用',
                    null => 'Mesh 狀態未知',
                  }),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Map<String, dynamic> _eventFromUploadRow(Map<String, dynamic> row) {
    final raw = row['event_json'];
    try {
      final event = raw is String ? jsonDecode(raw) : raw;
      return event is Map
          ? Map<String, dynamic>.from(event)
          : const <String, dynamic>{};
    } on Object {
      return const <String, dynamic>{};
    }
  }

  Future<void> _syncPendingDeviceWarnings() async {
    await _perform(() async {
      final bridge = widget.auth.mapBridge;
      final result = await _warningUploadQueue().flush();
      final statuses = await bridge.listGovernmentWarningStatuses();
      if (mounted) setState(() => _deviceWarnings = statuses);
      if (mounted && result.uploaded > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已補傳 ${result.uploaded} 則警告，等待官方 feed 發布。')),
        );
      }
    });
  }

  GovernmentWarningUploadQueue _warningUploadQueue() {
    final bridge = widget.auth.mapBridge;
    return GovernmentWarningUploadQueue(
      pending: bridge.listPendingGovernmentWarningUploads,
      upload: widget.auth.api.uploadGovernmentWarning,
      acknowledge:
          (eventId, payloadHash) => bridge.markGovernmentWarningUploaded(
            eventId: eventId,
            payloadHash: payloadHash,
          ),
      expire:
          (eventId, payloadHash) => bridge.markGovernmentWarningExpired(
            eventId: eventId,
            payloadHash: payloadHash,
          ),
    );
  }

  Future<void> _retryPendingDeviceWarnings() async {
    if (!mounted || _warningUploadActive) return;
    _warningUploadActive = true;
    try {
      await _warningUploadQueue().flush();
      final statuses =
          await widget.auth.mapBridge.listGovernmentWarningStatuses();
      if (mounted) setState(() => _deviceWarnings = statuses);
    } on Object {
      // Keep the Room outbox and retry on the next online refresh/interval.
    } finally {
      _warningUploadActive = false;
    }
  }

  Future<void> _enableEmergencyMode() => _perform(() async {
    final enabled = await widget.auth.mapBridge.setEmergencyMode(enabled: true);
    if (mounted) setState(() => _emergencyModeEnabled = enabled);
  });

  Future<void> _editAnnouncement([Map<String, dynamic>? existing]) async {
    final title =
        _announcementTitle..text = existing?['title'] as String? ?? '';
    final content =
        _announcementContent..text = existing?['content'] as String? ?? '';
    var expiry = _existingExpiry(existing?['expires_at']);
    var location = _existingLocation(existing?['location']);
    var category = existing?['category'] as String? ?? 'SAFETY';
    var severity =
        category == 'SUPPLY_STATION'
            ? 'LOW'
            : existing?['severity'] as String? ?? 'MEDIUM';
    String? titleError;
    String? contentError;
    final accepted = await showDialog<bool>(
      context: context,
      builder:
          (dialogContext) => StatefulBuilder(
            builder: (context, setDialogState) {
              Future<void> pickExpiry() async {
                final selected = await _pickAnnouncementExpiry(context, expiry);
                if (selected != null) {
                  setDialogState(() => expiry = selected);
                }
              }

              Future<void> pickLocation() async {
                final result =
                    await showDialog<GovernmentAnnouncementLocationSelection>(
                      context: context,
                      builder:
                          (_) => GovernmentAnnouncementLocationPicker(
                            initialLocation: location,
                          ),
                    );
                if (result != null) {
                  setDialogState(() => location = result.point);
                }
              }

              final now = DateTime.now().toUtc();
              final expiryValid =
                  expiry.isAfter(now) &&
                  !expiry.isAfter(now.add(const Duration(days: 90)));
              final locationValid =
                  !_announcementCategoriesRequiringLocation.contains(
                    category,
                  ) ||
                  location != null;
              final locationRequired = _announcementCategoriesRequiringLocation
                  .contains(category);
              return AlertDialog(
                title: Text(existing == null ? '新增官方公告' : '修訂官方公告'),
                content: SizedBox(
                  width: 520,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        TextField(
                          controller: title,
                          maxLength: 120,
                          decoration: InputDecoration(
                            labelText: '標題',
                            errorText: titleError,
                          ),
                          onChanged: (value) {
                            if (titleError != null && value.trim().isNotEmpty) {
                              setDialogState(() => titleError = null);
                            }
                          },
                        ),
                        TextField(
                          controller: content,
                          maxLines: 4,
                          maxLength: 8000,
                          decoration: InputDecoration(
                            labelText: '內容',
                            errorText: contentError,
                          ),
                          onChanged: (value) {
                            if (contentError != null &&
                                value.trim().isNotEmpty) {
                              setDialogState(() => contentError = null);
                            }
                          },
                        ),
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Chip(
                            avatar: Icon(Icons.public, size: 18),
                            label: Text('全台灣公告'),
                          ),
                        ),
                        DropdownButtonFormField<String>(
                          value: category,
                          decoration: const InputDecoration(labelText: '公告類別'),
                          items: const <DropdownMenuItem<String>>[
                            DropdownMenuItem(
                              value: 'SAFETY',
                              child: Text('安全提醒'),
                            ),
                            DropdownMenuItem(
                              value: 'WEATHER',
                              child: Text('天氣'),
                            ),
                            DropdownMenuItem(value: 'ROAD', child: Text('道路')),
                            DropdownMenuItem(
                              value: 'SHELTER',
                              child: Text('避難收容'),
                            ),
                            DropdownMenuItem(
                              value: 'SUPPLY_STATION',
                              child: Text('物資站'),
                            ),
                            DropdownMenuItem(value: 'OTHER', child: Text('其他')),
                          ],
                          onChanged: (value) {
                            if (value != null) {
                              setDialogState(() => category = value);
                            }
                          },
                        ),
                        if (category != 'SUPPLY_STATION')
                          DropdownButtonFormField<String>(
                            value: severity,
                            decoration: const InputDecoration(
                              labelText: '嚴重程度',
                            ),
                            items: const <DropdownMenuItem<String>>[
                              DropdownMenuItem(value: 'LOW', child: Text('低')),
                              DropdownMenuItem(
                                value: 'MEDIUM',
                                child: Text('中'),
                              ),
                              DropdownMenuItem(value: 'HIGH', child: Text('高')),
                              DropdownMenuItem(
                                value: 'CRITICAL',
                                child: Text('緊急'),
                              ),
                              DropdownMenuItem(
                                value: 'UNKNOWN',
                                child: Text('未分類'),
                              ),
                            ],
                            onChanged: (value) {
                              if (value != null) {
                                setDialogState(() => severity = value);
                              }
                            },
                          ),
                        InkWell(
                          key: const ValueKey('announcement-expiry-picker'),
                          onTap: pickExpiry,
                          borderRadius: BorderRadius.circular(8),
                          child: InputDecorator(
                            decoration: const InputDecoration(
                              labelText: '有效期限（台灣時間）',
                              suffixIcon: Icon(Icons.calendar_month),
                            ),
                            child: Text(
                              GovernmentAnnouncementTime.formatTaiwan(expiry),
                            ),
                          ),
                        ),
                        if (!expiryValid)
                          const Align(
                            alignment: Alignment.centerLeft,
                            child: Padding(
                              padding: EdgeInsets.only(top: 6),
                              child: Text(
                                '請選擇未來 90 天內的時間。',
                                style: TextStyle(color: Colors.red),
                              ),
                            ),
                          ),
                        const SizedBox(height: 8),
                        Text(
                          locationRequired
                              ? '道路、避難收容與物資站公告需設定地圖位置，發布後會同時顯示在地圖與通知中。'
                              : '公告範圍為全台灣；地圖位置選填，未指定時只顯示在通知中。',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        if (!locationValid)
                          Align(
                            alignment: Alignment.centerLeft,
                            child: Padding(
                              padding: EdgeInsets.only(top: 6),
                              child: Text(
                                '${_announcementCategoryLabels[category] ?? '此類'}公告必須設定地圖位置。',
                                style: const TextStyle(color: Colors.red),
                              ),
                            ),
                          ),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton.icon(
                            onPressed: pickLocation,
                            icon: const Icon(Icons.map_outlined),
                            label: const Text('選擇地圖位置'),
                          ),
                        ),
                        if (location != null)
                          Row(
                            children: <Widget>[
                              Expanded(
                                child: Text(
                                  '已選位置：${location!.latitude.toStringAsFixed(6)}, '
                                  '${location!.longitude.toStringAsFixed(6)}',
                                ),
                              ),
                              TextButton(
                                onPressed:
                                    () => setDialogState(() => location = null),
                                child: const Text('清除'),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ),
                actions: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('取消'),
                  ),
                  FilledButton(
                    onPressed:
                        expiryValid && locationValid
                            ? () {
                              final nextTitleError =
                                  title.text.trim().isEmpty ? 'required' : null;
                              final nextContentError =
                                  content.text.trim().isEmpty
                                      ? 'required'
                                      : null;
                              if (nextTitleError != null ||
                                  nextContentError != null) {
                                setDialogState(() {
                                  titleError = nextTitleError;
                                  contentError = nextContentError;
                                });
                                return;
                              }
                              Navigator.pop(dialogContext, true);
                            }
                            : null,
                    child: Text(existing == null ? '建立並發布' : '修訂並發布'),
                  ),
                ],
              );
            },
          ),
    );
    if (accepted != true) return;

    final input = <String, Object?>{
      'title': title.text,
      'content': content.text,
      'category': category,
      'severity': category == 'SUPPLY_STATION' ? 'LOW' : severity,
      'expires_at': expiry.toUtc().toIso8601String(),
      if (location != null) ...<String, Object?>{
        'longitude': location!.longitude,
        'latitude': location!.latitude,
      },
    };
    await _perform(() async {
      if (existing == null) {
        if (widget.auth.androidDeviceMode &&
            widget.auth.user?.role == 'GOVERNMENT') {
          await widget.auth.createDeviceGovernmentWarning(input);
        } else {
          await widget.auth.createAnnouncement(input);
        }
      } else {
        await widget.auth.reviseAnnouncement(
          existing['event_id'] as String,
          input,
        );
      }
      await _refresh();
    });
  }

  DateTime _existingExpiry(Object? value) {
    final parsed = value is String ? DateTime.tryParse(value) : null;
    if (parsed != null) return parsed.toUtc();
    return DateTime.now().toUtc().add(const Duration(hours: 24));
  }

  GeoPoint? _existingLocation(Object? value) {
    if (value is! Map) return null;
    final longitude = value['longitude'];
    final latitude = value['latitude'];
    if (longitude is! num || latitude is! num) return null;
    return GeoPoint(
      longitude: longitude.toDouble(),
      latitude: latitude.toDouble(),
    );
  }

  Future<DateTime?> _pickAnnouncementExpiry(
    BuildContext context,
    DateTime currentExpiry,
  ) async {
    final nowTaiwan = GovernmentAnnouncementTime.taiwanWallClockFromUtc(
      DateTime.now().toUtc(),
    );
    final currentTaiwan = GovernmentAnnouncementTime.taiwanWallClockFromUtc(
      currentExpiry,
    );
    final firstDate = DateTime(nowTaiwan.year, nowTaiwan.month, nowTaiwan.day);
    final lastDate = firstDate.add(const Duration(days: 90));
    var initialDate = DateTime(
      currentTaiwan.year,
      currentTaiwan.month,
      currentTaiwan.day,
    );
    if (initialDate.isBefore(firstDate)) initialDate = firstDate;
    if (initialDate.isAfter(lastDate)) initialDate = lastDate;

    final date = await showDatePicker(
      context: context,
      initialDate: initialDate,
      firstDate: firstDate,
      lastDate: lastDate,
      helpText: '選擇公告有效日期（台灣時間）',
    );
    if (date == null || !context.mounted) return null;

    final time = await _pickTaiwanTime(context, currentTaiwan);
    if (time == null) return null;
    return GovernmentAnnouncementTime.toUtcFromTaiwanWallClock(
      DateTime.utc(
        date.year,
        date.month,
        date.day,
        time.hour,
        time.minute,
        time.second,
      ),
    );
  }

  Future<_AnnouncementTimeParts?> _pickTaiwanTime(
    BuildContext context,
    DateTime initial,
  ) => showDialog<_AnnouncementTimeParts>(
    context: context,
    builder: (context) {
      var hour = initial.hour;
      var minute = initial.minute;
      var second = initial.second;
      return StatefulBuilder(
        builder:
            (context, setDialogState) => AlertDialog(
              title: const Text('選擇時間（台灣時間）'),
              content: SizedBox(
                width: 380,
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        value: hour,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: '時'),
                        items: List<DropdownMenuItem<int>>.generate(
                          24,
                          (value) => DropdownMenuItem<int>(
                            value: value,
                            child: Text(value.toString().padLeft(2, '0')),
                          ),
                        ),
                        onChanged: (value) {
                          if (value != null) setDialogState(() => hour = value);
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        value: minute,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: '分'),
                        items: List<DropdownMenuItem<int>>.generate(
                          60,
                          (value) => DropdownMenuItem<int>(
                            value: value,
                            child: Text(value.toString().padLeft(2, '0')),
                          ),
                        ),
                        onChanged: (value) {
                          if (value != null) {
                            setDialogState(() => minute = value);
                          }
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        value: second,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: '秒'),
                        items: List<DropdownMenuItem<int>>.generate(
                          60,
                          (value) => DropdownMenuItem<int>(
                            value: value,
                            child: Text(value.toString().padLeft(2, '0')),
                          ),
                        ),
                        onChanged: (value) {
                          if (value != null) {
                            setDialogState(() => second = value);
                          }
                        },
                      ),
                    ),
                  ],
                ),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                FilledButton(
                  onPressed:
                      () => Navigator.pop(
                        context,
                        _AnnouncementTimeParts(hour, minute, second),
                      ),
                  child: const Text('確定'),
                ),
              ],
            ),
      );
    },
  );

  Future<void> _retract(Map<String, dynamic> item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder:
          (context) => AlertDialog(
            title: const Text('撤回並隱藏公告？'),
            content: const Text(
              '公告將從工作台清單隱藏，並發布新的官方簽章撤回版本。已發布的簽章歷史與稽核紀錄會保留；使用者端會在同步撤回版本後更新。',
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('撤回並隱藏'),
              ),
            ],
          ),
    );
    if (confirmed != true) return;
    await _perform(() async {
      final eventId = item['event_id'] as String;
      await widget.auth.retractAnnouncement(eventId);
      if (!mounted) return;
      setState(() {
        _announcements = _announcements
            .where((announcement) => announcement['event_id'] != eventId)
            .toList(growable: false);
      });
      await _refresh();
    });
  }

  Widget _usersPage() => Column(
    children: <Widget>[
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Align(
          alignment: Alignment.centerRight,
          child: FilledButton.icon(
            onPressed: _busy ? null : _createGovernmentUser,
            icon: const Icon(Icons.person_add_alt_1),
            label: const Text('新增政府人員'),
          ),
        ),
      ),
      Expanded(
        child:
            _users.isEmpty && !_loading
                ? const Center(child: Text('目前沒有帳號'))
                : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _users.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final user = _users[index];
                    final disabled = user['status'] == 'DISABLED';
                    return Card(
                      child: ListTile(
                        title: Text(
                          user['display_name'] as String? ??
                              user['account'] as String? ??
                              '帳號',
                        ),
                        subtitle: Text(
                          '${user['account'] ?? ''}\n${user['agency'] ?? ''} · ${user['role'] ?? ''} · ${disabled ? '已停用' : '啟用中'}',
                        ),
                        isThreeLine: true,
                        trailing:
                            user['id'] == widget.auth.user?.id
                                ? const Chip(label: Text('目前帳號'))
                                : Switch.adaptive(
                                  value: !disabled,
                                  onChanged:
                                      _busy
                                          ? null
                                          : (enabled) => _setUserStatus(
                                            user,
                                            enabled ? 'ACTIVE' : 'DISABLED',
                                          ),
                                ),
                      ),
                    );
                  },
                ),
      ),
    ],
  );

  Future<void> _createGovernmentUser() async {
    final account = _newAccount..clear();
    final name = _newDisplayName..clear();
    final agency = _newAgency..text = widget.auth.user?.agency ?? '';
    final password = _newPassword..clear();
    final confirmation = _newPasswordConfirmation..clear();
    var errorText = '';
    final accepted = await showDialog<bool>(
      context: context,
      builder:
          (context) => StatefulBuilder(
            builder:
                (context, setDialogState) => AlertDialog(
                  title: const Text('建立政府人員帳號'),
                  content: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        TextField(
                          controller: account,
                          decoration: const InputDecoration(labelText: '帳號'),
                        ),
                        TextField(
                          controller: name,
                          decoration: const InputDecoration(labelText: '姓名'),
                        ),
                        TextField(
                          controller: agency,
                          decoration: const InputDecoration(labelText: '服務機關'),
                        ),
                        TextField(
                          controller: password,
                          obscureText: true,
                          decoration: const InputDecoration(
                            labelText: '設定密碼',
                            helperText: '至少 12 個字元，不限字母、數字或符號',
                          ),
                        ),
                        TextField(
                          controller: confirmation,
                          obscureText: true,
                          decoration: const InputDecoration(labelText: '確認密碼'),
                          onSubmitted: (_) {
                            if (password.text != confirmation.text) {
                              setDialogState(() => errorText = '兩次輸入的密碼不一致');
                            } else {
                              Navigator.pop(context, true);
                            }
                          },
                        ),
                        if (errorText.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              errorText,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      onPressed: () {
                        if (account.text.trim().isEmpty ||
                            name.text.trim().isEmpty ||
                            agency.text.trim().isEmpty ||
                            password.text.isEmpty) {
                          setDialogState(() => errorText = '請完整填寫帳號、姓名、機關與密碼');
                        } else if (password.text.runes.length < 12) {
                          setDialogState(() => errorText = '密碼至少需要 12 個字元');
                        } else if (password.text != confirmation.text) {
                          setDialogState(() => errorText = '兩次輸入的密碼不一致');
                        } else {
                          Navigator.pop(context, true);
                        }
                      },
                      child: const Text('建立帳號'),
                    ),
                  ],
                ),
          ),
    );
    if (accepted != true) return;
    await _perform(() async {
      final user = await widget.auth.api.createGovernmentUser(
        account: account.text.trim(),
        displayName: name.text.trim(),
        agency: agency.text.trim(),
        password: password.text,
      );
      account.clear();
      name.clear();
      password.clear();
      confirmation.clear();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('已建立帳號：${user.account}')));
      }
      await _refresh();
    });
  }

  Future<void> _setUserStatus(Map<String, dynamic> user, String status) =>
      _perform(() async {
        await widget.auth.api.setUserStatus(user['id'] as String, status);
        await _refresh();
      });

  Future<void> _perform(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _errorText(Object error) =>
      error is GovernmentApiException ? error.message : '工作台資料載入失敗，請稍後再試';
}
