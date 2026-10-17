import 'package:flutter/material.dart';

import '../data/crowd_report_models.dart';
import '../data/map_search.dart';
import '../data/rescue_request_models.dart';
import '../data/rescue_service.dart';
import 'map_layers.dart';

enum RescueSheetStep { edit, confirm }

const rescueNot119Text = '此功能不能取代 119，請在可撥打時優先撥打 119';
const rescueUnverifiedText = '送出後為未經查證的求救，不代表已派遣救援';
const rescuePrivacyText = '求救帶有精確位置，收到的裝置與伺服器都看得到；同一裝置的求救可被串連';
const rescueDescriptionHelper = '請勿輸入姓名、電話、身分證號等非必要個資；描述會公開給收到求救的人';
const rescueBrowserKeyText = '這個瀏覽器會保存簽署求救的金鑰；清除網站資料或使用無痕視窗後，將無法更新或取消這筆求救，只能等它到期';

class RescueRequestSheet extends StatelessWidget {
  const RescueRequestSheet({
    super.key,
    required this.draft,
    required this.step,
    required this.submitting,
    required this.isUpdate,
    required this.capabilities,
    required this.errorMessage,
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
    required this.onOpenSirenOnly,
  });

  final RescueDraft draft;
  final RescueSheetStep step;
  final bool submitting;
  final bool isUpdate;
  final RescueCapabilities? capabilities;
  final String? errorMessage;
  final ValueChanged<RescueDraft> onDraftChanged;
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
  final VoidCallback onOpenSirenOnly;

  bool get _canSign => capabilities?.canSign ?? true;

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    elevation: 12,
    borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
    child: SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: step == RescueSheetStep.edit ? _editBody(context) : _confirmBody(context),
        ),
      ),
    ),
  );

  Widget _header(BuildContext context, String title) => Row(
    children: <Widget>[
      Expanded(child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
      IconButton(tooltip: '關閉需要救援', onPressed: submitting ? null : onCancel, icon: const Icon(Icons.close)),
    ],
  );

  Widget _section(BuildContext context, String title) => Padding(
    padding: const EdgeInsets.only(top: 12, bottom: 4),
    child: Text(title, style: Theme.of(context).textTheme.titleMedium),
  );

  Widget _editBody(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(context, isUpdate ? '更新求救' : '需要救援'),
        Text(rescueNot119Text, style: TextStyle(color: theme.colorScheme.error, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          key: const ValueKey<String>('rescue-siren-only'),
          onPressed: onOpenSirenOnly,
          icon: const Icon(MapIconCatalog.locatorSound),
          label: const Text('只發出定位警報聲（不送出求救，也不需要網路）'),
        ),
        _section(context, '求救類型'),
        for (final type in RescueRequestType.values)
          RadioListTile<RescueRequestType>(
            key: ValueKey<String>('rescue-type-${type.wireValue}'),
            contentPadding: EdgeInsets.zero,
            secondary: Icon(MapIconCatalog.rescueRequest(type)),
            title: Text(type.label),
            value: type,
            groupValue: draft.type,
            onChanged: submitting ? null : (value) => onDraftChanged(draft.copyWith(type: value)),
          ),
        _section(context, '需要救援的是'),
        Wrap(
          spacing: 8,
          children: <Widget>[
            for (final subject in RescueSubject.values)
              ChoiceChip(
                key: ValueKey<String>('rescue-subject-${subject.wireValue}'),
                label: Text(subject.label),
                selected: draft.subject == subject,
                onSelected: submitting ? null : (_) => onDraftChanged(draft.copyWith(subject: subject)),
              ),
          ],
        ),
        _section(context, '目前狀況'),
        _question('immobile', '是否無法移動', draft.triage.immobile, (answer) => draft.triage.copyWith(immobile: answer)),
        _question('breathing_difficulty', '是否呼吸困難', draft.triage.breathingDifficulty, (answer) => draft.triage.copyWith(breathingDifficulty: answer)),
        _question('severe_bleeding', '是否大量出血', draft.triage.severeBleeding, (answer) => draft.triage.copyWith(severeBleeding: answer)),
        if (draft.subject == RescueSubject.others)
          _question('conscious', '是否清醒', draft.triage.conscious, (answer) => draft.triage.copyWith(conscious: answer)),
        _section(context, '需要救援的人數'),
        Row(
          children: <Widget>[
            IconButton(
              key: const ValueKey<String>('rescue-people-minus'),
              tooltip: '減少人數',
              onPressed: submitting || draft.peopleCount <= 1 ? null : () => onDraftChanged(draft.copyWith(peopleCount: draft.peopleCount - 1)),
              icon: const Icon(Icons.remove),
            ),
            Text('${draft.peopleCount} 人', style: theme.textTheme.titleMedium),
            IconButton(
              key: const ValueKey<String>('rescue-people-plus'),
              tooltip: '增加人數',
              onPressed: submitting || draft.peopleCount >= rescuePeopleMax ? null : () => onDraftChanged(draft.copyWith(peopleCount: draft.peopleCount + 1)),
              icon: const Icon(Icons.add),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          children: <Widget>[
            Flexible(
              child: Text(
                '急迫程度：${draft.urgency.label}（${draft.urgencyReason}）',
                key: const ValueKey<String>('rescue-urgency-preview'),
                style: theme.textTheme.titleSmall,
              ),
            ),
            if (draft.type == RescueRequestType.trappedDebris) ...<Widget>[
              const SizedBox(width: 8),
              const Chip(label: Text('固定為危急')),
            ],
          ],
        ),
        _section(context, '求救位置'),
        Text(_locationText()),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            OutlinedButton.icon(onPressed: submitting ? null : onRequestCurrentLocation, icon: const Icon(Icons.my_location), label: const Text('使用目前位置')),
            OutlinedButton.icon(onPressed: submitting ? null : onRequestMapPick, icon: const Icon(Icons.pin_drop_outlined), label: const Text('地圖選點')),
          ],
        ),
        if (addressController != null) ...<Widget>[
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey<String>('rescue-address'),
            controller: addressController,
            enabled: !submitting,
            onChanged: onAddressChanged,
            decoration: const InputDecoration(
              labelText: '輸入區域、道路或地址',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
          ),
          if (addressController!.text.trim().isNotEmpty)
            ...addressResults.take(5).map(
              (result) => ListTile(
                dense: true,
                title: Text(result.displayTitle),
                subtitle: Text(result.typeLabel),
                onTap: onAddressSelected == null || result.coordinate == null ? null : () => onAddressSelected!(result),
              ),
            ),
        ],
        const SizedBox(height: 12),
        TextFormField(
          key: const ValueKey<String>('rescue-description'),
          initialValue: draft.description,
          maxLength: rescueDescriptionMaxCodePoints,
          maxLines: 3,
          enabled: !submitting,
          onChanged: (value) => onDraftChanged(draft.copyWith(description: value)),
          decoration: const InputDecoration(
            labelText: '補充說明（選填，最多 160 字）',
            helperText: rescueDescriptionHelper,
            helperMaxLines: 2,
            border: OutlineInputBorder(),
          ),
        ),
        Row(
          children: <Widget>[
            TextButton(onPressed: submitting ? null : onCancel, child: const Text('取消')),
            const Spacer(),
            ElevatedButton(
              key: const ValueKey<String>('rescue-confirm'),
              onPressed: draft.location != null && draft.locationSource != null && !submitting ? onShowConfirmation : null,
              child: const Text('確認內容'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _question(String field, String label, TriageAnswer current, RescueTriage Function(TriageAnswer) update) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: <Widget>[
        Expanded(child: Text(label)),
        for (final answer in TriageAnswer.values)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: ChoiceChip(
              key: ValueKey<String>('rescue-triage-$field-${answer.wireValue}'),
              label: Text(answer.label),
              selected: current == answer,
              onSelected: submitting ? null : (_) => onDraftChanged(draft.copyWith(triage: update(answer))),
            ),
          ),
      ],
    ),
  );

  Widget _confirmBody(BuildContext context) {
    final theme = Theme.of(context);
    final unsupported = !_canSign;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(context, isUpdate ? '確認更新內容' : '確認求救內容'),
        Text('位置來源：${_locationSourceLabel()}'),
        if (draft.locationHint != null) Text('搜尋參考：${draft.locationHint!.label}'),
        Text('座標：${_coordinateText()}'),
        Text('類型：${draft.type.label}'),
        Text('對象：${draft.subject.label}'),
        Text('急迫程度：${draft.urgency.label}（${draft.urgencyReason}）'),
        Text('人數：${draft.peopleCount} 人'),
        Text('描述：${draft.description.trim().isEmpty ? '無描述' : draft.description.trim()}'),
        const SizedBox(height: 12),
        Text(rescueUnverifiedText, style: const TextStyle(color: unverifiedEventColor, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(rescuePrivacyText, style: theme.textTheme.bodySmall),
        const SizedBox(height: 4),
        Text(rescueNot119Text, style: theme.textTheme.bodySmall),
        if (capabilities?.supportsMesh == false && !isUpdate)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(rescueBrowserKeyText, style: theme.textTheme.bodySmall),
          ),
        if (unsupported)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              const RescueFailure(code: RescueFailureCode.unsupported, message: 'signing_unsupported').userMessage(),
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        if (errorMessage != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(errorMessage!, key: const ValueKey<String>('rescue-error'), style: TextStyle(color: theme.colorScheme.error)),
          ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            TextButton(onPressed: submitting ? null : onBackToEdit, child: const Text('返回修改')),
            const Spacer(),
            ElevatedButton.icon(
              key: const ValueKey<String>('rescue-submit'),
              onPressed: submitting || unsupported ? null : onSubmit,
              icon: submitting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.send),
              label: Text(isUpdate ? '確認更新' : '確認送出'),
            ),
          ],
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
    CrowdReportLocationSource.mapPick => '地圖選點',
    null => '尚未選擇',
  };

  String _coordinateText() {
    final point = draft.location;
    if (point == null) return '無資料';
    return '${point.latitude.toStringAsFixed(6)}, ${point.longitude.toStringAsFixed(6)}';
  }
}
