import 'package:flutter/material.dart';

import '../data/attestation_index.dart';
import '../data/alert_category.dart';
import '../data/government_announcement_time.dart';
import '../data/map_models.dart';
import '../data/rescue_request_models.dart';
import '../widgets/map_layers.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({
    super.key,
    required this.events,
    required this.onEventRead,
    this.attestationSource = const <MeshEvent>[],
    this.readEventKeys = const <String>{},
    this.onMarkAllRead,
    this.onEventDeleted,
    this.onDeleteAll,
    this.onUndoDelete,
    this.onEventMapRequested,
  });

  final List<MeshEvent> events;
  final Set<String> readEventKeys;

  /// Every known event, read or not, so an attestation already marked read
  /// still labels the report it verifies.
  final List<MeshEvent> attestationSource;
  final ValueChanged<MeshEvent> onEventRead;
  final VoidCallback? onMarkAllRead;
  final ValueChanged<MeshEvent>? onEventDeleted;
  final VoidCallback? onDeleteAll;
  final ValueChanged<MeshEvent>? onUndoDelete;
  final ValueChanged<MeshEvent>? onEventMapRequested;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late Set<String> _selectedCategories;
  final Set<String> _collapsedCategories = <String>{};
  final Set<String> _expandedEvents = <String>{};
  bool _allCategoriesSelected = true;
  _NotificationSort _sort = _NotificationSort.time;

  @override
  void initState() {
    super.initState();
    _selectedCategories = _categoryLabels(widget.events);
  }

  @override
  void didUpdateWidget(covariant NotificationsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    final categories = _categoryLabels(widget.events);
    if (_allCategoriesSelected) {
      _selectedCategories = categories;
    } else {
      _selectedCategories.retainAll(categories);
    }
    _allCategoriesSelected = _selectedCategories.length == categories.length;
    _collapsedCategories.retainAll(categories);
    final eventKeys = widget.events.map(meshEventIdentity).toSet();
    _expandedEvents.retainAll(eventKeys);
  }

  @override
  Widget build(BuildContext context) {
    // Attestations are shown through the report they verify, not on their own;
    // refuted reports stay listed here so the verdict remains visible.
    final index = AttestationIndex.fromEvents(<MeshEvent>[
      ...widget.attestationSource,
      ...widget.events,
    ]);
    final sorted =
        widget.events
            .where((event) => !isAttestationEvent(event))
            .map(index.withVerification)
            .toList()
          ..sort((a, b) => _compareEvents(a, b, _sort));
    final categories = _categoryLabels(sorted).toList()..sort();
    final unreadCount =
        sorted
            .where(
              (event) =>
                  !widget.readEventKeys.contains(meshEventIdentity(event)),
            )
            .length;
    final visible =
        sorted
            .where((event) => _selectedCategories.contains(_categoryFor(event)))
            .toList();
    final groups = <String, List<MeshEvent>>{};
    for (final event in visible) {
      groups.putIfAbsent(_categoryFor(event), () => <MeshEvent>[]).add(event);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('通知')),
      body:
          sorted.isEmpty
              ? const Center(child: Text('目前沒有事件通知'))
              : Column(
                children: <Widget>[
                  _buildNotificationControls(categories, unreadCount),
                  Expanded(
                    child:
                        groups.isEmpty
                            ? const Center(child: Text('沒有符合所選分類的通知'))
                            : ListView.separated(
                              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                              itemCount: groups.length,
                              separatorBuilder:
                                  (_, _) => const SizedBox(height: 12),
                              itemBuilder: (context, index) {
                                final entry = groups.entries.elementAt(index);
                                final collapsed = _collapsedCategories.contains(
                                  entry.key,
                                );
                                return Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: <Widget>[
                                    _CategoryGroupHeader(
                                      category: entry.key,
                                      count: entry.value.length,
                                      collapsed: collapsed,
                                      onTap: () => _toggleCategory(entry.key),
                                    ),
                                    if (!collapsed) ...<Widget>[
                                      const SizedBox(height: 8),
                                      for (final event
                                          in entry.value) ...<Widget>[
                                        _EventCard(
                                          event: event,
                                          isRead: widget.readEventKeys.contains(
                                            meshEventIdentity(event),
                                          ),
                                          isExpanded: _expandedEvents.contains(
                                            meshEventIdentity(event),
                                          ),
                                          onTap:
                                              () => widget.onEventRead(event),
                                          onDoubleTap:
                                              widget.onEventMapRequested == null
                                                  ? null
                                                  : () => widget
                                                      .onEventMapRequested!(
                                                    event,
                                                  ),
                                          onToggleExpanded:
                                              () => _toggleEvent(event),
                                          onDelete:
                                              widget.onEventDeleted == null
                                                  ? null
                                                  : () => _deleteEvent(
                                                    context,
                                                    event,
                                                  ),
                                        ),
                                        const SizedBox(height: 8),
                                      ],
                                    ],
                                  ],
                                );
                              },
                            ),
                  ),
                ],
              ),
    );
  }

  Widget _buildNotificationControls(List<String> categories, int unreadCount) {
    final allSelected =
        categories.isNotEmpty &&
        _selectedCategories.length == categories.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              Badge(
                isLabelVisible: !allSelected,
                label: Text('${_selectedCategories.length}'),
                child: IconButton(
                  tooltip: '選擇告警分類',
                  onPressed: () => _showCategoryPicker(categories),
                  icon: const Icon(Icons.filter_list),
                ),
              ),
              Text(allSelected ? '全部分類' : '已選 ${_selectedCategories.length} 種'),
              const Spacer(),
              PopupMenuButton<_NotificationSort>(
                tooltip: '通知排序方式',
                onSelected: (sort) => setState(() => _sort = sort),
                itemBuilder:
                    (context) => <PopupMenuEntry<_NotificationSort>>[
                      const PopupMenuItem<_NotificationSort>(
                        value: _NotificationSort.time,
                        child: Text('時間（新到舊）'),
                      ),
                      const PopupMenuItem<_NotificationSort>(
                        value: _NotificationSort.severity,
                        child: Text('嚴重度（高到低）'),
                      ),
                    ],
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 10,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const Icon(Icons.sort),
                      const SizedBox(width: 4),
                      Text(_sort.label),
                      const Icon(Icons.arrow_drop_down),
                    ],
                  ),
                ),
              ),
            ],
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: <Widget>[
              TextButton.icon(
                onPressed: unreadCount == 0 ? null : widget.onMarkAllRead,
                icon: const Icon(Icons.mark_email_read_outlined),
                label: const Text('全部已讀'),
              ),
              TextButton.icon(
                onPressed:
                    widget.onDeleteAll == null
                        ? null
                        : () => _confirmDeleteAll(context),
                icon: const Icon(Icons.delete_sweep_outlined),
                label: const Text('全部刪除'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _showCategoryPicker(List<String> categories) async {
    final selected = Set<String>.of(_selectedCategories);
    final result = await showDialog<Set<String>>(
      context: context,
      builder:
          (dialogContext) => StatefulBuilder(
            builder:
                (context, setDialogState) => AlertDialog(
                  title: const Text('選擇告警分類'),
                  content: SizedBox(
                    width: 400,
                    height: MediaQuery.sizeOf(context).height * 0.55,
                    child: Column(
                      children: <Widget>[
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('全部分類'),
                          value: selected.length == categories.length,
                          onChanged: (_) {
                            setDialogState(() {
                              if (selected.length == categories.length) {
                                selected.clear();
                              } else {
                                selected
                                  ..clear()
                                  ..addAll(categories);
                              }
                            });
                          },
                        ),
                        const Divider(height: 1),
                        Expanded(
                          child: ListView(
                            children: <Widget>[
                              for (final category in categories)
                                CheckboxListTile(
                                  contentPadding: EdgeInsets.zero,
                                  title: Text(category),
                                  value: selected.contains(category),
                                  onChanged: (checked) {
                                    setDialogState(() {
                                      if (checked == true) {
                                        selected.add(category);
                                      } else {
                                        selected.remove(category);
                                      }
                                    });
                                  },
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.pop(dialogContext),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      onPressed:
                          () => Navigator.pop(
                            dialogContext,
                            Set<String>.of(selected),
                          ),
                      child: const Text('套用'),
                    ),
                  ],
                ),
          ),
    );
    if (result == null) return;
    setState(() {
      _selectedCategories = result;
      _allCategoriesSelected = result.length == categories.length;
    });
  }

  void _toggleCategory(String category) {
    setState(() {
      if (!_collapsedCategories.add(category)) {
        _collapsedCategories.remove(category);
      }
    });
  }

  void _toggleEvent(MeshEvent event) {
    final key = meshEventIdentity(event);
    setState(() {
      if (!_expandedEvents.add(key)) _expandedEvents.remove(key);
    });
  }

  Future<void> _confirmDeleteAll(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder:
          (dialogContext) => AlertDialog(
            title: const Text('刪除全部通知？'),
            content: const Text('這只會清除本裝置的通知列表，不會刪除地圖上的公告資料。'),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: const Text('刪除全部'),
              ),
            ],
          ),
    );
    if (confirmed == true) widget.onDeleteAll?.call();
  }

  void _deleteEvent(BuildContext context, MeshEvent event) {
    widget.onEventDeleted?.call(event);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: const Text('通知已刪除'),
          action:
              widget.onUndoDelete == null
                  ? null
                  : SnackBarAction(
                    label: '復原',
                    onPressed: () => widget.onUndoDelete?.call(event),
                  ),
        ),
      );
  }
}

class _CategoryGroupHeader extends StatelessWidget {
  const _CategoryGroupHeader({
    required this.category,
    required this.count,
    required this.collapsed,
    required this.onTap,
  });

  final String category;
  final int count;
  final bool collapsed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerLow,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  category,
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                '$count 則通知',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const SizedBox(width: 8),
              Icon(
                collapsed ? Icons.expand_more : Icons.expand_less,
                semanticLabel: collapsed ? '展開$category通知' : '收合$category通知',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EventCard extends StatelessWidget {
  const _EventCard({
    required this.event,
    required this.isRead,
    required this.isExpanded,
    required this.onTap,
    required this.onDoubleTap,
    required this.onToggleExpanded,
    required this.onDelete,
  });

  final MeshEvent event;
  final bool isRead;
  final bool isExpanded;
  final VoidCallback onTap;
  final VoidCallback? onDoubleTap;
  final VoidCallback onToggleExpanded;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final demo =
        event.namespace?.startsWith('demo') == true ||
        event.source?.toLowerCase() == 'demo';
    final announcement = event.namespace == 'official.announcement';
    final areaId = event.attributes?['area_id'];
    final mapPoint =
        event.geometry is PointGeometry
            ? (event.geometry! as PointGeometry).point
            : null;
    final title = eventName(event);
    final rescue = RescueRequestView.fromEvent(event);
    final supplyStation = isSupplyStationEvent(event);
    final alertCategory = alertCategoryLabelFor(event);
    final affectedArea = _affectedAreaFor(event, areaId);
    final stateLabel = _eventStateLabel(event);
    final taiwanTime = announcement || event.hasCwaWarningValidTime;
    final details = <String>[
      if (alertCategory != null) '告警分類：$alertCategory',
      if (demo) '模擬事件，非即時官方災情',
      if (rescue != null) ...<String>[
        '求救狀態：${rescue.status.label}',
        '急迫程度：${rescue.urgency.label}',
        '人數：${rescue.peopleCount} 人',
      ] else ...<String>[
        '事件類型：${event.eventType ?? '無資料'}',
        if (announcement)
          '公告類別：${governmentAnnouncementCategoryLabel(event.attributes?['category'])}',
        '來源：${event.source ?? '無資料'}',
        if (!supplyStation) '嚴重度：${event.severity ?? '無資料'}',
        if (affectedArea != '未提供')
          '影響範圍：$affectedArea${event.attributes?['coverage_level'] == 'county' ? '（縣市級警報）' : ''}',
        if (event.isNcdrMultiAreaWarning)
          event.hasCompleteNcdrAreaMask
              ? '地圖範圍：警報涵蓋行政區（非精確風害位置）'
              : '地圖範圍：部分區域缺少邊界，未顯示遮罩',
        if (event.source?.toUpperCase() == 'CWA' &&
            event.attributes?['map_location_kind'] == 'area_reference' &&
            mapPoint != null)
          '地圖位置：影響範圍參考點（非告警發生的精確位置）',
      ],
      if (isCrowdEvent(event) && !event.isExpired)
        '狀態：${crowdVerificationLabel(event.verification ?? CrowdVerification.unverified)}'
      else if (announcement)
        '狀態：官方簽章已驗證'
      else
        '狀態：$stateLabel',
      if (announcement)
        '範圍：${areaId == 'tw.national'
            ? '全台灣'
            : areaId is String
            ? areaId
            : '未指定'}',
      if (announcement) '版本：${event.eventVersion ?? 1}',
      if (announcement &&
          event.attributes?['has_map_location'] == true &&
          mapPoint != null)
        '地圖位置：緯度 ${mapPoint.latitude.toStringAsFixed(6)}，經度 ${mapPoint.longitude.toStringAsFixed(6)}',
      if (announcement && event.attributes?['content'] is String)
        '內容：${event.attributes!['content']}',
      if (event.hasCwaWarningValidTime) '發布時間：來源未提供',
      '${event.hasCwaWarningValidTime ? '影響時段開始' : '發布'}：${_formatNotificationTime(event.issuedAt, taiwanTime)}',
      '${event.hasCwaWarningValidTime ? '影響時段結束' : '有效期限'}：${_formatNotificationTime(event.expiresAt, taiwanTime)}',
    ].join('\n');

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: isRead ? null : onTap,
                    onDoubleTap: onDoubleTap,
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          DecoratedBox(
                            decoration: BoxDecoration(
                              color:
                                  Theme.of(
                                    context,
                                  ).colorScheme.surfaceContainerHighest,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: Theme.of(context).colorScheme.outline,
                              ),
                            ),
                            child: SizedBox(
                              width: 44,
                              height: 44,
                              child: Icon(
                                event.isExpired
                                    ? MapIconCatalog.expiredEvent
                                    : rescue != null
                                    ? MapIconCatalog.rescueRequest(rescue.type)
                                    : MapIconCatalog.forEvent(event),
                                color:
                                    supplyStation
                                        ? supplyStationMarkerColor
                                        : Theme.of(
                                          context,
                                        ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    if (!isRead) ...<Widget>[
                                      Padding(
                                        padding: const EdgeInsets.only(
                                          top: 6,
                                          right: 6,
                                        ),
                                        child: Icon(
                                          Icons.circle,
                                          size: 8,
                                          color:
                                              Theme.of(
                                                context,
                                              ).colorScheme.primary,
                                          semanticLabel: '未讀',
                                        ),
                                      ),
                                    ],
                                    Expanded(
                                      child: Text(
                                        title,
                                        style: Theme.of(
                                          context,
                                        ).textTheme.titleMedium?.copyWith(
                                          fontWeight:
                                              isRead
                                                  ? FontWeight.normal
                                                  : FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                if (!isExpanded) ...<Widget>[
                                  Text('影響範圍：$affectedArea'),
                                  Text('狀態：$stateLabel'),
                                  Text(
                                    '有效期限：${_formatNotificationTime(event.expiresAt, taiwanTime)}',
                                  ),
                                ] else ...<Widget>[Text(details)],
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                IconButton(
                  tooltip: isExpanded ? '收合通知詳情' : '展開通知詳情',
                  onPressed: onToggleExpanded,
                  icon: Icon(
                    isExpanded ? Icons.expand_less : Icons.expand_more,
                  ),
                ),
              ],
            ),
          ),
          if (isExpanded && onDelete != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: onDelete,
                  icon: const Icon(Icons.delete_outline),
                  label: const Text('刪除通知'),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

enum _NotificationSort { time, severity }

extension on _NotificationSort {
  String get label => switch (this) {
    _NotificationSort.time => '時間',
    _NotificationSort.severity => '嚴重度',
  };
}

int _compareEvents(MeshEvent left, MeshEvent right, _NotificationSort sort) {
  if (sort == _NotificationSort.severity) {
    final severityOrder = _severityRank(
      left.severity,
    ).compareTo(_severityRank(right.severity));
    if (severityOrder != 0) return severityOrder;
  }
  return _compareByIssueTime(left, right);
}

int _severityRank(String? severity) => switch (severity?.toUpperCase()) {
  'CRITICAL' || 'EXTREME' => 0,
  'HIGH' || 'SEVERE' => 1,
  'MEDIUM' || 'MODERATE' => 2,
  'LOW' || 'MINOR' => 3,
  _ => 4,
};

int _compareByIssueTime(MeshEvent left, MeshEvent right) {
  final leftTime = DateTime.tryParse(left.issuedAt ?? '')?.toUtc();
  final rightTime = DateTime.tryParse(right.issuedAt ?? '')?.toUtc();
  if (leftTime == null) return rightTime == null ? 0 : 1;
  if (rightTime == null) return -1;
  return rightTime.compareTo(leftTime);
}

Set<String> _categoryLabels(Iterable<MeshEvent> events) =>
    events
        .where((event) => !isAttestationEvent(event))
        .map(_categoryFor)
        .toSet();

String _categoryFor(MeshEvent event) => alertCategoryLabelFor(event) ?? '一般通知';

String _affectedAreaFor(MeshEvent event, Object? areaId) {
  final affectedArea = event.attributes?['affected_area'];
  if (affectedArea is String && affectedArea.trim().isNotEmpty) {
    return affectedArea.trim();
  }
  if (event.namespace == 'official.announcement' && areaId is String) {
    return areaId == 'tw.national' ? '全台灣' : areaId;
  }
  return '未提供';
}

String _eventStateLabel(MeshEvent event) {
  if (isCrowdEvent(event) && !event.isExpired) {
    return crowdVerificationLabel(
      event.verification ?? CrowdVerification.unverified,
    );
  }
  if (event.namespace == 'official.announcement') return '官方簽章已驗證';
  return _applyStateLabel(event.effectiveApplyState);
}

String _formatNotificationTime(String? value, bool taiwanTime) {
  if (value == null) return '無資料';
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  return taiwanTime
      ? GovernmentAnnouncementTime.formatTaiwan(parsed.toUtc())
      : value;
}

String _applyStateLabel(String? applyState) => switch (applyState) {
  'CURRENT' => '有效',
  'UPCOMING' => '尚未生效',
  'EXPIRED' => '已過期',
  'UNVERIFIED' => '未驗證',
  _ => '無資料',
};
