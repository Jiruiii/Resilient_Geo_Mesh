import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../data/evacuation_models.dart';

class EvacuationRouteSheet extends StatelessWidget {
  const EvacuationRouteSheet({
    super.key,
    required this.route,
    required this.loading,
    required this.errorMessage,
    required this.stale,
    this.loadingMessage,
    this.updateNotice,
    this.destinationName,
    this.destinationKind = RouteDestinationKind.shelter,
    required this.onRecalculate,
    required this.onClose,
  });

  final EvacuationRouteResult? route;
  final bool loading;
  final String? errorMessage;
  final bool stale;
  final String? loadingMessage;
  final String? updateNotice;
  final String? destinationName;
  final RouteDestinationKind destinationKind;
  final VoidCallback? onRecalculate;
  final VoidCallback? onClose;

  bool get _evacuation => destinationKind == RouteDestinationKind.shelter;
  String get _title => _evacuation ? '逃生路線' : '步行路線';

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    elevation: 12,
    borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
    child: SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _header(context),
            const SizedBox(height: 10),
            if (destinationName != null) ...[
              Text('目的地：$destinationName'),
              const SizedBox(height: 8),
            ],
            if (!_evacuation) ...[
              const Text(
                '此路線僅供步行參考，不是官方疏散指示',
                key: ValueKey<String>('walking-route-disclaimer'),
              ),
              const SizedBox(height: 8),
            ],
            if (updateNotice != null) ...[
              Semantics(liveRegion: true, child: Text(updateNotice!)),
              const SizedBox(height: 8),
            ],
            if (loading)
              _loadingBody()
            else if (errorMessage != null)
              _errorBody(errorMessage!)
            else if (route == null)
              _errorBody('目前尚未取得路線結果')
            else
              _routeBody(route!),
          ],
        ),
      ),
    ),
  );

  Widget _header(BuildContext context) => Row(
    children: <Widget>[
      Expanded(
        child: Text(_title, style: Theme.of(context).textTheme.titleLarge),
      ),
      if (onClose != null)
        IconButton(
          tooltip: '關閉路線',
          onPressed: onClose,
          icon: const Icon(Icons.close),
        ),
    ],
  );

  Widget _loadingBody() => Semantics(
    liveRegion: true,
    label: '正在計算$_title',
    child: Row(
      children: <Widget>[
        const SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 10),
        Expanded(child: Text(loadingMessage ?? '正在計算$_title…')),
      ],
    ),
  );

  Widget _errorBody(String message) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Semantics(liveRegion: true, child: Text(message)),
      if (onRecalculate != null) ...<Widget>[
        const SizedBox(height: 12),
        _recalculateButton(),
      ],
    ],
  );

  Widget _routeBody(EvacuationRouteResult result) {
    final statusMessage = _statusMessage(result.status);
    if (statusMessage != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(liveRegion: true, child: Text(statusMessage)),
          if (result.warnings.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            ...result.warnings.map((warning) => Text(warning.message)),
          ],
          if (onRecalculate != null) ...<Widget>[
            const SizedBox(height: 12),
            _recalculateButton(),
          ],
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (stale) ...<Widget>[_staleNotice(), const SizedBox(height: 10)],
        Text('距離：${_distanceText(result.distanceM)}'),
        Text('預估步行時間：${_durationText(result.durationS)}'),
        const SizedBox(height: 10),
        Text('路網版本：${result.graphVersion ?? '無資料'}'),
        Text('事件快照：${result.eventSnapshotAt ?? '無資料'}'),
        if (result.warnings.isNotEmpty) ...<Widget>[
          const SizedBox(height: 12),
          const Text('路線警示'),
          ...result.warnings.map((warning) => Text(warning.message)),
        ],
        if (result.blockedEventIds.isNotEmpty) ...<Widget>[
          const SizedBox(height: 12),
          Text('受路線快照排除事件：${result.blockedEventIds.join('、')}'),
        ],
        if (stale && onRecalculate != null) ...<Widget>[
          const SizedBox(height: 12),
          _recalculateButton(),
        ],
      ],
    );
  }

  Widget _staleNotice() =>
      Semantics(liveRegion: true, child: const Text('路線資訊已變更，請重新計算'));

  Widget _recalculateButton() => ElevatedButton.icon(
    key: const ValueKey<String>('recalculate-evacuation-route'),
    onPressed: loading ? null : onRecalculate,
    icon: const Icon(Icons.refresh),
    label: const Text('重新計算'),
  );

  String? _statusMessage(EvacuationRouteStatus status) => switch (status) {
    EvacuationRouteStatus.ok => null,
    EvacuationRouteStatus.noRoute => '找不到可達路線',
    EvacuationRouteStatus.graphUnavailable => '離線路網尚未載入',
    EvacuationRouteStatus.invalidInput =>
      _evacuation ? '起點或避難所資料不完整' : '起點或目的地資料不完整',
  };

  String _distanceText(double? distanceM) {
    if (distanceM == null || !distanceM.isFinite || distanceM < 0) {
      return '無資料';
    }
    if (distanceM < 1000) return '${distanceM.round()} 公尺';
    return '${(distanceM / 1000).toStringAsFixed(1)} 公里';
  }

  String _durationText(double? durationS) {
    if (durationS == null || !durationS.isFinite || durationS < 0) {
      return '無資料';
    }
    return '${math.max(0, (durationS / 60).ceil())} 分鐘';
  }
}
