import 'package:flutter/material.dart';
import '../data/evacuation_models.dart';

class LayerFilterPanel extends StatelessWidget {
  const LayerFilterPanel({
    super.key,
    required this.showShelters,
    required this.showMedical,
    required this.showEvents,
    required this.emergencyModeEnabled,
    required this.onSheltersChanged,
    required this.onMedicalChanged,
    required this.onEventsChanged,
    required this.onEmergencyModeChanged,
    this.disasterType,
    this.onDisasterTypeChanged,
    this.onOpenSyncStatus,
    this.showSupplies = true,
    this.onSuppliesChanged,
  });

  final bool showShelters;
  final bool showMedical;
  final bool showEvents;
  final bool showSupplies;
  final ValueChanged<bool>? onSuppliesChanged;
  final bool emergencyModeEnabled;
  final ValueChanged<bool> onSheltersChanged;
  final ValueChanged<bool> onMedicalChanged;
  final ValueChanged<bool> onEventsChanged;
  final ValueChanged<bool> onEmergencyModeChanged;
  final DisasterType? disasterType;
  final ValueChanged<DisasterType?>? onDisasterTypeChanged;
  final VoidCallback? onOpenSyncStatus;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('圖層設定', style: Theme.of(context).textTheme.titleLarge),
            SwitchListTile(
              title: const Text('避難所'),
              value: showShelters,
              onChanged: onSheltersChanged,
            ),
            SwitchListTile(
              title: const Text('醫療院所'),
              value: showMedical,
              onChanged: onMedicalChanged,
            ),
            SwitchListTile(
              title: const Text('災情事件'),
              value: showEvents,
              onChanged: onEventsChanged,
            ),
            const Divider(),
            if (onSuppliesChanged != null)
              SwitchListTile(
                title: const Text('物資發放點'),
                value: showSupplies,
                onChanged: onSuppliesChanged,
              ),
            if (onDisasterTypeChanged != null) ...[
              DropdownButtonFormField<String>(
                key: const ValueKey('disaster-type-selector'),
                value: disasterType?.wireValue ?? 'all',
                decoration: const InputDecoration(labelText: '避難災害情境'),
                items: [
                  const DropdownMenuItem(value: 'all', child: Text('不限災害類型')),
                  ...DisasterType.values.map(
                    (type) => DropdownMenuItem(
                      value: type.wireValue,
                      child: Text(type.label),
                    ),
                  ),
                ],
                onChanged:
                    (value) => onDisasterTypeChanged!(
                      value == 'all'
                          ? null
                          : DisasterType.values.firstWhere(
                            (type) => type.wireValue == value,
                          ),
                    ),
              ),
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('用於避難所推薦與路線規劃；類別不明的場所會附警告，不代表已確認適用。'),
              ),
            ],
            SwitchListTile(
              title: const Text('緊急模式'),
              value: emergencyModeEnabled,
              onChanged: onEmergencyModeChanged,
            ),
            if (onOpenSyncStatus != null)
              ListTile(
                leading: const Icon(Icons.sync),
                title: const Text('同步狀態'),
                trailing: const Icon(Icons.chevron_right),
                onTap: onOpenSyncStatus,
              ),
          ],
        ),
      ),
    ),
  );
}
