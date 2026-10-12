import 'package:flutter/material.dart';

import '../data/attestation_index.dart';
import '../data/map_models.dart';
import '../widgets/map_layers.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({
    super.key,
    required this.events,
    required this.onEventRead,
    this.attestationSource = const <MeshEvent>[],
  });

  final List<MeshEvent> events;

  /// Every known event, read or not, so an attestation already marked read
  /// still labels the report it verifies.
  final List<MeshEvent> attestationSource;
  final ValueChanged<MeshEvent> onEventRead;

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
    return Scaffold(
      appBar: AppBar(title: const Text('通知')),
      body:
          sorted.isEmpty
              ? const Center(child: Text('目前沒有事件通知'))
              : ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                itemCount: sorted.length,
                separatorBuilder: (_, _) => const SizedBox(height: 10),
                itemBuilder:
                    (context, index) => _EventCard(
                      event: sorted[index],
                      onTap: () => onEventRead(sorted[index]),
                    ),
              ),
    );
  }
}

class _EventCard extends StatelessWidget {
  const _EventCard({required this.event, required this.onTap});

  final MeshEvent event;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final demo =
        event.namespace?.startsWith('demo') == true ||
        event.source?.toLowerCase() == 'demo';
    final title = eventName(event);
    return Card(
      child: ListTile(
        onTap: onTap,
        leading: DecoratedBox(
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Theme.of(context).colorScheme.outline),
          ),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Icon(
              event.isExpired
                  ? MapIconCatalog.expiredEvent
                  : MapIconCatalog.disaster,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        title: Text(title),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            [
              if (demo) '模擬事件，非即時官方災情',
              '事件類型：${event.eventType ?? '無資料'}',
              '來源：${event.source ?? '無資料'}',
              '嚴重度：${event.severity ?? '無資料'}',
              isCrowdEvent(event) && !event.isExpired
                  ? '狀態：${crowdVerificationLabel(event.verification ?? CrowdVerification.unverified)}'
                  : event.namespace == 'official.announcement'
                  ? '狀態：官方簽章已驗證'
                  : '狀態：${_applyStateLabel(event.effectiveApplyState)}',
              if (event.namespace == 'official.announcement' &&
                  event.attributes?['content'] is String)
                '內容：${event.attributes!['content']}',
              '發布：${event.issuedAt ?? '無資料'}',
              '有效期限：${event.expiresAt ?? '無資料'}',
            ].join('\n'),
          ),
        ),
        isThreeLine: true,
      ),
    );
  }
}

String _applyStateLabel(String? applyState) => switch (applyState) {
  'CURRENT' => '有效',
  'EXPIRED' => '已過期',
  'UNVERIFIED' => '未驗證',
  _ => '無資料',
};
