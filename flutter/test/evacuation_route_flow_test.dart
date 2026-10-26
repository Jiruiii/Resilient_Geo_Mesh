import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/bridge_failure.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/location_controller.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';
import 'package:resilientgeo_flutter/widgets/map_canvas.dart';

void main() {
  testWidgets(
    'changing disaster context automatically refreshes an existing route',
    (tester) async {
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(_app(bridge: bridge));
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey('evacuation-disaster-context')),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const ValueKey('disaster-type-selector')),
      );
      await tester.tap(find.byKey(const ValueKey('disaster-type-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('震災').last);
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(bridge.routeCalls, 2);
      expect(bridge.lastDisasterType, DisasterType.earthquake);
      expect(find.text('災害情境變更，已自動重新規劃'), findsOneWidget);
    },
  );
  testWidgets(
    'selecting a disaster filters recommendations and reaches native routing',
    (tester) async {
      StaticFeature candidate(String id, String type) => StaticFeature(
        id: id,
        kind: 'shelter',
        geometry: const PointGeometry(
          GeoPoint(longitude: 121.501, latitude: 25.0),
        ),
        fields: {
          'name': id,
          'disaster_types': [type],
        },
        properties: null,
      );
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          features: [
            candidate('flood-only', '水災'),
            candidate('earthquake-only', '震災'),
          ],
        ),
      );
      await _finishLoad(tester);
      await tester.tap(
        find.byKey(const ValueKey('evacuation-disaster-context')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.ensureVisible(
        find.byKey(const ValueKey('disaster-type-selector')),
      );
      await tester.tap(find.byKey(const ValueKey('disaster-type-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('震災').last);
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(find.text('避難情境：震災'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
      await tester.pump();
      expect(bridge.lastDisasterType, DisasterType.earthquake);
      expect(bridge.destinations.map((shelter) => shelter.id), [
        'earthquake-only',
      ]);
      expect(find.text('距離：1.2 公里'), findsOneWidget);
    },
  );
  for (final code in <String>['ORIGIN_OFF_GRAPH', 'SHELTER_FULL']) {
    testWidgets('recommendation keeps the native failure reason: $code', (
      tester,
    ) async {
      final route = EvacuationRouteResult.fromMessage(<String, dynamic>{
        'status': 'no_route',
        'graph_version': 'neihu-walk-test',
        'event_snapshot_at': '2026-09-27T00:00:00Z',
        'warnings': <Map<String, dynamic>>[
          <String, dynamic>{
            'code': code,
            'event_id': null,
            'message':
                code == 'ORIGIN_OFF_GRAPH'
                    ? '目前只涵蓋內湖區，起點不在離線路網範圍內'
                    : '官方狀態顯示此避難所已額滿',
          },
        ],
        'blocked_event_ids': <String>[],
      });
      final bridge = _RouteBridge(result: route);
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          features: const <StaticFeature>[_shelterA, _shelterB],
        ),
      );
      await _finishLoad(tester);
      await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
      await tester.pump();

      expect(find.text(route.warnings.single.message), findsOneWidget);
      expect(find.textContaining('距離：'), findsNothing);
      expect(bridge.routeCalls, code == 'ORIGIN_OFF_GRAPH' ? 1 : 2);
    });
  }

  testWidgets('plans a route with the exact Android request and presents it', (
    tester,
  ) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(_app(bridge: bridge));
    await _finishLoad(tester);

    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    expect(bridge.routeCalls, 1);
    expect(bridge.lastOrigin, const GeoPoint(longitude: 121.5, latitude: 25.0));
    expect(bridge.lastDestination?.id, 'shelter:test');
    expect(
      bridge.lastDestination?.location,
      const GeoPoint(longitude: 121.590304, latitude: 25.083506),
    );
    expect(bridge.lastMode, 'walk');
    expect(find.text('距離：1.2 公里'), findsOneWidget);
    expect(find.text('路網版本：taiwan-walk-test'), findsOneWidget);
  });

  testWidgets('acquires location before routing when the runtime has none', (
    tester,
  ) async {
    final location = const GeoPoint(longitude: 121.5, latitude: 25.0);
    final locationController = _FakeLocationController(location);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, locationController: locationController),
    );
    await _finishLoad(tester);

    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    expect(locationController.requests, 1);
    expect(bridge.routeCalls, 1);
    expect(find.text('目前位置：已取得'), findsOneWidget);
  });

  testWidgets('keeps the route sheet open and explains a location failure', (
    tester,
  ) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, locationController: _FakeLocationController(null)),
    );
    await _finishLoad(tester);

    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    expect(find.text('無法取得目前位置，請開啟瀏覽器或裝置定位權限'), findsOneWidget);
    expect(bridge.routeCalls, 0);
  });

  testWidgets('rejects a shelter without an id before calling Android', (
    tester,
  ) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, features: const <StaticFeature>[_invalidShelter]),
    );
    await _finishLoad(tester);

    await _openShelterDetails(tester, '無編號避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    expect(find.text('起點或避難所資料不完整'), findsOneWidget);
    expect(bridge.routeCalls, 0);
  });

  testWidgets('renders every native route status without a fallback line', (
    tester,
  ) async {
    final expected = <EvacuationRouteStatus, String>{
      EvacuationRouteStatus.noRoute: '找不到可達路線',
      EvacuationRouteStatus.graphUnavailable: '離線路網尚未載入',
      EvacuationRouteStatus.invalidInput: '起點或避難所資料不完整',
    };
    for (final entry in expected.entries) {
      await tester.pumpWidget(
        _app(bridge: _RouteBridge(result: _routeStatus(entry.key))),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();

      expect(find.text(entry.value), findsOneWidget);
      expect(find.textContaining('距離：'), findsNothing);
      expect(find.text('MapLibre 台灣離線地圖預覽'), findsOneWidget);
    }
  });

  testWidgets('bridge unavailability is an honest route failure', (
    tester,
  ) async {
    final bridge = _RouteBridge(
      failure: const BridgeFailure(
        code: BridgeFailureCode.unavailable,
        message: 'missing plugin',
      ),
    );
    await tester.pumpWidget(_app(bridge: bridge));
    await _finishLoad(tester);
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    expect(find.text('此功能需要 Android App，Chrome 僅供地圖與資料預覽'), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
  });

  testWidgets(
    'keeps an unverified warning visible without blocking the route',
    (tester) async {
      final bridge = _RouteBridge(result: _okRoute(withWarning: true));
      await tester.pumpWidget(_app(bridge: bridge));
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();

      expect(find.text('距離：1.2 公里'), findsOneWidget);
      expect(find.text('附近有未驗證警示，請現場確認'), findsOneWidget);
      expect(find.text('受路線快照排除事件：'), findsNothing);
    },
  );

  testWidgets('identical event replay does not stale a ready route', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final first = _event('road:one', 1);
    final second = _event('road:two', 1);
    await tester.pumpWidget(
      _app(
        bridge: _RouteBridge(result: _okRoute()),
        events: <MeshEvent>[first, second],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    updates.add(<MeshEvent>[second, first]);
    await tester.pump();
    expect(find.text('路線資訊已變更，請重新計算'), findsNothing);
  });

  testWidgets('bursts hide the old line and automatically recalculate once', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final first = _event('road:one', 1);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        events: <MeshEvent>[first],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    updates.add(<MeshEvent>[_event('road:one', 2)]);
    await tester.pump();
    expect(tester.widget<MapCanvas>(find.byType(MapCanvas)).route, isNull);
    expect(find.text('道路狀態更新，正在自動重新規劃'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 400));
    updates.add(<MeshEvent>[_event('road:one', 3)]);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(bridge.routeCalls, 1);
    await tester.pump(const Duration(milliseconds: 201));
    expect(bridge.routeCalls, 2);
    expect(find.text('道路狀態更新，已自動重新規劃'), findsOneWidget);
    expect(find.text('距離：1.2 公里'), findsOneWidget);
  });

  testWidgets(
    'event change during calculation discards the result and waits for native work',
    (tester) async {
      final updates = StreamController<List<MeshEvent>>.broadcast();
      addTearDown(updates.close);
      final pending = Completer<EvacuationRouteResult>();
      final latest = Completer<EvacuationRouteResult>();
      final bridge = _RouteBridge(pendings: [pending, latest]);
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          events: <MeshEvent>[_event('road:one', 1)],
          eventUpdates: updates.stream,
        ),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      updates.add(<MeshEvent>[_event('road:one', 2)]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 601));
      expect(bridge.routeCalls, 1);

      pending.complete(_okRoute());
      await tester.pump();
      expect(find.text('距離：1.2 公里'), findsNothing);
      expect(bridge.routeCalls, 2);
      latest.complete(_okRoute(distanceM: 1500));
      await tester.pump();
      expect(find.text('距離：1.5 公里'), findsOneWidget);
    },
  );

  testWidgets(
    'automatic recalculation reuses a manually selected destination',
    (tester) async {
      final updates = StreamController<List<MeshEvent>>.broadcast();
      addTearDown(updates.close);
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          events: <MeshEvent>[_event('road:one', 1)],
          eventUpdates: updates.stream,
        ),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      updates.add(<MeshEvent>[_event('road:one', 2)]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 601));

      expect(bridge.routeCalls, 2);
      expect(bridge.destinations[0].id, bridge.destinations[1].id);
      expect(bridge.destinations[0].location, bridge.destinations[1].location);
    },
  );

  testWidgets('ignores an older response after the route sheet is closed', (
    tester,
  ) async {
    final first = Completer<EvacuationRouteResult>();
    final second = Completer<EvacuationRouteResult>();
    final bridge = _RouteBridge(
      pendings: <Completer<EvacuationRouteResult>>[first, second],
    );
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        features: const <StaticFeature>[_shelter, _secondShelter],
      ),
    );
    await _finishLoad(tester);

    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();
    await tester.tap(find.byTooltip('關閉路線'));
    await tester.pump();
    await _openShelterDetails(tester, '第二避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    first.complete(_okRoute(distanceM: 999));
    await tester.pump();
    expect(find.text('距離：999 公尺'), findsNothing);

    second.complete(_okRoute(distanceM: 700));
    await tester.pump();
    expect(find.text('距離：700 公尺'), findsOneWidget);
  });

  testWidgets(
    'recommends the lowest Android route distance, not air distance',
    (tester) async {
      final bridge = _RouteBridge(
        resultsByShelterId: <String, EvacuationRouteResult>{
          'shelter:a': _okRoute(distanceM: 1500),
          'shelter:b': _okRoute(distanceM: 700),
          'shelter:c': _routeStatus(EvacuationRouteStatus.noRoute),
        },
      );
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          features: const <StaticFeature>[_shelterA, _shelterB, _shelterC],
        ),
      );
      await _finishLoad(tester);

      await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
      await tester.pump();

      expect(bridge.routeCalls, 3);
      expect(find.text('距離：700 公尺'), findsOneWidget);
      expect(find.text('距離：1500 公尺'), findsNothing);
      expect(find.text('找不到可達路線'), findsNothing);
    },
  );

  testWidgets('recommendation reports no shelters without a fake route', (
    tester,
  ) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, features: const <StaticFeature>[]),
    );
    await _finishLoad(tester);

    await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
    await tester.pump();

    expect(find.text('20 公里內沒有可推薦的避難所'), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
    expect(bridge.routeCalls, 0);
  });

  testWidgets(
    'recommendation reaches the sixth shelter after five unreachable candidates',
    (tester) async {
      final pending = List.generate(
        7,
        (_) => Completer<EvacuationRouteResult>(),
      );
      final bridge = _RouteBridge(pendings: pending);
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          features: List<StaticFeature>.generate(
            7,
            (index) => StaticFeature(
              id: 'shelter:$index',
              kind: 'shelter',
              geometry: PointGeometry(
                GeoPoint(longitude: 121.50 + index / 1000, latitude: 25.0),
              ),
              fields: <String, dynamic>{'name': '候選避難所$index'},
              properties: null,
            ),
          ),
        ),
      );
      await _finishLoad(tester);

      await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
      await tester.pump();
      expect(find.text('正在比較可達避難所（1/7）'), findsOneWidget);
      expect(bridge.routeCalls, 1);

      for (var index = 0; index < pending.length; index += 1) {
        pending[index].complete(
          index == 5
              ? _okRoute(distanceM: 1000)
              : _routeStatus(EvacuationRouteStatus.noRoute),
        );
        await tester.pump();
      }
      expect(bridge.routeCalls, 7);
      expect(find.text('距離：1.0 公里'), findsOneWidget);
    },
  );

  testWidgets('recommendation aborts on graph failure without interim route', (
    tester,
  ) async {
    final bridge = _RouteBridge(
      resultsByShelterId: <String, EvacuationRouteResult>{
        'shelter:a': _routeStatus(EvacuationRouteStatus.graphUnavailable),
        'shelter:b': _okRoute(distanceM: 100),
      },
    );
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        features: const <StaticFeature>[_shelterA, _shelterB],
      ),
    );
    await _finishLoad(tester);

    await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
    await tester.pump();

    expect(find.text('離線路網尚未載入'), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
    expect(bridge.routeCalls, 1);
  });

  testWidgets('recommendation restarts when event data changes', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final pending = Completer<EvacuationRouteResult>();
    await tester.pumpWidget(
      _app(
        bridge: _RouteBridge(pending: pending),
        features: const <StaticFeature>[_shelterA, _shelterB],
        events: <MeshEvent>[_event('road:one', 1)],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);

    await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
    await tester.pump();
    updates.add(<MeshEvent>[_event('road:one', 2)]);
    await tester.pump();
    pending.complete(_okRoute(distanceM: 100));
    await tester.pump();

    expect(find.text('道路狀態更新，正在自動重新規劃'), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
    await tester.pump(const Duration(milliseconds: 601));
    expect(find.text('距離：100 公尺'), findsOneWidget);
    expect(find.text('道路狀態更新，已自動重新規劃'), findsOneWidget);
  });

  testWidgets('route and alert actions remain reachable at 390dp', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    await tester.pumpWidget(
      _app(
        bridge: _RouteBridge(result: _okRoute()),
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);

    expect(find.bySemanticsLabel('回報警示'), findsOneWidget);
    expect(find.bySemanticsLabel('推薦最近避難所'), findsOneWidget);
    await _openShelterDetails(tester, '測試避難所');
    await tester.ensureVisible(find.text('規劃逃生路線'));
    expect(find.text('規劃逃生路線'), findsOneWidget);
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    updates.add(<MeshEvent>[_event('road:changed', 1)]);
    await tester.pump();
    expect(find.text('道路狀態更新，正在自動重新規劃'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 601));
    expect(find.text('道路狀態更新，已自動重新規劃'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'recommendation compares shelters again after shelter status changes',
    (tester) async {
      final updates = StreamController<List<MeshEvent>>.broadcast();
      addTearDown(updates.close);
      final results = {
        'shelter:a': _okRoute(distanceM: 300),
        'shelter:b': _okRoute(distanceM: 700),
      };
      final bridge = _RouteBridge(resultsByShelterId: results);
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          features: [_shelterA, _shelterB],
          eventUpdates: updates.stream,
        ),
      );
      await _finishLoad(tester);
      await tester.tap(find.bySemanticsLabel('推薦最近避難所'));
      await tester.pump();
      expect(find.text('目的地：候選 A'), findsOneWidget);
      results['shelter:a'] = _routeStatus(EvacuationRouteStatus.noRoute);
      updates.add([_event('shelter:status', 1, type: 'SHELTER_STATUS')]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 601));
      expect(bridge.routeCalls, 4);
      expect(find.text('目的地：候選 B'), findsOneWidget);
      expect(find.text('避難所狀態更新，已自動重新規劃'), findsOneWidget);
    },
  );

  testWidgets('closing during debounce cancels automatic recalculation', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(_app(bridge: bridge, eventUpdates: updates.stream));
    await _finishLoad(tester);
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();
    updates.add([_event('road:one', 1)]);
    await tester.pump();
    await tester.tap(find.byTooltip('關閉路線'));
    await tester.pump(const Duration(seconds: 2));
    expect(bridge.routeCalls, 1);
    expect(find.text('逃生路線'), findsNothing);
  });

  testWidgets('unrelated official updates do not recalculate a route', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(_app(bridge: bridge, eventUpdates: updates.stream));
    await _finishLoad(tester);
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();
    updates.add([_event('medical:one', 1, type: 'MEDICAL_STATUS')]);
    await tester.pump(const Duration(seconds: 2));
    expect(bridge.routeCalls, 1);
    expect(find.text('距離：1.2 公里'), findsOneWidget);
  });

  testWidgets(
    'expiry refreshes without a native snapshot or new location request',
    (tester) async {
      var now = DateTime.utc(2030);
      final location = _FakeLocationController(
        const GeoPoint(longitude: 121.5, latitude: 25),
      );
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(
        _app(
          bridge: bridge,
          locationController: location,
          routeClock: () => now,
          events: [
            _event(
              'road:expiring',
              1,
              expiresAt: now.add(const Duration(seconds: 2)).toIso8601String(),
            ),
          ],
        ),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      now = now.add(const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('事件到期，正在自動重新規劃'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 601));
      expect(bridge.routeCalls, 2);
      expect(location.requests, 1);
    },
  );

  testWidgets(
    'background changes wait until resumed then use the latest snapshot',
    (tester) async {
      final updates = StreamController<List<MeshEvent>>.broadcast();
      addTearDown(updates.close);
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(
        _app(bridge: bridge, eventUpdates: updates.stream),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      updates.add([_event('road:one', 1)]);
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(bridge.routeCalls, 1);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(bridge.routeCalls, 2);
    },
  );

  testWidgets(
    'failed automatic refresh removes the old line and allows retry',
    (tester) async {
      final updates = StreamController<List<MeshEvent>>.broadcast();
      addTearDown(updates.close);
      final bridge = _RouteBridge(result: _okRoute());
      await tester.pumpWidget(
        _app(bridge: bridge, eventUpdates: updates.stream),
      );
      await _finishLoad(tester);
      await _openShelterDetails(tester, '測試避難所');
      await tester.tap(find.text('規劃逃生路線'));
      await tester.pump();
      bridge.failure = const BridgeFailure(
        code: BridgeFailureCode.routeEngineError,
        message: 'test',
      );
      updates.add([_event('road:one', 1)]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 601));
      expect(find.text('道路狀態更新，重新規劃失敗，請重試'), findsOneWidget);
      expect(tester.widget<MapCanvas>(find.byType(MapCanvas)).route, isNull);
      await tester.pump(const Duration(seconds: 3));
      expect(bridge.routeCalls, 2);
      bridge.failure = null;
      await tester.tap(
        find.byKey(const ValueKey('recalculate-evacuation-route')),
      );
      await tester.pump();
      expect(bridge.routeCalls, 3);
      expect(find.text('距離：1.2 公里'), findsOneWidget);
    },
  );
  testWidgets('routes to a medical facility as a plain walking route', (
    tester,
  ) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, features: const <StaticFeature>[_shelter, _medical]),
    );
    await _finishLoad(tester);

    await _openWalkingDetails(tester, '慈安診所');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    expect(bridge.routeCalls, 1);
    expect(bridge.lastDestination?.id, 'medical:test');
    expect(bridge.lastDestination?.kind, RouteDestinationKind.medical);
    expect(bridge.lastDisasterType, isNull);
    expect(find.text('步行路線'), findsOneWidget);
    expect(find.text('目的地：慈安診所'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('walking-route-disclaimer')),
      findsOneWidget,
    );
    expect(find.text('距離：1.2 公里'), findsOneWidget);
  });

  testWidgets('a requested route moves the camera onto it', (tester) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(_app(bridge: bridge, eventUpdates: updates.stream));
    await _finishLoad(tester);
    final before = tester.widget<MapCanvas>(find.byType(MapCanvas));
    await _openShelterDetails(tester, '測試避難所');
    await tester.tap(find.text('規劃逃生路線'));
    await tester.pump();

    final canvas = tester.widget<MapCanvas>(find.byType(MapCanvas));
    expect(canvas.focusRequestId, greaterThan(before.focusRequestId));
    expect(canvas.focusBounds?.southwest.longitude, closeTo(121.5, 1e-9));
    expect(canvas.focusBounds?.northeast.latitude, closeTo(25.083506, 1e-9));

    // An automatic refresh keeps the camera where the user has moved it.
    final focused = canvas.focusRequestId;
    updates.add(<MeshEvent>[_event('road:one', 1)]);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 601));
    expect(bridge.routeCalls, 2);
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).focusRequestId,
      focused,
    );
  });

  testWidgets('Chrome explains that walking routes need the Android App', (
    tester,
  ) async {
    final bridge = _RouteBridge(
      failure: const BridgeFailure(
        code: BridgeFailureCode.unavailable,
        message: 'missing plugin',
      ),
    );
    await tester.pumpWidget(
      _app(bridge: bridge, features: const <StaticFeature>[_medical]),
    );
    await _finishLoad(tester);
    await _openWalkingDetails(tester, '慈安診所');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    expect(find.text('此功能需要 Android App，Chrome 僅供地圖與資料預覽'), findsOneWidget);
    expect(find.textContaining('距離：'), findsNothing);
  });

  testWidgets('routes to a supply station announcement', (tester) async {
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(bridge: bridge, events: <MeshEvent>[_supply(1)]),
    );
    await _finishLoad(tester);
    await _openWalkingDetails(tester, '事件：物資發放點');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    expect(bridge.routeCalls, 1);
    expect(bridge.lastDestination?.kind, RouteDestinationKind.supply);
    expect(
      bridge.lastDestination?.location,
      const GeoPoint(longitude: 121.56, latitude: 25.06),
    );
    expect(bridge.lastDisasterType, isNull);
    expect(find.text('步行路線'), findsOneWidget);
    expect(find.text('目的地：物資發放點'), findsOneWidget);
    expect(find.text('距離：1.2 公里'), findsOneWidget);
  });

  testWidgets('a supply status update automatically refreshes the route', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        events: <MeshEvent>[_supply(1)],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);
    await _openWalkingDetails(tester, '事件：物資發放點');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    updates.add(<MeshEvent>[_supply(2, longitude: 121.565)]);
    await tester.pump();
    expect(find.text('物資狀態更新，正在自動重新規劃'), findsOneWidget);
    expect(find.text('正在更新步行路線…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 601));

    expect(bridge.routeCalls, 2);
    expect(find.text('物資狀態更新，已自動重新規劃'), findsOneWidget);
    // The moved station is routed to at its new point, not the tapped one.
    expect(
      bridge.lastDestination?.location,
      const GeoPoint(longitude: 121.565, latitude: 25.06),
    );
  });

  testWidgets('other supply points do not refresh a supply route', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        events: <MeshEvent>[_supply(1)],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);
    await _openWalkingDetails(tester, '事件：物資發放點');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    updates.add(<MeshEvent>[_supply(1), _supply(1, id: 'supply:other')]);
    await tester.pump(const Duration(seconds: 2));
    expect(bridge.routeCalls, 1);
  });

  testWidgets('a withdrawn supply point stops routing with a reason', (
    tester,
  ) async {
    final updates = StreamController<List<MeshEvent>>.broadcast();
    addTearDown(updates.close);
    final bridge = _RouteBridge(result: _okRoute());
    await tester.pumpWidget(
      _app(
        bridge: bridge,
        events: <MeshEvent>[_supply(1)],
        eventUpdates: updates.stream,
      ),
    );
    await _finishLoad(tester);
    await _openWalkingDetails(tester, '事件：物資發放點');
    await tester.tap(find.text('規劃步行路線'));
    await tester.pump();

    updates.add(<MeshEvent>[_supply(2, retracted: true)]);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 601));

    expect(bridge.routeCalls, 1);
    expect(find.text('此物資點已撤回或不再提供'), findsOneWidget);
    expect(find.text('事件到期，已停止規劃'), findsOneWidget);
    expect(find.textContaining('請重試'), findsNothing);
    expect(
      find.byKey(const ValueKey('recalculate-evacuation-route')),
      findsNothing,
    );
    expect(tester.widget<MapCanvas>(find.byType(MapCanvas)).route, isNull);
  });
}

Future<void> _openWalkingDetails(WidgetTester tester, String label) async {
  await tester.tap(find.bySemanticsLabel(label));
  await tester.pump();
  expect(find.text('規劃步行路線'), findsOneWidget);
}

Future<void> _openShelterDetails(WidgetTester tester, String name) async {
  await tester.tap(find.bySemanticsLabel(name));
  await tester.pump();
  expect(find.text('規劃逃生路線'), findsOneWidget);
}

Future<void> _finishLoad(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Widget _app({
  required MapBridge bridge,
  List<StaticFeature> features = const <StaticFeature>[_shelter],
  List<MeshEvent> events = const <MeshEvent>[],
  Stream<List<MeshEvent>>? eventUpdates,
  LocationController? locationController,
  DateTime Function()? routeClock,
}) => MaterialApp(
  home: MapScreen(
    key: UniqueKey(),
    staticFeatures: StaticFeatureCollection(
      schemaVersion: 'test',
      datasetId: 'test',
      snapshotAt: '2026-09-25T00:00:00Z',
      features: features,
    ),
    initialState: MapInitialState(events: events, emergencyModeEnabled: false),
    bridge: bridge,
    eventUpdates: eventUpdates,
    routeClock: routeClock,
    locationController:
        locationController ??
        _FakeLocationController(
          const GeoPoint(longitude: 121.5, latitude: 25.0),
        ),
  ),
);

class _RouteBridge extends MapBridge {
  _RouteBridge({
    this.result,
    this.failure,
    this.pending,
    this.pendings,
    this.resultsByShelterId,
  }) : super(methodChannel: const MethodChannel('test/route-flow'));

  final EvacuationRouteResult? result;
  BridgeFailure? failure;
  final Completer<EvacuationRouteResult>? pending;
  final List<Completer<EvacuationRouteResult>>? pendings;
  final Map<String, EvacuationRouteResult>? resultsByShelterId;
  int routeCalls = 0;
  GeoPoint? lastOrigin;
  ShelterRouteCandidate? lastDestination;
  String? lastMode;
  DisasterType? lastDisasterType;
  final List<ShelterRouteCandidate> destinations = <ShelterRouteCandidate>[];

  @override
  Future<MapInitialState> getInitialState() async =>
      const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false);

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();

  @override
  Future<EvacuationRouteResult> calculateEvacuationRoute({
    required GeoPoint origin,
    required ShelterRouteCandidate destination,
    String mode = 'walk',
    DisasterType? disasterType,
  }) {
    routeCalls += 1;
    lastOrigin = origin;
    lastDestination = destination;
    lastMode = mode;
    lastDisasterType = disasterType;
    destinations.add(destination);
    final error = failure;
    if (error != null) return Future<EvacuationRouteResult>.error(error);
    final queue = pendings;
    if (queue != null) return queue[routeCalls - 1].future;
    final waiting = pending;
    if (waiting != null) return waiting.future;
    final selected = resultsByShelterId?[destination.id] ?? result;
    return Future<EvacuationRouteResult>.value(selected!);
  }
}

class _FakeLocationController extends LocationController {
  _FakeLocationController(this.result);

  final GeoPoint? result;
  int requests = 0;

  @override
  Stream<GeoPoint> get locations => const Stream<GeoPoint>.empty();

  @override
  Future<GeoPoint?> requestCurrentLocation() async {
    requests += 1;
    return result;
  }
}

EvacuationRouteResult _okRoute({
  double distanceM = 1200,
  bool withWarning = false,
}) => EvacuationRouteResult(
  status: EvacuationRouteStatus.ok,
  polyline: const <GeoPoint>[
    GeoPoint(longitude: 121.5, latitude: 25.0),
    GeoPoint(longitude: 121.55, latitude: 25.04),
    GeoPoint(longitude: 121.590304, latitude: 25.083506),
  ],
  distanceM: distanceM,
  durationS: 900,
  graphVersion: 'taiwan-walk-test',
  eventSnapshotAt: '2026-09-25T00:00:00Z',
  warnings:
      withWarning
          ? const <RouteWarning>[
            RouteWarning(
              code: 'UNVERIFIED_CROWD_REPORT',
              eventId: 'report:test',
              message: '附近有未驗證警示，請現場確認',
            ),
          ]
          : const <RouteWarning>[],
  blockedEventIds: const <String>[],
);

EvacuationRouteResult _routeStatus(EvacuationRouteStatus status) =>
    EvacuationRouteResult(
      status: status,
      polyline: const <GeoPoint>[],
      distanceM: null,
      durationS: null,
      graphVersion: null,
      eventSnapshotAt: null,
      warnings: const <RouteWarning>[],
      blockedEventIds: const <String>[],
    );

MeshEvent _event(
  String id,
  int version, {
  String type = 'ROAD_STATUS',
  String? expiresAt,
}) => MeshEvent(
  namespace: 'official',
  eventId: id,
  eventVersion: version,
  eventType: type,
  severity: 'HIGH',
  source: 'test',
  issuedAt: null,
  expiresAt: expiresAt,
  applyState: 'CURRENT',
  geometry: const PointGeometry(GeoPoint(longitude: 121.55, latitude: 25.04)),
  attributes: null,
);

const _shelter = StaticFeature(
  id: 'shelter:test',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.590304, latitude: 25.083506)),
  fields: <String, dynamic>{'name': '測試避難所', 'available_count': null},
  properties: null,
);

const _secondShelter = StaticFeature(
  id: 'shelter:second',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.61, latitude: 25.09)),
  fields: <String, dynamic>{'name': '第二避難所', 'available_count': null},
  properties: null,
);

const _invalidShelter = StaticFeature(
  id: null,
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.590304, latitude: 25.083506)),
  fields: <String, dynamic>{'name': '無編號避難所', 'available_count': null},
  properties: null,
);

const _shelterA = StaticFeature(
  id: 'shelter:a',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.51, latitude: 25.01)),
  fields: <String, dynamic>{'name': '候選 A'},
  properties: null,
);

const _shelterB = StaticFeature(
  id: 'shelter:b',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.52, latitude: 25.02)),
  fields: <String, dynamic>{'name': '候選 B'},
  properties: null,
);

const _shelterC = StaticFeature(
  id: 'shelter:c',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.53, latitude: 25.03)),
  fields: <String, dynamic>{'name': '候選 C'},
  properties: null,
);

const _medical = StaticFeature(
  id: 'medical:test',
  kind: 'medical',
  geometry: PointGeometry(GeoPoint(longitude: 121.57, latitude: 25.07)),
  fields: <String, dynamic>{'name': '慈安診所'},
  properties: null,
);

MeshEvent _supply(
  int version, {
  String id = 'supply:test',
  double longitude = 121.56,
  bool retracted = false,
}) => MeshEvent(
  namespace: 'official.announcement',
  eventId: id,
  eventVersion: version,
  eventType: 'GOVERNMENT_ANNOUNCEMENT',
  severity: 'LOW',
  source: 'GOVERNMENT',
  issuedAt: '2026-10-20T00:00:00Z',
  expiresAt: retracted ? '2026-10-21T00:00:00Z' : '2099-01-01T00:00:00Z',
  applyState: retracted ? 'EXPIRED' : 'CURRENT',
  geometry: PointGeometry(
    id == 'supply:test'
        ? GeoPoint(longitude: longitude, latitude: 25.06)
        : const GeoPoint(longitude: 121.58, latitude: 25.05),
  ),
  attributes: <String, dynamic>{
    'category': 'SUPPLY_STATION',
    'has_map_location': true,
    'title': id == 'supply:test' ? '物資發放點' : '另一物資點',
    if (retracted) 'publication_retracted': true,
  },
  payloadHash: 'sha256:$id:$version:$longitude',
);
