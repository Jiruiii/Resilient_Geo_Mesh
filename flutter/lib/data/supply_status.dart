import 'map_models.dart';

bool isSupplyEvent(MeshEvent event) => event.eventType == 'SUPPLY_STATUS';

bool isSupplyStationEvent(MeshEvent event) =>
    event.namespace == 'official.announcement' &&
    event.source == 'GOVERNMENT' &&
    event.attributes?['category'] == 'SUPPLY_STATION';

/// Unknown and expired inventory must never look like available stock.
class SupplyStatus {
  SupplyStatus(this.event);
  final MeshEvent event;
  Map<String, dynamic> get data => event.attributes ?? const {};
  String get name => _text(data['name']) ?? '物資發放點';
  String get address => _text(data['address']) ?? '未提供地址';
  String get issuer => _text(data['issuer']) ?? event.source ?? '來源未知';
  String get items {
    final values = data['items'];
    final label =
        values is List
            ? values
                .whereType<String>()
                .map((s) => s.trim())
                .where((s) => s.isNotEmpty)
                .join('、')
            : '';
    return label.isEmpty ? '物資種類未知' : label;
  }

  String statusAt([DateTime? now]) {
    if (!event.isCurrentAt(now)) return '已過期或未查證，供應狀態未知';
    return switch (data['status']) {
      'AVAILABLE' => '供應中',
      'PAUSED' => '暫停發放',
      'EXHAUSTED' => '已發完',
      'CLOSED' => '已結束',
      _ => '供應狀態未知',
    };
  }

  String get quantity {
    final count = data['quantity'];
    if (!event.isCurrentAt() || count is! int || count < 0) return '未知';
    return '$count ${_text(data['unit']) ?? '份'}';
  }

  String get openingHours => _text(data['opening_hours']) ?? '未提供，請以現場公告為準';
  bool get drill =>
      data['exercise'] == true || event.namespace?.startsWith('drill.') == true;
  static String? _text(Object? value) =>
      value is String && value.trim().isNotEmpty ? value.trim() : null;
}

List<MeshEvent> filterMapEventLayers(
  List<MeshEvent> events, {
  required bool incidents,
  required bool supplies,
}) => events
    .where(
      (event) =>
          isSupplyEvent(event) || isSupplyStationEvent(event)
              ? supplies
              : incidents,
    )
    .toList(growable: false);
