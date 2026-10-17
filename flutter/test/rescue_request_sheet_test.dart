import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/widgets/rescue_request_sheet.dart';

Widget _sheet({
  required RescueDraft draft,
  RescueSheetStep step = RescueSheetStep.edit,
  ValueChanged<RescueDraft>? onChanged,
  RescueCapabilities? capabilities,
  VoidCallback? onSirenOnly,
}) => MaterialApp(
  home: Scaffold(
    body: RescueRequestSheet(
      draft: draft,
      step: step,
      submitting: false,
      isUpdate: false,
      capabilities: capabilities,
      errorMessage: null,
      onDraftChanged: onChanged ?? (_) {},
      onRequestCurrentLocation: () {},
      onRequestMapPick: () {},
      onShowConfirmation: () {},
      onBackToEdit: () {},
      onSubmit: () {},
      onCancel: () {},
      onOpenSirenOnly: onSirenOnly ?? () {},
    ),
  ),
);

void main() {
  testWidgets('TRAPPED_DEBRIS previews a fixed CRITICAL urgency', (tester) async {
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial()));
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    expect(find.text('固定為危急'), findsOneWidget);
    expect(find.text('此功能不能取代 119，請在可撥打時優先撥打 119'), findsOneWidget);
  });

  testWidgets('answers drive the urgency preview; there is no urgency picker', (tester) async {
    var draft = RescueDraft.initial().copyWith(type: RescueRequestType.firstAidNeeded, subject: RescueSubject.others);
    await tester.pumpWidget(_sheet(draft: draft, onChanged: (next) => draft = next));
    expect(find.text('急迫程度：中（需要協助）'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-triage-severe_bleeding-YES')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-triage-severe_bleeding-YES')));
    expect(draft.urgency, RescueUrgency.critical);
    expect(find.textContaining('LOW'), findsNothing);
  });

  testWidgets('the consciousness question is hidden for SELF', (tester) async {
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial()));
    expect(find.byKey(const ValueKey<String>('rescue-triage-conscious-NO')), findsNothing);
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial().copyWith(subject: RescueSubject.others)));
    expect(find.byKey(const ValueKey<String>('rescue-triage-conscious-NO')), findsOneWidget);
  });

  testWidgets('confirmation shows every field and the unverified warning', (tester) async {
    final draft = RescueDraft.initial().copyWith(
      peopleCount: 3,
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
      description: '一樓樓梯間',
    );
    await tester.pumpWidget(_sheet(draft: draft, step: RescueSheetStep.confirm));
    for (final text in <String>[
      '類型：受困於瓦礫或倒塌建物下',
      '對象：我自己',
      '急迫程度：危急（受困於瓦礫或倒塌建物下）',
      '人數：3 人',
      '描述：一樓樓梯間',
      '位置來源：目前位置',
      '座標：25.000000, 121.500000',
      '送出後為未經查證的求救，不代表已派遣救援',
    ]) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
  });

  testWidgets('a browser that cannot sign cannot submit, but can still sound the alarm', (tester) async {
    var sirenTaps = 0;
    final draft = RescueDraft.initial().copyWith(
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
    );
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: false, canVerify: false, hasStorage: true, supportsMesh: false),
      onSirenOnly: () => sirenTaps++,
    ));
    final submit = tester.widget<ElevatedButton>(find.byKey(const ValueKey<String>('rescue-submit')));
    expect(submit.onPressed, isNull);
    expect(find.text('此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲'), findsOneWidget);
    await tester.pumpWidget(_sheet(draft: draft, onSirenOnly: () => sirenTaps++));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-siren-only')));
    expect(sirenTaps, 1);
  });

  testWidgets('the web confirmation warns that the browser key can be lost', (tester) async {
    final draft = RescueDraft.initial().copyWith(
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
    );
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: false),
    ));
    expect(find.text(rescueBrowserKeyText), findsOneWidget);
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: true),
    ));
    expect(find.text(rescueBrowserKeyText), findsNothing);
  });
}
