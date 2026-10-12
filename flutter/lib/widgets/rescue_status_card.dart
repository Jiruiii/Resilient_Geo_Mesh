import 'package:flutter/material.dart';

import '../data/display_time.dart';
import '../data/rescue_request_models.dart';
import 'map_layers.dart';
import 'rescue_marker.dart';
import 'rescue_request_sheet.dart';

class RescueStatusCard extends StatelessWidget {
  const RescueStatusCard({
    super.key,
    required this.session,
    required this.now,
    required this.reminderDue,
    required this.busy,
    required this.sirenPanel,
    required this.onUpdate,
    required this.onExtend,
    required this.onResolve,
    required this.onCancel,
  });

  final RescueSession session;
  final DateTime now;
  final bool reminderDue;
  final bool busy;
  final Widget? sirenPanel;
  final VoidCallback onUpdate;
  final VoidCallback onExtend;
  final VoidCallback onResolve;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final request = session.request;
    final theme = Theme.of(context);
    return Card(
      key: const ValueKey<String>('rescue-status-card'),
      elevation: 6,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: rescueUrgencyColor(request.urgency), width: 2),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (sirenPanel != null) ...<Widget>[sirenPanel!, const SizedBox(height: 8)],
            Row(
              children: <Widget>[
                Icon(MapIconCatalog.rescueRequest(request.type), color: rescueUrgencyColor(request.urgency)),
                const SizedBox(width: 8),
                Expanded(child: Text('你的求救：${request.type.label}', style: theme.textTheme.titleMedium)),
              ],
            ),
            Text('急迫程度：${request.urgency.label}　狀態：${request.status.label}'),
            Text(session.deliveryText()),
            Text('到期：${formatUpdateTime(request.expiresAt.toIso8601String())}'),
            const Text('未經查證，不代表已派遣救援', style: TextStyle(color: unverifiedEventColor, fontWeight: FontWeight.w600)),
            const Text(rescueNot119Text),
            if (reminderDue)
              Container(
                key: const ValueKey<String>('rescue-expiry-reminder'),
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('求救將於 ${formatUpdateTime(request.expiresAt.toIso8601String())} 到期，仍需救援？'),
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                OutlinedButton(key: const ValueKey<String>('rescue-update'), onPressed: busy ? null : onUpdate, child: const Text('更新')),
                if (request.canExtendAt(now))
                  OutlinedButton(key: const ValueKey<String>('rescue-extend'), onPressed: busy ? null : onExtend, child: const Text('延長 6 小時')),
                FilledButton(
                  key: const ValueKey<String>('rescue-resolve'),
                  onPressed: busy ? null : () => _confirm(context, '確認你已安全或已獲救？', onResolve),
                  child: const Text('我已安全／已獲救'),
                ),
                TextButton(
                  key: const ValueKey<String>('rescue-cancel'),
                  onPressed: busy ? null : () => _confirm(context, '確認取消這筆求救（誤報）？', onCancel),
                  child: const Text('取消誤報'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(BuildContext context, String question, VoidCallback onConfirmed) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(question),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('返回')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('確認')),
        ],
      ),
    );
    if (confirmed == true) onConfirmed();
  }
}
