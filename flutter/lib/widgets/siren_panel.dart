import 'dart:async';

import 'package:flutter/material.dart';

import '../data/siren_controller.dart';
import 'map_layers.dart';

const sirenDisclaimer = '此功能只會讓本機發聲，不代表已聯絡 119 或救援單位。';
const sirenWebLimitation = '瀏覽器在背景分頁或鎖屏時不保證持續播放；無法偵測系統音量，請確認裝置未靜音。';

class SirenPanel extends StatefulWidget {
  const SirenPanel({super.key, required this.controller, this.clock});

  final SirenController controller;
  final DateTime Function()? clock;

  @override
  State<SirenPanel> createState() => _SirenPanelState();
}

class _SirenPanelState extends State<SirenPanel> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    unawaited(widget.controller.ensureNotificationPermissionRequested());
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.controller.status.phase == SirenPhase.playing) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final status = controller.status;
    final theme = Theme.of(context);
    final error = theme.colorScheme.error;
    final playing = status.phase == SirenPhase.playing || status.phase == SirenPhase.starting;
    final remaining = status.endsAt?.difference(widget.clock?.call() ?? DateTime.now()).inSeconds.clamp(0, 60);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (playing)
          SizedBox(
            height: 64,
            child: FilledButton.icon(
              key: const ValueKey<String>('siren-stop'),
              style: FilledButton.styleFrom(backgroundColor: error, textStyle: theme.textTheme.titleLarge),
              onPressed: status.phase == SirenPhase.playing ? controller.stop : null,
              icon: const Icon(Icons.stop_circle_outlined, size: 32),
              label: Text(status.phase == SirenPhase.starting ? '啟動中…' : '停止警報'),
            ),
          )
        else
          SizedBox(
            height: 64,
            child: FilledButton.icon(
              key: ValueKey<String>(status.phase == SirenPhase.idle ? 'siren-start' : 'siren-replay'),
              style: FilledButton.styleFrom(textStyle: theme.textTheme.titleLarge),
              onPressed: controller.start,
              icon: const Icon(MapIconCatalog.locatorSound, size: 30),
              label: Text(status.phase == SirenPhase.idle ? '發出定位警報聲' : '再次播放'),
            ),
          ),
        const SizedBox(height: 6),
        if (status.phase == SirenPhase.playing && remaining != null) Text('播放中，$remaining 秒後自動停止'),
        if (status.phase == SirenPhase.autoStopped) const Text('已播放 60 秒並自動停止'),
        if (controller.reasonText() != null)
          Text(controller.reasonText()!, style: TextStyle(color: error, fontWeight: FontWeight.w600)),
        for (final warning in controller.warningTexts()) Text(warning, style: TextStyle(color: error)),
        const Text(sirenDisclaimer, style: TextStyle(fontWeight: FontWeight.w600)),
        if (controller.isWeb) Text(sirenWebLimitation, style: theme.textTheme.bodySmall),
        if (status.phase == SirenPhase.failed || status.phase == SirenPhase.interrupted || status.phase == SirenPhase.autoStopped)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(key: const ValueKey<String>('siren-dismiss'), onPressed: controller.dismiss, child: const Text('關閉提示')),
          ),
      ],
    );
  }
}
