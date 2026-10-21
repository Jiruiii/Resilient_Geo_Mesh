import 'package:flutter/material.dart';

import '../data/taiwan_administrative_area_directory.dart';
import '../widgets/administrative_area_selector.dart';

class NotificationAreaSelectionScreen extends StatefulWidget {
  const NotificationAreaSelectionScreen({
    super.key,
    required this.directory,
    required this.selectedAreaIds,
    required this.onSave,
  });

  final TaiwanAdministrativeAreaDirectory directory;
  final Set<String> selectedAreaIds;
  final Future<void> Function(Set<String> areaIds) onSave;

  @override
  State<NotificationAreaSelectionScreen> createState() =>
      _NotificationAreaSelectionScreenState();
}

class _NotificationAreaSelectionScreenState
    extends State<NotificationAreaSelectionScreen> {
  late Set<String> _selectedAreaIds;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _selectedAreaIds = widget.directory.normalizeSelection(
      widget.selectedAreaIds,
    );
  }

  Future<void> _chooseAreas() async {
    final selected = await AdministrativeAreaSelector.show(
      context,
      directory: widget.directory,
      selectedIds: _selectedAreaIds,
      allowNational: true,
      title: '通知接收區域',
    );
    if (selected != null && mounted) {
      setState(() => _selectedAreaIds = selected);
    }
  }

  Future<void> _save() async {
    if (_selectedAreaIds.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('請至少選擇一個接收區域')));
      return;
    }
    setState(() => _saving = true);
    try {
      await widget.onSave(_selectedAreaIds);
      if (mounted) Navigator.of(context).pop();
    } on Object {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('儲存通知接收區域失敗')));
    }
  }

  List<String> get _selectedNames => _selectedAreaIds
      .map(widget.directory.displayName)
      .whereType<String>()
      .toList(growable: false);

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('通知接收區域')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: <Widget>[
        Text(
          '選擇要顯示在本機通知清單與未讀數的行政區。只會篩選已同步到本機的事件，不會改變地圖或政府資料更新範圍。',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 20),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '目前選取 ${_selectedAreaIds.length} 個範圍',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 12),
                if (_selectedNames.isEmpty)
                  const Text('尚未選擇區域')
                else
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: _selectedNames
                        .map((name) => Chip(label: Text(name)))
                        .toList(growable: false),
                  ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const ValueKey('notification-area-choose'),
                  onPressed: _chooseAreas,
                  icon: const Icon(Icons.location_on_outlined),
                  label: const Text('選擇行政區'),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
    bottomNavigationBar: SafeArea(
      minimum: const EdgeInsets.all(16),
      child: FilledButton(
        key: const ValueKey('notification-area-save'),
        onPressed: _saving ? null : _save,
        child: Text(_saving ? '儲存中…' : '儲存設定'),
      ),
    ),
  );
}
