import 'dart:convert';

import 'map_models.dart';

/// Only events consumed by the native hazard overlay or shelter status resolver.
/// Capturing the state at a fixed time detects expiry even without a new snapshot.
class RouteEventSnapshot {
  RouteEventSnapshot(Iterable<MeshEvent> events, DateTime now) {
    for (final event in events) {
      if (event.isRetiredShelterStatus) continue;
      final kind = _kind(event);
      if (kind == null) continue;
      final expires = DateTime.tryParse(event.expiresAt ?? '');
      final state =
          event.applyState == 'EXPIRED' ||
                  (expires != null && !expires.isAfter(now))
              ? 'EXPIRED'
              : event.applyState;
      _entries[meshEventIdentity(event)] = (kind, state, event.payloadHash);
    }
  }

  final _entries = <String, (String, String?, String?)>{};

  String get fingerprint {
    final keys = _entries.keys.toList()..sort();
    return jsonEncode([
      for (final key in keys) [key, _entries[key]!.$2, _entries[key]!.$3],
    ]);
  }

  String? changeReason(RouteEventSnapshot next) {
    if (fingerprint == next.fingerprint) return null;
    final reasons = <String>{};
    for (final key in {..._entries.keys, ...next._entries.keys}) {
      final before = _entries[key];
      final after = next._entries[key];
      if (before == after) continue;
      if (before != null && before.$2 != 'EXPIRED' && after?.$2 == 'EXPIRED') {
        reasons.add('事件到期');
      } else {
        reasons.add('${(after ?? before)!.$1}更新');
      }
    }
    return reasons.join('、');
  }

  static String? _kind(MeshEvent event) {
    if (event.namespace?.startsWith('crowd.') == true) return '民眾警示';
    return switch (event.eventType) {
      'ROAD_STATUS' => '道路狀態',
      'SHELTER_STATUS' => '避難所狀態',
      'FLOOD_WARNING' || 'LANDSLIDE_RISK' || 'DEBRIS_FLOW_WARNING' => '危險區域',
      _ => null,
    };
  }

  static DateTime? nextExpiry(Iterable<MeshEvent> events, DateTime now) {
    DateTime? earliest;
    for (final event in events) {
      if (_kind(event) == null || event.applyState == 'EXPIRED') continue;
      final expires = DateTime.tryParse(event.expiresAt ?? '');
      if (expires == null || !expires.isAfter(now)) continue;
      if (earliest == null || expires.isBefore(earliest)) earliest = expires;
    }
    return earliest;
  }
}
