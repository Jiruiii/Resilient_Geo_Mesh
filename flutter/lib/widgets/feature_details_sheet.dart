import 'package:flutter/material.dart';

import '../data/attestation_index.dart';
import '../data/crowd_report_models.dart';
import '../data/display_time.dart';
import '../data/map_models.dart';
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
       corroboration = null;

  const FeatureDetailsSheet.event({
    super.key,
    required MeshEvent event,
    required this.onClose,
    this.corroboration,
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
              ...body,
            ],
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

  List<Widget> _eventBody(MeshEvent event) => <Widget>[
    if (isCrowdEvent(event)) ...<Widget>[
      _VerificationNotice(event.verification ?? CrowdVerification.unverified),
      _DetailLine('回報類別', crowdCategoryLabel(event.attributes?['category'])),
      _DetailLine('描述', _text(event.attributes?['description'])),
      if (corroboration != null) _DetailLine('附近回報', corroboration!),
    ],
    _DetailLine('事件類型', _text(event.eventType)),
    _DetailLine('嚴重度', _text(event.severity)),
    _DetailLine('位置／範圍', _geometryText(event.geometry)),
    _DetailLine('來源', _text(event.source)),
    _DetailLine('發佈時間', _text(event.issuedAt)),
    _DetailLine('到期時間', _text(event.expiresAt)),
    _DetailLine('資料狀態', _eventState(event)),
  ];
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
  'EXPIRED' => '已過期',
  'UNVERIFIED' => '未驗證',
  _ => '無資料',
};

String _geometryText(MapGeometry? geometry) => switch (geometry) {
  PointGeometry(:final point) => '點位（${point.latitude}, ${point.longitude}）',
  LineStringGeometry(:final points) => '線段（${points.length} 個座標）',
  PolygonGeometry(:final rings) => '區域（${rings.length} 個環）',
  null => '無資料',
};

String _listText(Object? value) {
  if (value is List) {
    final values = value.whereType<String>().where((item) => item.isNotEmpty);
    return values.isEmpty ? '無資料' : values.join('、');
  }
  return _text(value);
}
