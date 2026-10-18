import 'package:flutter/material.dart';

/// Compact, provider-neutral controls.  The map itself keeps numeric zoom;
/// people see the common 0–100% representation instead.
class MapZoomControls extends StatelessWidget {
  static const double maxPanelWidth = 184;

  const MapZoomControls({
    super.key,
    required this.zoomPercentage,
    required this.onZoomPercentageChanged,
    this.onOpenLayerSettings,
    this.onRequestLocation,
    this.onRecenter,
  });

  final int zoomPercentage;
  final ValueChanged<int> onZoomPercentageChanged;
  final VoidCallback? onOpenLayerSettings;
  final VoidCallback? onRequestLocation;
  final VoidCallback? onRecenter;

  @override
  Widget build(BuildContext context) {
    final clamped = zoomPercentage.clamp(0, 100);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: maxPanelWidth),
      child: Material(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.94),
        elevation: 4,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  IconButton(
                    tooltip: '放大',
                    constraints: const BoxConstraints.tightFor(
                      width: 32,
                      height: 32,
                    ),
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    onPressed:
                        () => onZoomPercentageChanged(
                          (clamped + 10).clamp(0, 100),
                        ),
                    icon: const Icon(Icons.add),
                  ),
                  Text('縮放 $clamped%'),
                  IconButton(
                    tooltip: '縮小',
                    constraints: const BoxConstraints.tightFor(
                      width: 32,
                      height: 32,
                    ),
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    onPressed:
                        () => onZoomPercentageChanged(
                          (clamped - 10).clamp(0, 100),
                        ),
                    icon: const Icon(Icons.remove),
                  ),
                ],
              ),
              SizedBox(
                width: 156,
                child: Slider(
                  value: clamped.toDouble(),
                  min: 0,
                  max: 100,
                  divisions: 100,
                  label: '$clamped%',
                  onChanged: (value) => onZoomPercentageChanged(value.round()),
                ),
              ),
              if (onOpenLayerSettings != null ||
                  onRequestLocation != null ||
                  onRecenter != null)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (onOpenLayerSettings != null)
                      Semantics(
                        container: true,
                        button: true,
                        label: '圖層設定',
                        onTap: onOpenLayerSettings,
                        child: ExcludeSemantics(
                          child: IconButton(
                            tooltip: '圖層設定',
                            visualDensity: VisualDensity.compact,
                            onPressed: onOpenLayerSettings,
                            icon: const Icon(Icons.layers_outlined),
                          ),
                        ),
                      ),
                    if (onRequestLocation != null)
                      IconButton(
                        tooltip: '目前位置',
                        visualDensity: VisualDensity.compact,
                        onPressed: onRequestLocation,
                        icon: const Icon(Icons.my_location),
                      ),
                    if (onRecenter != null)
                      IconButton(
                        tooltip: '回到預設',
                        visualDensity: VisualDensity.compact,
                        onPressed: onRecenter,
                        icon: const Icon(Icons.center_focus_strong),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
