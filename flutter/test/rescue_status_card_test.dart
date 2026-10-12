import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/widgets/rescue_status_card.dart';

import 'support/fake_rescue_service.dart';

void main() {
  testWidgets('the card states status, delivery and the unverified limits', (tester) async {
    var resolved = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: RescueStatusCard(
          session: fakeSession(),
          now: DateTime.parse('2026-10-12T08:40:00Z'),
          reminderDue: true,
          busy: false,
          sirenPanel: const Text('SIREN-SLOT'),
          onUpdate: () {},
          onExtend: () {},
          onResolve: () => resolved++,
          onCancel: () {},
        ),
      ),
    ));
    expect(find.text('你的求救：受困於瓦礫或倒塌建物下'), findsOneWidget);
    expect(find.text('急迫程度：危急　狀態：進行中'), findsOneWidget);
    expect(find.text('已存於本機，等待附近裝置轉傳；伺服器：等待上傳，尚未送出'), findsOneWidget);
    expect(find.text('未經查證，不代表已派遣救援'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('rescue-expiry-reminder')), findsOneWidget);
    expect(find.text('SIREN-SLOT'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-resolve')));
    await tester.pumpAndSettle();
    expect(find.text('確認你已安全或已獲救？'), findsOneWidget);
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();
    expect(resolved, 1);
  });
}
