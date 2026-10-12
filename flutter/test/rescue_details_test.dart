import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';

import 'support/rescue_events.dart';

void main() {
  testWidgets('rescue details describe the request without implying dispatch', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: FeatureDetailsSheet.event(event: rescue(), onClose: () {})),
    ));
    expect(find.text('求救點：受困於瓦礫或倒塌建物下'), findsOneWidget);
    expect(find.text('未經查證，僅供參考'), findsOneWidget);
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    expect(find.text('求救狀態：進行中'), findsOneWidget);
    expect(find.text('人數：2 人'), findsOneWidget);
    expect(find.text('未經查證，不代表已派遣救援'), findsOneWidget);
    expect(find.textContaining('回報類別'), findsNothing);
  });
}
