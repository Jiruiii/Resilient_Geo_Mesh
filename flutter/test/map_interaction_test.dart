import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/location_controller.dart';
import 'package:resilientgeo_flutter/data/map_basemap.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';
import 'package:resilientgeo_flutter/widgets/map_canvas.dart';

void main() {
  testWidgets('NCDR notification focuses the full affected extent', (
    tester,
  ) async {
    const warning = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:multi-wind',
      eventVersion: 2,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: 'CURRENT',
      geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 119, latitude: 26),
            GeoPoint(longitude: 120, latitude: 26),
            GeoPoint(longitude: 119, latitude: 26),
          ],
        ],
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 122, latitude: 22),
            GeoPoint(longitude: 122, latitude: 23),
            GeoPoint(longitude: 122, latitude: 22),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 55,
        'area_match_complete': true,
        'map_visible': true,
      },
    );
    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        events: const <MeshEvent>[warning],
      ),
    );
    await _finishMapLoad(tester);
    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        events: const <MeshEvent>[warning],
        notificationFocusEvent: warning,
        notificationFocusRequestId: 1,
      ),
    );
    await tester.pump();
    final canvas = tester.widget<MapCanvas>(find.byType(MapCanvas));
    expect(
      canvas.focusBounds?.southwest,
      const GeoPoint(longitude: 119, latitude: 22),
    );
    expect(
      canvas.focusBounds?.northeast,
      const GeoPoint(longitude: 122, latitude: 26),
    );
  });

  testWidgets('NCDR details label administrative mask as an affected area', (
    tester,
  ) async {
    const warning = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:wind',
      eventVersion: 2,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: 'CURRENT',
      geometry: MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 120, latitude: 23),
            GeoPoint(longitude: 121, latitude: 23),
            GeoPoint(longitude: 120, latitude: 23),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'affected_area': '新北市三芝區；臺東縣蘭嶼鄉',
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 2,
        'area_match_complete': true,
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.event(event: warning, onClose: () {}),
        ),
      ),
    );
    expect(find.textContaining('警報涵蓋行政區（非精確風害位置）'), findsOneWidget);
  });

  testWidgets('long NCDR area details scroll without overflowing', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 480);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final warning = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:wind-long-details',
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: 'CURRENT',
      geometry: const MultiPolygonGeometry(<List<List<GeoPoint>>>[
        <List<GeoPoint>>[
          <GeoPoint>[
            GeoPoint(longitude: 120, latitude: 23),
            GeoPoint(longitude: 121, latitude: 23),
            GeoPoint(longitude: 120, latitude: 23),
          ],
        ],
      ]),
      attributes: <String, dynamic>{
        'affected_area': List<String>.filled(55, '新北市三芝區').join('；'),
        'geometry_source': 'administrative_boundary',
        'affected_area_count': 55,
        'area_match_complete': true,
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.event(event: warning, onClose: () {}),
        ),
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.byType(SingleChildScrollView), findsOneWidget);
    await tester.drag(
      find.byType(SingleChildScrollView),
      const Offset(0, -500),
    );
    await tester.pumpAndSettle();
    expect(find.text('資料狀態：有效'), findsOneWidget);
  });

  testWidgets('county warning map details name its area reference point', (
    tester,
  ) async {
    final event = MeshEvent.fromJson(<String, dynamic>{
      ..._eventJson('Point', <dynamic>[119.6, 23.6]),
      'source': 'CWA',
      'attributes': <String, dynamic>{
        'affected_area': '澎湖縣',
        'coverage_level': 'county',
        'map_location_kind': 'area_reference',
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.event(event: event, onClose: () {}),
        ),
      ),
    );

    expect(find.text('影響範圍：澎湖縣（縣市級警報）'), findsOneWidget);
    expect(find.text('地圖位置：影響範圍參考點（非告警發生的精確位置）'), findsOneWidget);
  });

  testWidgets(
    'forecast warning map details do not call its start publication',
    (tester) async {
      final start = DateTime.now().toUtc().add(const Duration(days: 1));
      final event = MeshEvent(
        namespace: 'official.live.cwa-warning',
        eventId: 'cwa:warning:w-c0033-001:10004:2026-10-21-11:00:00:0',
        eventVersion: 1,
        eventType: 'WEATHER_WARNING',
        severity: 'UNKNOWN',
        source: 'CWA',
        issuedAt: start.toIso8601String(),
        expiresAt: start.add(const Duration(hours: 12)).toIso8601String(),
        applyState: 'CURRENT',
        geometry: const PointGeometry(GeoPoint(longitude: 121.5, latitude: 25)),
        attributes: const <String, dynamic>{},
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FeatureDetailsSheet.event(event: event, onClose: () {}),
          ),
        ),
      );

      expect(find.text('發布時間：來源未提供'), findsOneWidget);
      expect(find.textContaining('影響時段開始：'), findsOneWidget);
      expect(find.textContaining('資料狀態：尚未生效'), findsOneWidget);
    },
  );

  test('parses point, line, and polygon event geometries', () {
    final point = MeshEvent.fromJson(
      _eventJson('Point', <dynamic>[121.59, 25.08]),
    );
    final line = MeshEvent.fromJson(
      _eventJson('LineString', <dynamic>[
        <dynamic>[121.58, 25.07],
        <dynamic>[121.59, 25.08],
      ]),
    );
    final polygon = MeshEvent.fromJson(
      _eventJson('Polygon', <dynamic>[
        <dynamic>[
          <dynamic>[121.58, 25.07],
          <dynamic>[121.60, 25.07],
          <dynamic>[121.60, 25.09],
          <dynamic>[121.58, 25.07],
        ],
      ]),
    );

    expect(point.geometry, isA<PointGeometry>());
    expect(line.geometry, isA<LineStringGeometry>());
    expect(polygon.geometry, isA<PolygonGeometry>());
  });

  test('Android apply_state controls expired event display state', () {
    final event = MeshEvent.fromJson(
      _eventJson('Point', <dynamic>[121.59, 25.08], applyState: 'EXPIRED'),
    );

    expect(event.isExpired, isTrue);
  });

  testWidgets(
    'tapping a shelter shows planned capacity without live occupancy',
    (tester) async {
      await tester.pumpWidget(
        _testApp(features: const <StaticFeature>[_shelter]),
      );
      await _finishMapLoad(tester);

      await tester.tap(find.bySemanticsLabel('潭美國小'));
      await tester.pump();

      expect(find.text('潭美國小'), findsOneWidget);
      expect(find.text('預計收容人數：81人'), findsOneWidget);
      expect(find.text('收容人數：無資料'), findsNothing);
      expect(find.text('來源：taipei-shelter'), findsOneWidget);
      expect(find.text('更新時間：2026-9-5 00:00:00'), findsOneWidget);
      expect(find.text('資料更新：2026/09/5 08:00:00'), findsOneWidget);
    },
  );

  testWidgets('tapping a medical marker opens medical details', (tester) async {
    await tester.pumpWidget(
      _testApp(features: const <StaticFeature>[_medical]),
    );
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('三軍總醫院內湖院區'));
    await tester.pump();

    expect(find.text('三軍總醫院內湖院區'), findsOneWidget);
    expect(find.text('類型：醫院'), findsOneWidget);
    expect(find.text('來源：taipei-medical'), findsOneWidget);
  });

  testWidgets('does not render an expired event on the map', (tester) async {
    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        events: <MeshEvent>[_expiredEvent],
      ),
    );
    await _finishMapLoad(tester);

    expect(find.bySemanticsLabel('事件：內湖模擬淹水，已過期'), findsNothing);
    expect(find.byType(FeatureDetailsSheet), findsNothing);
  });

  testWidgets('overlapping shelter and medical markers show every record', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testApp(features: const <StaticFeature>[_shelter, _medicalAtShelter]),
    );
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('潭美國小、測試醫院（地圖標記）'));
    await tester.pumpAndSettle();

    expect(find.text('選擇地點'), findsOneWidget);
    expect(find.text('潭美國小'), findsOneWidget);
    expect(find.text('測試醫院'), findsOneWidget);
  });

  testWidgets('layer panel can hide the event layer', (tester) async {
    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        events: <MeshEvent>[_expiredEvent],
      ),
    );
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('圖層設定'));
    await tester.pumpAndSettle();
    expect(find.text('災情事件'), findsOneWidget);

    await tester.tap(find.byType(Switch).at(2));
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch).at(2)).value, isFalse);
    expect(find.bySemanticsLabel('事件：內湖模擬淹水，已過期'), findsNothing);
  });

  testWidgets('base map changes from the parent refresh the open layer panel', (
    tester,
  ) async {
    final host = GlobalKey<_BasemapHostState>();
    await tester.pumpWidget(MaterialApp(home: _BasemapHost(key: host)));
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('圖層設定'));
    await tester.pumpAndSettle();
    expect(find.text('目前：離線 OSM'), findsOneWidget);

    // A probe result arriving while the sheet is open rebuilds MapScreen.
    host.currentState!.setReachable(true);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.textContaining('目前：國土測繪圖資'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('basemap-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('離線 OSM｜').last);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(host.currentState!.mode, MapBasemapMode.osm);
    expect(find.text('目前：離線 OSM'), findsOneWidget);
    expect(
      tester
          .widget<MapCanvas>(find.byType(MapCanvas))
          .runtimeState
          .emapVisible,
      isFalse,
    );
  });

  testWidgets('county warning area switch keeps its own state', (tester) async {
    await tester.pumpWidget(_testApp(features: const <StaticFeature>[]));
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('圖層設定'));
    await tester.pumpAndSettle();
    final areaSwitch = find.widgetWithText(SwitchListTile, '警報影響範圍');
    final eventSwitch = find.widgetWithText(SwitchListTile, '災情事件');
    expect(tester.widget<SwitchListTile>(areaSwitch).value, isTrue);
    expect(tester.widget<SwitchListTile>(eventSwitch).value, isTrue);
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).showCountyWarningAreas,
      isTrue,
    );

    await tester.ensureVisible(areaSwitch);
    await tester.tap(areaSwitch);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(areaSwitch).value, isFalse);
    expect(tester.widget<SwitchListTile>(eventSwitch).value, isTrue);
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).showCountyWarningAreas,
      isFalse,
    );

    await tester.ensureVisible(eventSwitch);
    await tester.tap(eventSwitch);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(areaSwitch).value, isFalse);
    expect(tester.widget<SwitchListTile>(eventSwitch).value, isFalse);
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).showCountyWarningAreas,
      isFalse,
    );

    await tester.ensureVisible(areaSwitch);
    await tester.tap(areaSwitch);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(areaSwitch).value, isTrue);
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).showCountyWarningAreas,
      isFalse,
    );

    await tester.ensureVisible(eventSwitch);
    await tester.tap(eventSwitch);
    await tester.pumpAndSettle();
    expect(
      tester.widget<MapCanvas>(find.byType(MapCanvas)).showCountyWarningAreas,
      isTrue,
    );
  });

  testWidgets('local search selects a shelter and opens its details', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testApp(features: const <StaticFeature>[_shelter]),
    );
    await _finishMapLoad(tester);

    await tester.enterText(find.bySemanticsLabel('搜尋地點'), '潭美');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('潭美國小'), findsOneWidget);

    await tester.tap(find.text('潭美國小'));
    await tester.pump();
    expect(find.text('收容人數：無資料'), findsNothing);
    expect(find.byType(FeatureDetailsSheet), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('map-search-field')),
      findsOneWidget,
    );
  });

  testWidgets('tapping map whitespace closes an open feature sheet', (
    tester,
  ) async {
    await tester.pumpWidget(
      _testApp(features: const <StaticFeature>[_shelter]),
    );
    await _finishMapLoad(tester);

    await tester.tap(find.bySemanticsLabel('潭美國小'));
    await tester.pump();
    expect(find.byType(FeatureDetailsSheet), findsOneWidget);

    await tester.tap(find.text('MapLibre 台灣離線地圖預覽'));
    await tester.pump();

    expect(find.byType(FeatureDetailsSheet), findsNothing);
  });

  testWidgets('explicit current location updates marker and focus state', (
    tester,
  ) async {
    const location = GeoPoint(longitude: 121.545053, latitude: 25.011549);
    final controller = _FakeLocationController(location);
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        locationController: controller,
      ),
    );
    await _finishMapLoad(tester);

    await tester.tap(find.byTooltip('目前位置'));
    await tester.pump();

    expect(find.text('目前位置：已取得'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('current-location-marker')),
      findsOneWidget,
    );
  });

  testWidgets('failed current location preserves the previous location', (
    tester,
  ) async {
    const previousLocation = GeoPoint(
      longitude: 121.545053,
      latitude: 25.011549,
    );
    final controller = _FakeLocationController(previousLocation);
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      _testApp(
        features: const <StaticFeature>[],
        locationController: controller,
      ),
    );
    await _finishMapLoad(tester);
    await tester.tap(find.byTooltip('目前位置'));
    await tester.pump();
    expect(find.text('目前位置：已取得'), findsOneWidget);

    controller.result = null;
    await tester.tap(find.byTooltip('目前位置'));
    await tester.pump();

    expect(find.text('目前位置：已取得'), findsOneWidget);
    expect(find.text('無法取得目前位置，請開啟瀏覽器或裝置定位權限'), findsOneWidget);
  });

  testWidgets('selecting an offline road does not open a facility sheet', (
    tester,
  ) async {
    await tester.pumpWidget(_testApp(features: const <StaticFeature>[]));
    await _finishMapLoad(tester);

    await tester.enterText(find.bySemanticsLabel('搜尋地點'), '中山路');
    await tester.pump();
    expect(find.text('中山路'), findsWidgets);

    await tester.tap(find.text('中山路').first);
    await tester.pump();

    expect(find.byType(FeatureDetailsSheet), findsNothing);
    expect(find.text('資料更新：2026/09/5 08:00:00'), findsOneWidget);
  });
}

Future<void> _finishMapLoad(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 250));
}

Widget _testApp({
  required List<StaticFeature> features,
  List<MeshEvent> events = const <MeshEvent>[],
  LocationController? locationController,
  MeshEvent? notificationFocusEvent,
  int notificationFocusRequestId = 0,
}) => MaterialApp(
  home: MapScreen(
    staticFeatures: StaticFeatureCollection(
      schemaVersion: 'test',
      datasetId: 'test',
      snapshotAt: '2026-09-05T00:00:00Z',
      features: features,
    ),
    initialState: MapInitialState(events: events, emergencyModeEnabled: false),
    locationController: locationController,
    notificationFocusEvent: notificationFocusEvent,
    notificationFocusRequestId: notificationFocusRequestId,
  ),
);

/// Mirrors MapAppController: the parent owns the mode and reachability and
/// rebuilds MapScreen when either changes.
class _BasemapHost extends StatefulWidget {
  const _BasemapHost({super.key});

  @override
  State<_BasemapHost> createState() => _BasemapHostState();
}

class _BasemapHostState extends State<_BasemapHost> {
  MapBasemapMode mode = MapBasemapMode.auto;
  bool reachable = false;

  void setReachable(bool value) => setState(() => reachable = value);

  @override
  Widget build(BuildContext context) => MapScreen(
    staticFeatures: const StaticFeatureCollection(
      schemaVersion: 'test',
      datasetId: 'test',
      snapshotAt: '2026-09-05T00:00:00Z',
      features: <StaticFeature>[],
    ),
    initialState: const MapInitialState(
      events: <MeshEvent>[],
      emergencyModeEnabled: false,
    ),
    basemapMode: mode,
    emapReachable: reachable,
    onBasemapModeChanged: (value) => setState(() => mode = value),
  );
}

class _FakeLocationController extends LocationController {
  _FakeLocationController(this.result);

  GeoPoint? result;
  final StreamController<GeoPoint> _updates =
      StreamController<GeoPoint>.broadcast();

  @override
  Stream<GeoPoint> get locations => _updates.stream;

  @override
  Future<GeoPoint?> requestCurrentLocation() async => result;

  void emit(GeoPoint location) => _updates.add(location);

  @override
  Future<void> dispose() => _updates.close();
}

Map<String, dynamic> _eventJson(
  String geometryType,
  List<dynamic> coordinates, {
  String applyState = 'CURRENT',
}) => <String, dynamic>{
  'namespace': 'demo.neihu',
  'event_id': 'demo:event',
  'event_version': 1,
  'event_type': 'FLOOD_WARNING',
  'severity': 'CRITICAL',
  'source': 'demo',
  'issued_at': '2026-09-01T06:00:00Z',
  'expires_at': '2026-09-01T07:00:00Z',
  'apply_state': applyState,
  'geometry': <String, dynamic>{
    'type': geometryType,
    'coordinates': coordinates,
  },
  'attributes': <String, dynamic>{'name': '內湖模擬淹水'},
};

final _expiredEvent = MeshEvent.fromJson(
  _eventJson('Point', <dynamic>[121.590304, 25.083506], applyState: 'EXPIRED'),
);

const _shelter = StaticFeature(
  id: 'shelter:test',
  kind: 'shelter',
  geometry: PointGeometry(GeoPoint(longitude: 121.590304, latitude: 25.083506)),
  fields: <String, dynamic>{
    'name': '潭美國小',
    'address': '內湖區新明路22號',
    'capacity': 81,
    'available_count': null,
    'disaster_types': <String>['水災', '震災'],
    'source': 'taipei-shelter',
  },
  properties: null,
);

const _medical = StaticFeature(
  id: 'medical:test',
  kind: 'medical',
  geometry: PointGeometry(GeoPoint(longitude: 121.61, latitude: 25.09)),
  fields: <String, dynamic>{
    'name': '三軍總醫院內湖院區',
    'facility_type': '醫院',
    'address': '內湖區成功路二段325號',
    'source': 'taipei-medical',
  },
  properties: null,
);

const _medicalAtShelter = StaticFeature(
  id: 'medical:overlap',
  kind: 'medical',
  geometry: PointGeometry(GeoPoint(longitude: 121.590304, latitude: 25.083506)),
  fields: <String, dynamic>{
    'name': '測試醫院',
    'facility_type': '醫院',
    'address': '內湖測試路1號',
    'source': 'taipei-medical',
  },
  properties: null,
);
