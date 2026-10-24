import 'package:flutter/material.dart';

import '../data/map_basemap.dart';

/// Base map choice shared by the profile preferences and the map layer sheet.
class BasemapSelector extends StatelessWidget {
  const BasemapSelector({
    super.key,
    required this.mode,
    required this.emapVisible,
    required this.onChanged,
  });

  final MapBasemapMode mode;
  final bool emapVisible;
  final ValueChanged<MapBasemapMode> onChanged;

  String get _status =>
      emapVisible
          ? '目前：國土測繪圖資（${MapBasemap.emapAttribution}）'
          : '目前：離線 OSM';

  @override
  Widget build(BuildContext context) =>
      DropdownButtonFormField<MapBasemapMode>(
        key: const ValueKey<String>('basemap-selector'),
        value: mode,
        isExpanded: true,
        decoration: InputDecoration(labelText: '底圖', helperText: _status),
        items: <DropdownMenuItem<MapBasemapMode>>[
          for (final option in MapBasemapMode.values)
            DropdownMenuItem(
              value: option,
              child: Text(
                '${option.label}｜${option.description}',
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        selectedItemBuilder:
            (context) => <Widget>[
              for (final option in MapBasemapMode.values) Text(option.label),
            ],
        onChanged: (value) {
          if (value != null) onChanged(value);
        },
      );
}
