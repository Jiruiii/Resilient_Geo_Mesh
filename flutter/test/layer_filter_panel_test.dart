import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/widgets/layer_filter_panel.dart';

void main() {
  testWidgets(
    'county warning area switch starts on and toggles independently',
    (tester) async {
      var showEvents = true;
      var showCountyWarningAreas = true;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder:
                  (context, setState) => LayerFilterPanel(
                    showShelters: true,
                    showMedical: true,
                    showEvents: showEvents,
                    showCountyWarningAreas: showCountyWarningAreas,
                    emergencyModeEnabled: false,
                    onSheltersChanged: (_) {},
                    onMedicalChanged: (_) {},
                    onEventsChanged:
                        (value) => setState(() => showEvents = value),
                    onCountyWarningAreasChanged:
                        (value) =>
                            setState(() => showCountyWarningAreas = value),
                    onEmergencyModeChanged: (_) {},
                  ),
            ),
          ),
        ),
      );

      final areaSwitch = find.widgetWithText(SwitchListTile, '警報影響範圍');
      final eventSwitch = find.widgetWithText(SwitchListTile, '災情事件');
      expect(tester.widget<SwitchListTile>(areaSwitch).value, isTrue);

      await tester.ensureVisible(areaSwitch);
      await tester.tap(areaSwitch);
      await tester.pump();
      expect(tester.widget<SwitchListTile>(areaSwitch).value, isFalse);
      expect(tester.widget<SwitchListTile>(eventSwitch).value, isTrue);
    },
  );
}
