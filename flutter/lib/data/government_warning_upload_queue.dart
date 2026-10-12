import 'dart:convert';

typedef PendingGovernmentWarnings =
    Future<List<Map<String, dynamic>>> Function();
typedef UploadGovernmentWarning =
    Future<Map<String, dynamic>> Function(Map<String, dynamic> event);
typedef AcknowledgeGovernmentWarning =
    Future<bool> Function(String eventId, String payloadHash);
typedef ExpireGovernmentWarning =
    Future<bool> Function(String eventId, String payloadHash);

class GovernmentWarningUploadQueueResult {
  const GovernmentWarningUploadQueueResult({
    required this.uploaded,
    required this.pending,
    required this.expired,
    required this.failed,
  });

  final int uploaded;
  final int pending;
  final int expired;
  final int failed;
}

/// Uploads Android's durable Room outbox without changing signed event bytes.
class GovernmentWarningUploadQueue {
  GovernmentWarningUploadQueue({
    required PendingGovernmentWarnings pending,
    required UploadGovernmentWarning upload,
    required AcknowledgeGovernmentWarning acknowledge,
    ExpireGovernmentWarning? expire,
    DateTime Function()? now,
  }) : _pending = pending,
       _upload = upload,
       _acknowledge = acknowledge,
       _expire = expire ?? _keepExpiredPending,
       _now = now ?? DateTime.now;

  final PendingGovernmentWarnings _pending;
  final UploadGovernmentWarning _upload;
  final AcknowledgeGovernmentWarning _acknowledge;
  final ExpireGovernmentWarning _expire;
  final DateTime Function() _now;

  Future<GovernmentWarningUploadQueueResult> flush() async {
    // A native acknowledge callback may mutate its underlying Room snapshot.
    // Iterate over our own batch so that callback timing cannot invalidate it.
    final rows = List<Map<String, dynamic>>.of(await _pending());
    final seen = <String>{};
    var uploaded = 0;
    var expired = 0;
    var failed = 0;
    var pending = 0;
    final now = _now().toUtc();

    for (final row in rows) {
      final event = _decodeEvent(row['event_json']);
      final eventId = row['event_id'];
      final payloadHash = row['payload_hash'];
      if (eventId is! String ||
          payloadHash is! String ||
          event['event_id'] != eventId ||
          event['payload_hash'] != payloadHash) {
        throw const FormatException(
          'Government warning upload row does not match its signed event',
        );
      }
      if (!seen.add(eventId)) continue;
      final expiresAt = DateTime.tryParse(event['expires_at'] as String? ?? '');
      if (expiresAt == null || !expiresAt.toUtc().isAfter(now)) {
        expired += 1;
        if (!await _expire(eventId, payloadHash)) pending += 1;
        continue;
      }
      try {
        final response = await _upload(event);
        if (response['event_id'] != eventId ||
            response['payload_hash'] != payloadHash) {
          throw const FormatException(
            'Government warning upload response changed event identity',
          );
        }
        if (await _acknowledge(eventId, payloadHash)) {
          uploaded += 1;
        } else {
          pending += 1;
          failed += 1;
        }
      } on Object {
        // Room remains the source of truth. The next sync retries these exact bytes.
        pending += 1;
        failed += 1;
      }
    }
    return GovernmentWarningUploadQueueResult(
      uploaded: uploaded,
      pending: pending,
      expired: expired,
      failed: failed,
    );
  }

  Map<String, dynamic> _decodeEvent(Object? value) {
    final decoded = switch (value) {
      String text => jsonDecode(text),
      Map map => map,
      _ => null,
    };
    if (decoded is! Map) {
      throw const FormatException('Government warning upload event is invalid');
    }
    return Map<String, dynamic>.from(decoded);
  }

  static Future<bool> _keepExpiredPending(String _, String __) async => false;
}

String governmentWarningCloudStatusLabel(Object? status) => switch (status) {
  'PENDING' => '待雲端補傳',
  'UPLOADED' => '待官方 feed 發布',
  'PUBLISHED' => '已發布',
  'EXPIRED' => '已過期，未完成雲端發布',
  _ => '狀態未知',
};
