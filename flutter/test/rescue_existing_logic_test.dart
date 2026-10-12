import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/corroboration.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/route_event_snapshot.dart';
import 'package:resilientgeo_flutter/widgets/crowd_report_sheet.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';

import 'support/rescue_events.dart';

void main() {
  final now = DateTime.parse('2026-10-12T04:00:00Z');

  test('ended or expired rescue requests are never drawn as active', () {
    expect(rescue().isShownAt(now), isTrue);
    expect(rescue(status: 'RESOLVED').isShownAt(now), isFalse);
    expect(rescue(status: 'CANCELLED').isShownAt(now), isFalse);
    expect(rescue(expiresAt: '2026-10-12T03:30:00Z').isShownAt(now), isFalse);
  });

  test('rescue points do not trigger evacuation re-routing', () {
    final before = RouteEventSnapshot(const <MeshEvent>[], now);
    final after = RouteEventSnapshot(<MeshEvent>[rescue()], now);
    expect(before.changeReason(after), isNull);
  });

  test('rescue requests are named as rescue points and never corroborated', () {
    expect(eventName(rescue()), '求救點：受困於瓦礫或倒塌建物下');
    expect(corroborationCount(rescue(), <MeshEvent>[rescue(), rescue()], now: now), 0);
  });

  testWidgets('the trapped/injured report option points people to 需要救援', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CrowdReportSheet(
          draft: const CrowdReportDraft(
            category: CrowdReportCategory.trappedInjured,
            location: null,
            locationSource: null,
            description: '',
          ),
          step: CrowdReportSheetStep.edit,
          submitting: false,
          onDraftChanged: (_) {},
          onRequestCurrentLocation: () {},
          onRequestMapPick: () {},
          onShowConfirmation: () {},
          onBackToEdit: () {},
          onSubmit: () {},
          onCancel: () {},
        ),
      ),
    ));
    expect(find.text('若是你或現場有人需要救援，請改用「需要救援」'), findsOneWidget);
  });
}
