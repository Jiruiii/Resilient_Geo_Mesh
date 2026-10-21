import 'package:flutter/material.dart';

import '../data/taiwan_administrative_area_directory.dart';

class AdministrativeAreaSelector {
  const AdministrativeAreaSelector._();

  static Future<Set<String>?> show(
    BuildContext context, {
    required TaiwanAdministrativeAreaDirectory directory,
    Set<String> selectedIds = const <String>{},
    bool allowNational = false,
    String title = '選擇行政區',
  }) => showDialog<Set<String>>(
    context: context,
    builder:
        (_) => _AdministrativeAreaSelectorDialog(
          directory: directory,
          selectedIds: selectedIds,
          allowNational: allowNational,
          title: title,
        ),
  );
}

class _AdministrativeAreaSelectorDialog extends StatefulWidget {
  const _AdministrativeAreaSelectorDialog({
    required this.directory,
    required this.selectedIds,
    required this.allowNational,
    required this.title,
  });

  final TaiwanAdministrativeAreaDirectory directory;
  final Set<String> selectedIds;
  final bool allowNational;
  final String title;

  @override
  State<_AdministrativeAreaSelectorDialog> createState() =>
      _AdministrativeAreaSelectorDialogState();
}

class _AdministrativeAreaSelectorDialogState
    extends State<_AdministrativeAreaSelectorDialog> {
  final TextEditingController _searchController = TextEditingController();
  late Set<String> _selectedIds;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _selectedIds = widget.directory.normalizeSelection(widget.selectedIds);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _toggle(String areaId) {
    setState(() {
      if (areaId == TaiwanAdministrativeAreaDirectory.nationalAreaId) {
        _selectedIds =
            _selectedIds.contains(areaId) ? <String>{} : <String>{areaId};
        return;
      }
      final area = widget.directory.areaById(areaId);
      if (area == null) return;
      final next = <String>{..._selectedIds}
        ..remove(TaiwanAdministrativeAreaDirectory.nationalAreaId);
      if (area.isCounty) {
        final currentlySelected = _isAreaSelected(area);
        if (currentlySelected) {
          next.remove(areaId);
          next.removeAll(
            widget.directory.childrenOf(areaId).map((child) => child.areaId),
          );
        } else {
          next.removeAll(
            widget.directory.childrenOf(areaId).map((child) => child.areaId),
          );
          next.add(areaId);
        }
      } else if (next.contains(areaId)) {
        next.remove(areaId);
      } else if (next.remove(area.parentAreaId)) {
        next.addAll(
          widget.directory
              .childrenOf(area.parentAreaId!)
              .where((child) => child.areaId != areaId)
              .map((child) => child.areaId),
        );
      } else {
        next.add(areaId);
      }
      _selectedIds = widget.directory.normalizeSelection(next);
    });
  }

  bool _isAreaSelected(TaiwanAdministrativeArea area) {
    if (area.isCounty) {
      if (_selectedIds.contains(area.areaId)) return true;
      final children = widget.directory.childrenOf(area.areaId);
      return children.isNotEmpty &&
          children.every((child) => _selectedIds.contains(child.areaId));
    }
    return _selectedIds.contains(area.areaId) ||
        (area.isTown && _selectedIds.contains(area.parentAreaId));
  }

  List<TaiwanAdministrativeArea> get _searchResults {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return const <TaiwanAdministrativeArea>[];
    return widget.directory.areas
        .where((area) => area.displayName.toLowerCase().contains(query))
        .toList(growable: false);
  }

  void _confirm() => Navigator.of(
    context,
  ).pop<Set<String>>(widget.directory.normalizeSelection(_selectedIds));

  void _cancel() => Navigator.of(context).pop<Set<String>>();

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    child: Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        leading: IconButton(
          key: const ValueKey('administrative-area-cancel'),
          tooltip: '取消',
          onPressed: _cancel,
          icon: const Icon(Icons.close),
        ),
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              key: const ValueKey('administrative-area-search'),
              controller: _searchController,
              onChanged: (value) => setState(() => _query = value),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: '搜尋縣市或鄉鎮市區',
                suffixIcon:
                    _query.isEmpty
                        ? null
                        : IconButton(
                          tooltip: '清除搜尋',
                          onPressed: () {
                            _searchController.clear();
                            setState(() => _query = '');
                          },
                          icon: const Icon(Icons.clear),
                        ),
                border: const OutlineInputBorder(),
              ),
            ),
          ),
          if (widget.allowNational)
            CheckboxListTile(
              key: const ValueKey('administrative-area-option-tw.national'),
              value: _selectedIds.contains(
                TaiwanAdministrativeAreaDirectory.nationalAreaId,
              ),
              title: const Text('全台灣'),
              controlAffinity: ListTileControlAffinity.leading,
              onChanged:
                  (_) =>
                      _toggle(TaiwanAdministrativeAreaDirectory.nationalAreaId),
            ),
          const Divider(height: 1),
          Expanded(child: _buildAreaList()),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('已選擇 ${_selectedIds.length} 個範圍'),
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        minimum: const EdgeInsets.all(12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: <Widget>[
            TextButton(onPressed: _cancel, child: const Text('取消')),
            const SizedBox(width: 8),
            FilledButton(onPressed: _confirm, child: const Text('確認')),
          ],
        ),
      ),
    ),
  );

  Widget _buildAreaList() {
    if (_query.trim().isNotEmpty) {
      final results = _searchResults;
      if (results.isEmpty) {
        return const Center(child: Text('找不到符合的行政區'));
      }
      return ListView.builder(
        itemCount: results.length,
        itemBuilder: (context, index) => _areaOption(results[index]),
      );
    }
    return ListView.builder(
      itemCount: widget.directory.counties.length,
      itemBuilder: (context, index) {
        final county = widget.directory.counties[index];
        return ExpansionTile(
          key: ValueKey('administrative-area-group-${county.areaId}'),
          leading: Checkbox(
            key: ValueKey('administrative-area-option-${county.areaId}'),
            value: _isAreaSelected(county),
            onChanged: (_) => _toggle(county.areaId),
          ),
          title: Text(county.displayName),
          children: widget.directory
              .childrenOf(county.areaId)
              .map(_areaOption)
              .toList(growable: false),
        );
      },
    );
  }

  Widget _areaOption(TaiwanAdministrativeArea area) => CheckboxListTile(
    key: ValueKey('administrative-area-option-${area.areaId}'),
    value: _isAreaSelected(area),
    title: Text(area.displayName),
    controlAffinity: ListTileControlAffinity.leading,
    onChanged: (_) => _toggle(area.areaId),
  );
}
