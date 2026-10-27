import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/map_search.dart';
import 'package:resilientgeo_flutter/widgets/crowd_report_sheet.dart';

void main() {
  testWidgets('shows all fixed categories and the 160-character input', (
    tester,
  ) async {
    await tester.pumpWidget(_app(_draft()));

    for (final category in CrowdReportCategory.values) {
      expect(find.text(category.label), findsOneWidget);
    }
    expect(
      find.byKey(const ValueKey<String>('crowd-report-description')),
      findsOneWidget,
    );
    expect(tester.widget<TextField>(find.byType(TextField)).maxLength, 160);
  });

  testWidgets(
    'requests location actions and disables confirmation without a location',
    (tester) async {
      var currentLocationRequests = 0;
      var mapPickRequests = 0;
      var confirmationRequests = 0;
      await tester.pumpWidget(
        _app(
          _draft(withoutLocation: true, locationSource: null),
          onRequestCurrentLocation: () => currentLocationRequests += 1,
          onRequestMapPick: () => mapPickRequests += 1,
          onShowConfirmation: () => confirmationRequests += 1,
        ),
      );

      await tester.tap(find.text('使用目前位置'));
      await tester.tap(find.text('地圖拖拉定位'));
      expect(currentLocationRequests, 1);
      expect(mapPickRequests, 1);
      expect(
        tester
            .widget<ElevatedButton>(find.widgetWithText(ElevatedButton, '確認內容'))
            .onPressed,
        isNull,
      );
      expect(confirmationRequests, 0);
    },
  );

  testWidgets(
    'emits edited description and preserves empty description as valid',
    (tester) async {
      CrowdReportDraft? changed;
      await tester.pumpWidget(
        _app(
          _draft(description: ''),
          onDraftChanged: (value) => changed = value,
        ),
      );

      await tester.enterText(
        find.byKey(const ValueKey<String>('crowd-report-description')),
        '道路有落石',
      );
      expect(changed?.description, '道路有落石');
      expect(CrowdReportDraft.validateDescription(''), isNull);
    },
  );

  testWidgets('offers local address search and explains an empty result', (
    tester,
  ) async {
    final addressController = TextEditingController();
    addTearDown(addressController.dispose);
    addressController.text = '不存在的地址';
    await tester.pumpWidget(
      _app(
        _draft(),
        addressController: addressController,
        addressResults: const <MapSearchResult>[],
      ),
    );

    expect(find.text('找不到此地址，請改用地圖拖拉'), findsOneWidget);
  });

  testWidgets('emits a selected local address candidate', (tester) async {
    final addressController = TextEditingController();
    addTearDown(addressController.dispose);
    addressController.text = '成功';
    const result = MapSearchResult(
      feature: null,
      title: '成功路',
      typeLabel: '道路',
      coordinate: GeoPoint(longitude: 121.59, latitude: 25.08),
      region: '臺北市內湖區',
      resultId: 'way:success-road',
    );
    MapSearchResult? selected;
    await tester.pumpWidget(
      _app(
        _draft(),
        addressController: addressController,
        addressResults: const <MapSearchResult>[result],
        onAddressSelected: (value) => selected = value,
      ),
    );

    // The longer report form pushes the candidates below the test viewport.
    await tester.ensureVisible(find.text('成功路'));
    await tester.tap(find.text('成功路'));

    expect(selected, result);
  });

  testWidgets('shows context and coordinates for duplicate road candidates', (
    tester,
  ) async {
    final addressController = TextEditingController();
    addTearDown(addressController.dispose);
    addressController.text = '萬全街';
    const result = MapSearchResult(
      feature: null,
      title: '萬全街',
      typeLabel: '道路',
      coordinate: GeoPoint(longitude: 121.487157, latitude: 25.063101),
      region: '新北市三重區',
      resultId: 'way:wanquan-sanchong',
      searchKind: 'road',
    );

    await tester.pumpWidget(
      _app(
        _draft(),
        addressController: addressController,
        addressResults: const <MapSearchResult>[result],
      ),
    );

    expect(find.text('新北市三重區・萬全街'), findsOneWidget);
    expect(find.text('道路・座標：25.063101, 121.487157'), findsOneWidget);
  });

  testWidgets('confirmation shows draft details and back callback', (
    tester,
  ) async {
    var backRequests = 0;
    await tester.pumpWidget(
      _app(
        _draft(),
        step: CrowdReportSheetStep.confirm,
        onBackToEdit: () => backRequests += 1,
      ),
    );

    expect(find.text('類型：道路阻斷'), findsOneWidget);
    expect(find.text('位置來源：目前位置'), findsOneWidget);
    expect(find.text('座標：25.083506, 121.590304'), findsOneWidget);
    expect(find.text('描述：道路有落石'), findsOneWidget);

    await tester.tap(find.text('返回修改'));
    expect(backRequests, 1);
  });

  testWidgets('disables submit and shows progress while submitting', (
    tester,
  ) async {
    var submitRequests = 0;
    await tester.pumpWidget(
      _app(
        _draft(),
        step: CrowdReportSheetStep.confirm,
        submitting: true,
        onSubmit: () => submitRequests += 1,
      ),
    );

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      tester
          .widget<ElevatedButton>(
            find.byKey(const ValueKey<String>('crowd-report-submit')),
          )
          .onPressed,
      isNull,
    );
    expect(submitRequests, 0);
  });
}

Widget _app(
  CrowdReportDraft draft, {
  CrowdReportSheetStep step = CrowdReportSheetStep.edit,
  bool submitting = false,
  ValueChanged<CrowdReportDraft>? onDraftChanged,
  VoidCallback? onRequestCurrentLocation,
  VoidCallback? onRequestMapPick,
  TextEditingController? addressController,
  List<MapSearchResult> addressResults = const <MapSearchResult>[],
  ValueChanged<String>? onAddressChanged,
  ValueChanged<MapSearchResult>? onAddressSelected,
  VoidCallback? onShowConfirmation,
  VoidCallback? onBackToEdit,
  VoidCallback? onSubmit,
}) => MaterialApp(
  home: Scaffold(
    body: StatefulBuilder(
      builder:
          (context, rebuild) => CrowdReportSheet(
            draft: draft,
            step: step,
            submitting: submitting,
            onDraftChanged: onDraftChanged ?? (_) {},
            onRequestCurrentLocation: onRequestCurrentLocation ?? () {},
            onRequestMapPick: onRequestMapPick ?? () {},
            addressController: addressController,
            addressResults: addressResults,
            onAddressChanged:
                onAddressChanged ??
                (_) {
                  rebuild(() {});
                },
            onAddressSelected: onAddressSelected ?? (_) {},
            onShowConfirmation: onShowConfirmation ?? () {},
            onBackToEdit: onBackToEdit ?? () {},
            onSubmit: onSubmit ?? () {},
            onCancel: () {},
          ),
    ),
  ),
);

CrowdReportDraft _draft({
  bool withoutLocation = false,
  GeoPoint? location,
  CrowdReportLocationSource? locationSource,
  String description = '道路有落石',
}) => CrowdReportDraft(
  category: CrowdReportCategory.roadBlockage,
  location:
      withoutLocation
          ? null
          : (location ??
              const GeoPoint(longitude: 121.590304, latitude: 25.083506)),
  locationSource: locationSource ?? CrowdReportLocationSource.currentLocation,
  description: description,
);
