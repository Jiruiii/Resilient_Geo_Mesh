import 'package:flutter/material.dart';

import '../data/attestation_index.dart';
import '../data/government_announcement_time.dart';
import '../data/map_models.dart';
import '../data/rescue_request_models.dart';
import '../widgets/map_layers.dart';

class NotificationsScreen extends StatelessWidget {
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
  Widget build(BuildContext context) {
    // Attestations are shown through the report they verify, not on their own;
    // refuted reports stay listed here so the verdict remains visible.
    final index = AttestationIndex.fromEvents(<MeshEvent>[
      ...attestationSource,
      ...events,
    ]);
    final sorted =
        events
            .where((event) => !isAttestationEvent(event))
            .map(index.withVerification)
            .toList()
          ..sort((a, b) => (b.issuedAt ?? '').compareTo(a.issuedAt ?? ''));
    final unreadCount =
        sorted
            .where((event) => !readEventKeys.contains(meshEventIdentity(event)))
            .length;
    return Scaffold(
      appBar: AppBar(title: const Text('通知')),
      body:
          sorted.isEmpty
              ? const Center(child: Text('目前沒有事件通知'))
              : Column(
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: <Widget>[
                        TextButton.icon(
                          onPressed: unreadCount == 0 ? null : onMarkAllRead,
                          icon: const Icon(Icons.mark_email_read_outlined),
                          label: const Text('全部已讀'),
                        ),
                        TextButton.icon(
                          onPressed:
                              onDeleteAll == null
                                  ? null
                                  : () => _confirmDeleteAll(context),
                          icon: const Icon(Icons.delete_sweep_outlined),
                          label: const Text('全部刪除'),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                      itemCount: sorted.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 10),
                      itemBuilder: (context, index) {
                        final event = sorted[index];
                        return _EventCard(
                          event: event,
                          isRead: readEventKeys.contains(
                            meshEventIdentity(event),
                          ),
                          onTap: () => onEventRead(event),
                          onDoubleTap:
                              onEventMapRequested == null
                                  ? null
                                  : () => onEventMapRequested!(event),
                          onMarkRead: () => onEventRead(event),
                          onDelete:
                              onEventDeleted == null
                                  ? null
                                  : () => _deleteEvent(context, event),
                        );
                      },
                    ),
                  ),
                ],
              ),
    );
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
    if (confirmed == true) onDeleteAll?.call();
  }

  void _deleteEvent(BuildContext context, MeshEvent event) {
    onEventDeleted?.call(event);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: const Text('通知已刪除'),
          action:
              onUndoDelete == null
                  ? null
                  : SnackBarAction(
                    label: '復原',
                    onPressed: () => onUndoDelete?.call(event),
                  ),
        ),
      );
  }
}

class _EventCard extends StatelessWidget {
  const _EventCard({
    required this.event,
    required this.isRead,
    required this.onTap,
    required this.onDoubleTap,
    required this.onMarkRead,
    required this.onDelete,
  });

  final MeshEvent event;
  final bool isRead;
  final VoidCallback onTap;
  final VoidCallback? onDoubleTap;
  final VoidCallback onMarkRead;
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
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          InkWell(
            onTap: onTap,
            onDoubleTap: onDoubleTap,
            child: ListTile(
              leading: DecoratedBox(
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
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
                            : Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              title: Text(title),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  [
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
                      if (!supplyStation)
                        '嚴重度：${event.severity ?? '無資料'}',
                    ],
                    isCrowdEvent(event) && !event.isExpired
                        ? '狀態：${crowdVerificationLabel(event.verification ?? CrowdVerification.unverified)}'
                        : event.namespace == 'official.announcement'
                        ? '狀態：官方簽章已驗證'
                        : '狀態：${_applyStateLabel(event.effectiveApplyState)}',
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
                    '發布：${_formatNotificationTime(event.issuedAt, announcement)}',
                    '有效期限：${_formatNotificationTime(event.expiresAt, announcement)}',
                  ].join('\n'),
                ),
              ),
              isThreeLine: true,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 12, 8),
            child: Wrap(
              alignment: WrapAlignment.end,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 4,
              children: <Widget>[
                Chip(
                  avatar: Icon(
                    isRead ? Icons.mark_email_read_outlined : Icons.markunread,
                    size: 16,
                  ),
                  label: Text(isRead ? '已讀' : '未讀'),
                  visualDensity: VisualDensity.compact,
                ),
                if (!isRead)
                  TextButton.icon(
                    onPressed: onMarkRead,
                    icon: const Icon(Icons.done_all),
                    label: const Text('標為已讀'),
                  ),
                TextButton.icon(
                  onPressed: onDelete,
                  icon: const Icon(Icons.delete_outline),
                  label: const Text('刪除通知'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
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
  'EXPIRED' => '已過期',
  'UNVERIFIED' => '未驗證',
  _ => '無資料',
};
