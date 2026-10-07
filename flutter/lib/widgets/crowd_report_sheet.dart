import 'package:flutter/material.dart';

import '../data/crowd_report_models.dart';
import '../data/map_models.dart';
import '../data/map_search.dart';

enum CrowdReportSheetStep { edit, confirm }

class CrowdReportSheet extends StatelessWidget {
  const CrowdReportSheet({
    super.key,
    required this.draft,
    required this.step,
    required this.submitting,
    required this.onDraftChanged,
    required this.onRequestCurrentLocation,
    required this.onRequestMapPick,
    this.addressController,
    this.addressResults = const <MapSearchResult>[],
    this.onAddressChanged,
    this.onAddressSelected,
    required this.onShowConfirmation,
    required this.onBackToEdit,
    required this.onSubmit,
    required this.onCancel,
  });

  final CrowdReportDraft draft;
  final CrowdReportSheetStep step;
  final bool submitting;
  final ValueChanged<CrowdReportDraft> onDraftChanged;
  final VoidCallback onRequestCurrentLocation;
  final VoidCallback onRequestMapPick;
  final TextEditingController? addressController;
  final List<MapSearchResult> addressResults;
  final ValueChanged<String>? onAddressChanged;
  final ValueChanged<MapSearchResult>? onAddressSelected;
  final VoidCallback onShowConfirmation;
  final VoidCallback onBackToEdit;
  final VoidCallback onSubmit;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surface,
      elevation: 12,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child:
              step == CrowdReportSheetStep.edit
                  ? _editBody(context)
                  : _confirmationBody(context),
        ),
      ),
    );
  }

  Widget _header(BuildContext context, String title) => Row(
    children: <Widget>[
      Expanded(
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      IconButton(
        tooltip: '取消回報',
        onPressed: submitting ? null : onCancel,
        icon: const Icon(Icons.close),
      ),
    ],
  );

  Widget _editBody(BuildContext context) {
    final canConfirm = draft.location != null && draft.locationSource != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(context, '回報警示'),
        const SizedBox(height: 8),
        Text('警示類型', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 4),
        ...CrowdReportCategory.values.map(
          (category) => RadioListTile<CrowdReportCategory>(
            contentPadding: EdgeInsets.zero,
            title: Text(category.label),
            value: category,
            groupValue: draft.category,
            onChanged: (value) {
              if (value == null) return;
              onDraftChanged(_copyDraft(category: value));
            },
          ),
        ),
        const SizedBox(height: 8),
        Text('警示位置', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(_locationText()),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            OutlinedButton.icon(
              onPressed: submitting ? null : onRequestCurrentLocation,
              icon: const Icon(Icons.my_location),
              label: const Text('使用目前位置'),
            ),
            OutlinedButton.icon(
              onPressed: submitting ? null : onRequestMapPick,
              icon: const Icon(Icons.pin_drop_outlined),
              label: const Text('地圖拖拉定位'),
            ),
          ],
        ),
        if (addressController != null) ...<Widget>[
          const SizedBox(height: 12),
          _addressPicker(context),
        ],
        const SizedBox(height: 12),
        TextFormField(
          key: const ValueKey<String>('crowd-report-description'),
          initialValue: draft.description,
          maxLength: 160,
          maxLines: 3,
          enabled: !submitting,
          onChanged: (value) => onDraftChanged(_copyDraft(description: value)),
          decoration: const InputDecoration(
            labelText: '描述（最多 160 字）',
            hintText: '請簡述現場狀況',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: <Widget>[
            TextButton(
              onPressed: submitting ? null : onCancel,
              child: const Text('取消'),
            ),
            const Spacer(),
            ElevatedButton(
              key: const ValueKey<String>('crowd-report-confirm'),
              onPressed: canConfirm && !submitting ? onShowConfirmation : null,
              child: const Text('確認內容'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _confirmationBody(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      _header(context, '確認警示內容'),
      const SizedBox(height: 8),
      Text('請確認以下資訊後送出。'),
      const SizedBox(height: 12),
      Text('類型：${draft.category.label}'),
      Text('位置來源：${_locationSourceLabel()}'),
      if (draft.locationHint != null) Text('搜尋參考：${draft.locationHint!.label}'),
      Text('座標：${_coordinateText()}'),
      Text(
        '描述：${draft.description.trim().isEmpty ? '無描述' : draft.description.trim()}',
      ),
      const SizedBox(height: 16),
      Row(
        children: <Widget>[
          TextButton(
            onPressed: submitting ? null : onBackToEdit,
            child: const Text('返回修改'),
          ),
          const Spacer(),
          ElevatedButton.icon(
            key: const ValueKey<String>('crowd-report-submit'),
            onPressed: submitting ? null : onSubmit,
            icon:
                submitting
                    ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : const Icon(Icons.send),
            label: const Text('確認送出'),
          ),
        ],
      ),
    ],
  );

  CrowdReportDraft _copyDraft({
    CrowdReportCategory? category,
    String? description,
  }) => CrowdReportDraft(
    category: category ?? draft.category,
    location: draft.location,
    locationSource: draft.locationSource,
    locationHint: draft.locationHint,
    description: description ?? draft.description,
  );

  Widget _addressPicker(BuildContext context) {
    final controller = addressController!;
    final query = controller.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        TextField(
          key: const ValueKey<String>('crowd-report-address'),
          controller: controller,
          enabled: !submitting,
          onChanged: onAddressChanged,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            labelText: '輸入區域、道路或地址',
            hintText: '例如：內湖區、成功路',
            prefixIcon: Icon(Icons.search),
            border: OutlineInputBorder(),
          ),
        ),
        if (query.isNotEmpty && addressResults.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('找不到此地址，請改用地圖拖拉'),
          ),
        if (query.isNotEmpty && addressResults.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Material(
              elevation: 1,
              borderRadius: BorderRadius.circular(8),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 180),
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: addressResults.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final result = addressResults[index];
                    final isRoad =
                        result.searchKind == 'road' ||
                        result.feature?.kind == 'road';
                    final coordinate = result.coordinate;
                    final subtitle = <String>[result.typeLabel];
                    if (isRoad && coordinate != null) {
                      subtitle.add(
                        '座標：${_searchResultCoordinateText(coordinate)}',
                      );
                    } else {
                      if (result.region != null && result.region!.isNotEmpty) {
                        subtitle.add(result.region!);
                      }
                      if (result.address != null &&
                          result.address!.isNotEmpty) {
                        subtitle.add(result.address!);
                      }
                    }
                    return ListTile(
                      dense: true,
                      title: Text(result.displayTitle),
                      subtitle: Text(subtitle.join('・')),
                      onTap:
                          onAddressSelected == null || result.coordinate == null
                              ? null
                              : () => onAddressSelected!(result),
                    );
                  },
                ),
              ),
            ),
          ),
      ],
    );
  }

  String _locationText() {
    if (draft.location == null) return '尚未選擇位置';
    return '${_locationSourceLabel()}：${_coordinateText()}';
  }

  String _locationSourceLabel() => switch (draft.locationSource) {
    CrowdReportLocationSource.currentLocation => '目前位置',
    CrowdReportLocationSource.mapPick => '地圖拖拉定位',
    null => '尚未選擇',
  };

  String _coordinateText() {
    final point = draft.location;
    if (point == null) return '無資料';
    return '${point.latitude.toStringAsFixed(6)}, ${point.longitude.toStringAsFixed(6)}';
  }
}

String _searchResultCoordinateText(GeoPoint point) =>
    '${point.latitude.toStringAsFixed(6)}, ${point.longitude.toStringAsFixed(6)}';

class CrowdReportMapPickerBar extends StatelessWidget {
  const CrowdReportMapPickerBar({
    super.key,
    required this.draft,
    required this.onBackToForm,
    required this.onConfirm,
  });

  final CrowdReportDraft draft;
  final VoidCallback onBackToForm;
  final VoidCallback onConfirm;

  @override
  Widget build(BuildContext context) {
    final point = draft.location;
    return Material(
      color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.96),
      elevation: 10,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '拖動地圖調整警示位置',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 4),
              Text(
                draft.locationHint == null
                    ? '將中心圖釘放在警示發生的位置'
                    : '已定位到「${draft.locationHint!.label}」，請拖動地圖微調',
              ),
              const SizedBox(height: 6),
              Text(
                point == null
                    ? '尚未取得地圖中心位置'
                    : '地圖中心：${point.latitude.toStringAsFixed(6)}, ${point.longitude.toStringAsFixed(6)}',
              ),
              const SizedBox(height: 10),
              Row(
                children: <Widget>[
                  TextButton(
                    key: const ValueKey<String>('report-location-back'),
                    onPressed: onBackToForm,
                    child: const Text('返回表單'),
                  ),
                  const Spacer(),
                  ElevatedButton(
                    key: const ValueKey<String>('report-location-confirm'),
                    onPressed: point == null ? null : onConfirm,
                    child: const Text('確認此位置'),
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
