import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'government_api.dart';

class CrowdReportUploadQueue {
  static const _storageKey = 'crowd.server_upload_queue.v1';

  Future<List<Map<String, dynamic>>> pending() async {
    final preferences = await SharedPreferences.getInstance();
    return (preferences.getStringList(_storageKey) ?? const <String>[])
        .map((row) {
          try {
            final value = jsonDecode(row);
            return value is Map ? Map<String, dynamic>.from(value) : null;
          } on Object {
            return null;
          }
        })
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }

  Future<void> enqueue(Map<String, dynamic> event) async {
    final preferences = await SharedPreferences.getInstance();
    final queue = preferences.getStringList(_storageKey) ?? <String>[];
    final eventId = event['event_id'];
    if (queue.any(
      (row) =>
          jsonDecode(row) is Map &&
          (jsonDecode(row) as Map)['event_id'] == eventId,
    )) {
      return;
    }
    queue.add(jsonEncode(event));
    await preferences.setStringList(_storageKey, queue);
  }

  Future<int> flush(GovernmentApiClient api) async {
    final preferences = await SharedPreferences.getInstance();
    final queue = preferences.getStringList(_storageKey) ?? <String>[];
    if (queue.isEmpty) return 0;
    final keep = <String>[];
    var uploaded = 0;
    for (var index = 0; index < queue.length; index += 1) {
      final raw = queue[index];
      Map<String, dynamic>? event;
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) event = Map<String, dynamic>.from(decoded);
      } on Object {
        // Drop a corrupt local row; it cannot be reconstructed safely.
      }
      if (event == null) continue;
      final expiresAt =
          DateTime.tryParse(event['expires_at'] as String? ?? '')?.toUtc();
      if (expiresAt == null || !expiresAt.isAfter(DateTime.now().toUtc())) {
        continue;
      }
      try {
        await api.uploadCrowdReport(event);
        uploaded += 1;
      } on GovernmentApiException catch (error) {
        if (error.statusCode >= 500 || error.statusCode == 0) keep.add(raw);
      } on Object {
        keep.add(raw);
        keep.addAll(queue.skip(index + 1));
        break;
      }
    }
    await preferences.setStringList(_storageKey, keep);
    return uploaded;
  }
}
