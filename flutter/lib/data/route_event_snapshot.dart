import 'dart:convert';

import 'evacuation_models.dart';
import 'map_models.dart';

/// Only events consumed by the native hazard overlay or shelter status resolver,
/// plus the supply point being walked to when [destinationSupplyKey] is set.
/// Capturing the state at a fixed time detects expiry even without a new snapshot.
class RouteEventSnapshot {
  RouteEventSnapshot(
    Iterable<MeshEvent> events,
    DateTime now, {
    String? destinationSupplyKey,
  }) {
    for (final event in events) {
      if (event.isRetiredShelterStatus) continue;
      final destination =
          destinationSupplyKey != null &&
          isRoutableSupplyEvent(event) &&
          supplyEventKey(event) == destinationSupplyKey;
      final kind = destination ? '物資狀態' : _kind(event);
      if (kind == null) continue;
      final expires = DateTime.tryParse(event.expiresAt ?? '');
      final state =
          event.applyState == 'EXPIRED' ||
                  (expires != null && !expires.isAfter(now))
              ? 'EXPIRED'
              : event.applyState;
      // A new supply version replaces the old one under the same key, so the
      // change reads as an update rather than a removal plus an addition.
      final key = destination ? destinationSupplyKey : meshEventIdentity(event);
      final previous = _entries[key];
      if (destination &&
          previous != null &&
          previous.$4 > (event.eventVersion ?? 0)) {
        continue;
      }
      _entries[key] = (kind, state, event.payloadHash, event.eventVersion ?? 0);
    }
  }

  final _entries = <String, (String, String?, String?, int)>{};

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
    // Rescue points are people needing help, not hazards (HazardOverlay ignores them).
    if (event.namespace == 'crowd.rescue') return null;
    if (event.namespace?.startsWith('crowd.') == true) return '民眾警示';
    return switch (event.eventType) {
      'ROAD_STATUS' => '道路狀態',
      'SHELTER_STATUS' => '避難所狀態',
      'FLOOD_WARNING' || 'LANDSLIDE_RISK' || 'DEBRIS_FLOW_WARNING' => '危險區域',
      _ => null,
    };
  }

  static DateTime? nextExpiry(
    Iterable<MeshEvent> events,
    DateTime now, {
    String? destinationSupplyKey,
  }) {
    DateTime? earliest;
    for (final event in events) {
      final destination =
          destinationSupplyKey != null &&
          isRoutableSupplyEvent(event) &&
          supplyEventKey(event) == destinationSupplyKey;
      if ((!destination && _kind(event) == null) ||
          event.applyState == 'EXPIRED') {
        continue;
      }
      final expires = DateTime.tryParse(event.expiresAt ?? '');
      if (expires == null || !expires.isAfter(now)) continue;
      if (earliest == null || expires.isBefore(earliest)) earliest = expires;
    }
    return earliest;
  }
}
