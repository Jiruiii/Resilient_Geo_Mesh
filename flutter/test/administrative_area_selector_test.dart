import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/widgets/administrative_area_selector.dart';

void main() {
  testWidgets('county selection checks its towns and allows excluding one', (
    tester,
  ) async {
    Set<String>? result;
    final directory = _directory();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder:
              (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    result = await AdministrativeAreaSelector.show(
                      context,
                      directory: directory,
                      selectedIds: const <String>{'tw.00001'},
                    );
                  },
                  child: const Text('open'),
                ),
              ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('測試縣'));
    await tester.pumpAndSettle();

    final firstTown = find.byKey(
      const ValueKey('administrative-area-option-tw.00001001'),
    );
    final secondTown = find.byKey(
      const ValueKey('administrative-area-option-tw.00001002'),
    );
    expect(tester.widget<CheckboxListTile>(firstTown).value, isTrue);
    expect(tester.widget<CheckboxListTile>(secondTown).value, isTrue);

    await tester.tap(firstTown);
    await tester.pumpAndSettle();
    expect(tester.widget<CheckboxListTile>(firstTown).value, isFalse);
    expect(tester.widget<CheckboxListTile>(secondTown).value, isTrue);
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();

    expect(result, <String>{'tw.00001002'});
  });

  testWidgets('searching can uncheck one town from a selected county', (
    tester,
  ) async {
    Set<String>? result;
    final directory = _directory();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder:
              (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    result = await AdministrativeAreaSelector.show(
                      context,
                      directory: directory,
                      selectedIds: const <String>{'tw.00001'},
                      allowNational: true,
                    );
                  },
                  child: const Text('open'),
                ),
              ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('administrative-area-search')),
      '測試鎮一',
    );
    await tester.pumpAndSettle();
    expect(find.text('測試縣 測試鎮一'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('administrative-area-option-tw.00001001')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();

    expect(result, <String>{'tw.00001002'});
  });

  testWidgets('supports explicit nationwide selection and cancel', (
    tester,
  ) async {
    Set<String>? result;
    final directory = _directory();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder:
              (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    result = await AdministrativeAreaSelector.show(
                      context,
                      directory: directory,
                      selectedIds: const <String>{'tw.00001001'},
                      allowNational: true,
                    );
                  },
                  child: const Text('open'),
                ),
              ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('administrative-area-option-tw.national')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();
    expect(result, <String>{'tw.national'});

    result = <String>{'sentinel'};
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(result, isNull);
  });
}

TaiwanAdministrativeAreaDirectory _directory() =>
    TaiwanAdministrativeAreaDirectory.fromJson(<String, Object?>{
      'schema_version': 'taiwan-area-directory-v1',
      'coverage': 'TW',
      'target_coordinate_system': 'EPSG:4326',
      'source_version': 'sha256:${List<String>.filled(64, '0').join()}',
      'area_count': 3,
      'areas': <Map<String, Object?>>[
        <String, Object?>{
          'area_id': 'tw.00001',
          'level': 'county',
          'parent_area_id': null,
          'county_name': '測試縣',
          'town_name': null,
        },
        <String, Object?>{
          'area_id': 'tw.00001001',
          'level': 'town',
          'parent_area_id': 'tw.00001',
          'county_name': '測試縣',
          'town_name': '測試鎮一',
        },
        <String, Object?>{
          'area_id': 'tw.00001002',
          'level': 'town',
          'parent_area_id': 'tw.00001',
          'county_name': '測試縣',
          'town_name': '測試鎮二',
        },
      ],
    });
