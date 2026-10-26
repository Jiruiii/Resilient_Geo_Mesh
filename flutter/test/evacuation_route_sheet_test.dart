import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/widgets/evacuation_route_sheet.dart';

void main() {
  testWidgets('shows loading state without inventing route metrics', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const EvacuationRouteSheet(
          route: null,
          loading: true,
          errorMessage: null,
          stale: false,
          loadingMessage: null,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );

    expect(find.text('正在計算逃生路線…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
  });

  testWidgets('formats route metrics, versions, warnings and blocked ids', (
    tester,
  ) async {
    final route = _route(distanceM: 1250, durationS: 61);
    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: route,
          loading: false,
          errorMessage: null,
          stale: false,
          loadingMessage: null,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );

    expect(find.text('距離：1.3 公里'), findsOneWidget);
    expect(find.text('預估步行時間：2 分鐘'), findsOneWidget);
    expect(find.text('路網版本：taiwan-walk-test'), findsOneWidget);
    expect(find.text('事件快照：2026-09-25T00:00:00Z'), findsOneWidget);
    expect(find.text('附近有未驗證警示，請現場確認'), findsOneWidget);
    expect(find.text('受路線快照排除事件：road:closed'), findsOneWidget);
  });

  testWidgets('uses metres below one kilometre and rounds duration upward', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: _route(distanceM: 800, durationS: 1),
          loading: false,
          errorMessage: null,
          stale: false,
          loadingMessage: null,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );

    expect(find.text('距離：800 公尺'), findsOneWidget);
    expect(find.text('預估步行時間：1 分鐘'), findsOneWidget);
  });

  testWidgets('shows every route status and bridge error without a line', (
    tester,
  ) async {
    final expected = <EvacuationRouteStatus, String>{
      EvacuationRouteStatus.noRoute: '找不到可達路線',
      EvacuationRouteStatus.graphUnavailable: '離線路網尚未載入',
      EvacuationRouteStatus.invalidInput: '起點或避難所資料不完整',
    };
    for (final entry in expected.entries) {
      await tester.pumpWidget(
        _app(
          EvacuationRouteSheet(
            route: _route(status: entry.key),
            loading: false,
            errorMessage: null,
            stale: false,
            loadingMessage: null,
            onRecalculate: null,
            onClose: null,
          ),
        ),
      );
      expect(find.text(entry.value), findsOneWidget);
      expect(find.textContaining('距離：'), findsNothing);
      expect(
        find.byKey(const ValueKey<String>('evacuation-route-line')),
        findsNothing,
      );
    }

    await tester.pumpWidget(
      _app(
        const EvacuationRouteSheet(
          route: null,
          loading: false,
          errorMessage: '此功能需要 Android App，Chrome 僅供地圖與資料預覽',
          stale: false,
          loadingMessage: null,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );
    expect(find.text('此功能需要 Android App，Chrome 僅供地圖與資料預覽'), findsOneWidget);
  });

  testWidgets('shows stale state and allows recalculation', (tester) async {
    var recalculations = 0;
    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: _route(),
          loading: false,
          errorMessage: null,
          stale: true,
          loadingMessage: null,
          onRecalculate: () => recalculations += 1,
          onClose: null,
        ),
      ),
    );

    expect(find.text('路線資訊已變更，請重新計算'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey<String>('recalculate-evacuation-route')),
    );
    expect(recalculations, 1);
  });

  testWidgets('walking routes are titled and caveated as non-evacuation', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: _route(),
          loading: false,
          errorMessage: null,
          stale: false,
          destinationName: '慈安診所',
          destinationKind: RouteDestinationKind.medical,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );

    expect(find.text('步行路線'), findsOneWidget);
    expect(find.text('逃生路線'), findsNothing);
    expect(find.text('目的地：慈安診所'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('walking-route-disclaimer')),
      findsOneWidget,
    );
    expect(find.text('距離：1.2 公里'), findsOneWidget);
  });

  testWidgets('walking route loading and invalid input name the destination', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const EvacuationRouteSheet(
          route: null,
          loading: true,
          errorMessage: null,
          stale: false,
          destinationKind: RouteDestinationKind.supply,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );
    expect(find.text('正在計算步行路線…'), findsOneWidget);

    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: _route(status: EvacuationRouteStatus.invalidInput),
          loading: false,
          errorMessage: null,
          stale: false,
          destinationKind: RouteDestinationKind.supply,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );
    expect(find.text('起點或目的地資料不完整'), findsOneWidget);
  });

  testWidgets('shelter routes keep the evacuation wording', (tester) async {
    await tester.pumpWidget(
      _app(
        EvacuationRouteSheet(
          route: _route(),
          loading: false,
          errorMessage: null,
          stale: false,
          onRecalculate: null,
          onClose: null,
        ),
      ),
    );

    expect(find.text('逃生路線'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('walking-route-disclaimer')),
      findsNothing,
    );
  });
}

Widget _app(Widget child) => MaterialApp(home: Scaffold(body: child));

EvacuationRouteResult _route({
  EvacuationRouteStatus status = EvacuationRouteStatus.ok,
  double distanceM = 1200,
  double durationS = 900,
}) => EvacuationRouteResult(
  status: status,
  polyline:
      status == EvacuationRouteStatus.ok
          ? const <GeoPoint>[
            GeoPoint(longitude: 121.5, latitude: 25.0),
            GeoPoint(longitude: 121.6, latitude: 25.1),
          ]
          : const <GeoPoint>[],
  distanceM: status == EvacuationRouteStatus.ok ? distanceM : null,
  durationS: status == EvacuationRouteStatus.ok ? durationS : null,
  graphVersion: status == EvacuationRouteStatus.ok ? 'taiwan-walk-test' : null,
  eventSnapshotAt:
      status == EvacuationRouteStatus.ok ? '2026-09-25T00:00:00Z' : null,
  warnings:
      status == EvacuationRouteStatus.ok
          ? const <RouteWarning>[
            RouteWarning(
              code: 'UNVERIFIED_CROWD_REPORT',
              eventId: 'report:test',
              message: '附近有未驗證警示，請現場確認',
            ),
          ]
          : const <RouteWarning>[],
  blockedEventIds:
      status == EvacuationRouteStatus.ok
          ? const <String>['road:closed']
          : const <String>[],
);
