import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/map_search.dart';
import 'package:resilientgeo_flutter/screens/government_announcement_location_picker.dart';

void main() {
  testWidgets('search result selects a map coordinate for the announcement', (
    tester,
  ) async {
    const expected = GeoPoint(longitude: 121.517, latitude: 25.0478);
    GovernmentAnnouncementLocationSelection? selected;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder:
              (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    selected = await showDialog<
                      GovernmentAnnouncementLocationSelection
                    >(
                      context: context,
                      builder:
                          (_) => GovernmentAnnouncementLocationPicker(
                            searchPlaces:
                                (query) async =>
                                    query.contains('台北車站')
                                        ? const <MapSearchResult>[
                                          MapSearchResult(
                                            feature: null,
                                            title: '台北車站',
                                            typeLabel: '地點',
                                            coordinate: expected,
                                          ),
                                        ]
                                        : const <MapSearchResult>[],
                          ),
                    );
                  },
                  child: const Text('open-picker'),
                ),
              ),
        ),
      ),
    );
    await tester.tap(find.text('open-picker'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('government-location-search')),
      '台北車站',
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();

    expect(find.text('台北車站'), findsNWidgets(2));
    await tester.tap(
      find.byKey(
        const ValueKey('government-location-result-台北車站'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認位置'));
    await tester.pumpAndSettle();

    expect(selected?.point, expected);
  });
}
