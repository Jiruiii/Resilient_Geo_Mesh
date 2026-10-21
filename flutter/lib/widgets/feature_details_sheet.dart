import 'package:flutter/material.dart';

import '../data/attestation_index.dart';
import '../data/crowd_report_models.dart';
import '../data/display_time.dart';
import '../data/government_announcement_time.dart';
import '../data/map_models.dart';
import '../data/rescue_request_models.dart';
import '../data/supply_status.dart';
import 'map_layers.dart';

class FeatureDetailsSheet extends StatelessWidget {
  const FeatureDetailsSheet.feature({
    super.key,
    required StaticFeature feature,
    required this.snapshotAt,
    required this.onClose,
    this.onPlanEvacuationRoute,
  }) : _feature = feature,
       _event = null,
       corroboration = null,
       confirmedEarlierVersion = false;

  const FeatureDetailsSheet.event({
    super.key,
    required MeshEvent event,
    required this.onClose,
    this.corroboration,
    this.confirmedEarlierVersion = false,
  }) : _event = event,
       _feature = null,
       snapshotAt = null,
       onPlanEvacuationRoute = null;

  final StaticFeature? _feature;
  final MeshEvent? _event;
  final String? snapshotAt;
  final VoidCallback onClose;
  final VoidCallback? onPlanEvacuationRoute;

  /// 「N 人回報」 for a crowd report several devices agree on; never a verdict.
  final String? corroboration;

  /// True when the official attestation confirmed an earlier version of this
  /// request, so the current verification badge should not be read as current.
  final bool confirmedEarlierVersion;

  @override
  Widget build(BuildContext context) {
    final feature = _feature;
    final event = _event;
    final body = feature != null ? _featureBody(feature) : _eventBody(event!);
    final title = feature != null ? featureName(feature) : eventName(event!);
    return Material(
      color: Theme.of(context).colorScheme.surface,
      elevation: 12,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.78,
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 12, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Center(
                  child: Container(
                    height: 4,
                    width: 36,
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.outlineVariant,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        title,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                    IconButton(
                      tooltip: '關閉詳情',
                      onPressed: onClose,
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Flexible(
                  fit: FlexFit.loose,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: body,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _featureBody(StaticFeature feature) {
    final details = feature.details;
    final kind = feature.kind;
    if (kind == 'shelter') {
      return <Widget>[
        _DetailLine('地址', _text(details['address'])),
        _DetailLine('預計收容人數', _peopleText(details['capacity'])),
        _DetailLine('適用災害類別', _listText(details['disaster_types'])),
        _DetailLine('來源', _text(details['source'])),
        _DetailLine('更新時間', formatUpdateTime(snapshotAt)),
        if (onPlanEvacuationRoute != null) ...<Widget>[
          const SizedBox(height: 4),
          SizedBox(
            width: double.infinity,
            height: 36,
            child: OutlinedButton.icon(
              key: const ValueKey<String>('plan-evacuation-route'),
              onPressed: onPlanEvacuationRoute,
              style: OutlinedButton.styleFrom(
                minimumSize: Size.zero,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              icon: const Icon(Icons.directions_walk),
              label: const Text('規劃逃生路線'),
            ),
          ),
        ],
      ];
    }
    if (kind == 'medical') {
      return <Widget>[
        _DetailLine('類型', _text(details['facility_type'])),
        _DetailLine('地址', _text(details['address'])),
        _DetailLine('來源', _text(details['source'])),
        _DetailLine('更新時間', formatUpdateTime(snapshotAt)),
        if (feature.geometry is PointGeometry)
          const _WalkingRouteUnavailableButton(),
      ];
    }
    if (kind == 'medical-directory') {
      final located = details['geometry_status'] == 'located';
      return <Widget>[
        _DetailLine('地址', _text(details['address'])),
        _DetailLine('地圖定位', located ? '已連到核實點位' : '尚未定位，未顯示地圖標記'),
        _DetailLine('資料來源', '衛生福利部醫療機構主檔'),
      ];
    }
    return <Widget>[
      _DetailLine('類型', _text(kind)),
      _DetailLine('來源', _text(details['source'])),
    ];
  }

  List<Widget> _eventBody(MeshEvent event) {
    final rescue = RescueRequestView.fromEvent(event);
    if (rescue != null) return _rescueBody(event, rescue);
    final cwaWarning = event.source?.toUpperCase() == 'CWA';
    final affectedArea = event.attributes?['affected_area'];
    final areaReference =
        cwaWarning &&
        event.attributes?['map_location_kind'] == 'area_reference' &&
        event.geometry is PointGeometry;
    return <Widget>[
      if (event.attributes?['exercise'] == true ||
          event.namespace?.startsWith('drill.') == true)
        const Text(
          '演練資料，非真實災情或政府公告',
          style: TextStyle(fontWeight: FontWeight.bold),
        ),
      if (isSupplyEvent(event)) ...[
        _DetailLine('發放狀態', SupplyStatus(event).statusAt()),
        _DetailLine(
          '物資',
          SupplyStatus(event).items.isEmpty ? '未知' : SupplyStatus(event).items,
        ),
        _DetailLine('剩餘數量', SupplyStatus(event).quantity),
        _DetailLine('發放時間', SupplyStatus(event).openingHours),
        _DetailLine('地址', SupplyStatus(event).address),
        _DetailLine('發布單位', SupplyStatus(event).issuer),
        const Text('供應資訊可能已變更；未知數量不代表沒有物資。'),
        if (event.geometry is PointGeometry)
          const _WalkingRouteUnavailableButton(),
      ],
      if (isCrowdEvent(event)) ...<Widget>[
        _VerificationNotice(event.verification ?? CrowdVerification.unverified),
        _DetailLine('回報類別', crowdCategoryLabel(event.attributes?['category'])),
        _DetailLine('描述', _text(event.attributes?['description'])),
        if (corroboration != null) _DetailLine('附近回報', corroboration!),
      ],
      if (event.namespace == 'official.announcement') ...<Widget>[
        _DetailLine(
          '公告類別',
          governmentAnnouncementCategoryLabel(event.attributes?['category']),
        ),
        if (event.attributes?['content'] is String)
          _DetailLine('公告內容', _text(event.attributes?['content'])),
        if (isSupplyStationEvent(event) && event.geometry is PointGeometry)
          const _WalkingRouteUnavailableButton(),
      ],
      _DetailLine('事件類型', _text(event.eventType)),
      if (!isSupplyStationEvent(event))
        _DetailLine('嚴重度', _text(event.severity)),
      if ((cwaWarning || event.isNcdrMultiAreaWarning) &&
          affectedArea is String &&
          affectedArea.trim().isNotEmpty)
        _DetailLine(
          '影響範圍',
          '${affectedArea.trim()}${event.attributes?['coverage_level'] == 'county' ? '（縣市級警報）' : ''}',
        ),
      if (event.isNcdrMultiAreaWarning)
        _DetailLine(
          '地圖範圍',
          event.hasCompleteNcdrAreaMask
              ? '警報涵蓋行政區（非精確風害位置）'
              : '部分影響區域缺少邊界，未顯示遮罩',
        ),
      if (areaReference) const _DetailLine('地圖位置', '影響範圍參考點（非告警發生的精確位置）'),
      _DetailLine(
        areaReference ? '地圖參考座標' : '位置／範圍',
        _geometryText(event.geometry),
      ),
      _DetailLine('來源', _text(event.source)),
      if (event.hasCwaWarningValidTime) const _DetailLine('發布時間', '來源未提供'),
      _DetailLine(
        event.hasCwaWarningValidTime ? '影響時段開始' : '發佈時間',
        event.hasCwaWarningValidTime
            ? _taiwanEventTime(event.issuedAt)
            : _text(event.issuedAt),
      ),
      _DetailLine(
        event.hasCwaWarningValidTime ? '影響時段結束' : '到期時間',
        event.hasCwaWarningValidTime
            ? _taiwanEventTime(event.expiresAt)
            : _text(event.expiresAt),
      ),
      _DetailLine('資料狀態', _eventState(event)),
    ];
  }

  List<Widget> _rescueBody(
    MeshEvent event,
    RescueRequestView rescue,
  ) => <Widget>[
    _VerificationNotice(event.verification ?? CrowdVerification.unverified),
    if (confirmedEarlierVersion)
      const Padding(
        padding: EdgeInsets.only(bottom: 2),
        child: Text(
          '官方確認的是先前版本，最新內容未經查證',
          key: ValueKey<String>('rescue-confirmed-earlier-version'),
        ),
      ),
    _DetailLine('求救類型', rescue.type.label),
    _DetailLine(
      '急迫程度',
      '${rescue.urgency.label}（${rescueUrgencyReason(rescue.type, rescue.triage, rescue.subject)}）',
    ),
    _DetailLine('求救狀態', rescue.status.label),
    _DetailLine('求救對象', rescue.subject.label),
    _DetailLine('人數', '${rescue.peopleCount} 人'),
    _DetailLine('描述', _text(rescue.description)),
    _DetailLine(
      '位置來源',
      event.attributes?['location_source'] == 'MAP_PICK' ? '地圖選點' : '目前位置',
    ),
    _DetailLine('最後更新', formatUpdateTime(event.issuedAt)),
    _DetailLine('到期時間', formatUpdateTime(event.expiresAt)),
    const Padding(
      padding: EdgeInsets.only(top: 8),
      child: Text(
        '未經查證，不代表已派遣救援',
        key: ValueKey<String>('rescue-not-dispatched'),
      ),
    ),
  ];
}

class _WalkingRouteUnavailableButton extends StatelessWidget {
  const _WalkingRouteUnavailableButton();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: SizedBox(
      width: double.infinity,
      height: 36,
      child: OutlinedButton.icon(
        key: const ValueKey<String>('plan-walking-route'),
        onPressed:
            () => showDialog<void>(
              context: context,
              builder:
                  (dialogContext) => AlertDialog(
                    title: const Text('路線規劃尚未開放'),
                    content: const Text('此地點的步行路線規劃尚未開放'),
                    actions: <Widget>[
                      TextButton(
                        onPressed: () => Navigator.of(dialogContext).pop(),
                        child: const Text('知道了'),
                      ),
                    ],
                  ),
            ),
        style: OutlinedButton.styleFrom(
          minimumSize: Size.zero,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        icon: const Icon(Icons.directions_walk),
        label: const Text('規劃步行路線'),
      ),
    ),
  );
}

class _DetailLine extends StatelessWidget {
  const _DetailLine(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Text('$label：$value'),
  );
}

String _text(Object? value) {
  if (value == null) return '無資料';
  if (value is String && value.isEmpty) return '無資料';
  return value.toString();
}

String _peopleText(Object? value) {
  final text = _text(value);
  return text == '無資料' ? text : '$text人';
}

/// Crowd reports always carry a visible verification line, so an unverified
/// report can never read like official data.
class _VerificationNotice extends StatelessWidget {
  const _VerificationNotice(this.verification);

  final CrowdVerification verification;

  @override
  Widget build(BuildContext context) {
    final color = switch (verification) {
      CrowdVerification.confirmed => confirmedCrowdEventColor,
      CrowdVerification.refuted => Theme.of(context).colorScheme.error,
      CrowdVerification.unverified => unverifiedEventColor,
    };
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 2),
      child: Row(
        children: <Widget>[
          Icon(
            verification == CrowdVerification.confirmed
                ? Icons.verified_outlined
                : Icons.info_outline,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              crowdVerificationLabel(verification),
              key: const ValueKey<String>('crowd-verification-notice'),
              style: TextStyle(color: color, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

String _eventState(MeshEvent event) => switch (event.effectiveApplyState) {
  'CURRENT' => '有效',
  'UPCOMING' => '尚未生效',
  'EXPIRED' => '已過期',
  'UNVERIFIED' => '未驗證',
  _ => '無資料',
};

String _taiwanEventTime(String? value) {
  final parsed = DateTime.tryParse(value ?? '');
  return parsed == null
      ? _text(value)
      : GovernmentAnnouncementTime.formatTaiwan(parsed.toUtc());
}

String _geometryText(MapGeometry? geometry) => switch (geometry) {
  PointGeometry(:final point) => '點位（${point.latitude}, ${point.longitude}）',
  LineStringGeometry(:final points) => '線段（${points.length} 個座標）',
  PolygonGeometry(:final rings) => '區域（${rings.length} 個環）',
  MultiPolygonGeometry(:final polygons) => '區域（${polygons.length} 個分離區塊）',
  null => '無資料',
};

String _listText(Object? value) {
  if (value is List) {
    final values = value.whereType<String>().where((item) => item.isNotEmpty);
    return values.isEmpty ? '無資料' : values.join('、');
  }
  return _text(value);
}
