import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/evacuation_models.dart';
import '../data/location_controller.dart';
import '../data/map_bridge.dart';
import '../data/map_models.dart';
import '../screens/map_screen.dart';

/// Used only by the debug Android RouteValidationActivity. Fixture events stay
/// in that activity's memory; routing uses the actual bundled Android graph.
void runRouteValidationApp() => runApp(const _RouteValidationApp());

const _validationChannel = MethodChannel(
  'com.resilientgeo.mesh/route-validation',
);
const _origin = GeoPoint(longitude: 121.5910, latitude: 25.0610);

class _RouteValidationApp extends StatefulWidget {
  const _RouteValidationApp();

  @override
  State<_RouteValidationApp> createState() => _RouteValidationAppState();
}

class _RouteValidationAppState extends State<_RouteValidationApp> {
  final _bridge = _ValidationBridge();
  final _location = _ValidationLocation();
  bool _active = true;
  String? _error;

  Future<void> _change(String phase) async {
    try {
      await _validationChannel.invokeMethod<void>('phase', phase);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  @override
  void dispose() {
    _bridge.calls.dispose();
    _location.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Text('路線實機測試（記憶體資料）'),
            ValueListenableBuilder<int>(
              valueListenable: _bridge.calls,
              builder: (_, calls, _) => Text('計算次數：$calls'),
            ),
            Wrap(
              children: [
                for (final entry
                    in {
                      'full': '額滿測試',
                      'open': '開放測試',
                      'expiry': '到期測試',
                      'burst': '連續更新測試',
                      'supply-move': '物資站移動',
                      'supply-retract': '物資站撤回',
                      'supply-reset': '物資站重設',
                    }.entries)
                  TextButton(
                    onPressed: () => _change(entry.key),
                    child: Text(entry.value),
                  ),
                TextButton(
                  onPressed: () => setState(() => _active = !_active),
                  child: Text(_active ? '暫停重算' : '恢復重算'),
                ),
              ],
            ),
            if (_error != null) Text(_error!),
            Expanded(
              child: MapScreen(
                active: _active,
                bridge: _bridge,
                eventUpdates: _bridge.events,
                locationController: _location,
                initialState: const MapInitialState(
                  events: [],
                  emergencyModeEnabled: false,
                ),
                staticFeatures: const StaticFeatureCollection(
                  schemaVersion: 'test',
                  datasetId: 'route-validation',
                  snapshotAt: '2030-01-01T00:00:00Z',
                  features: [
                    StaticFeature(
                      id: 'validation:a',
                      kind: 'shelter',
                      geometry: PointGeometry(
                        GeoPoint(longitude: 121.5990, latitude: 25.0600),
                      ),
                      fields: {'name': '測試避難所 A'},
                      properties: null,
                    ),
                    StaticFeature(
                      id: 'validation:b',
                      kind: 'shelter',
                      geometry: PointGeometry(
                        GeoPoint(longitude: 121.5920, latitude: 25.0600),
                      ),
                      fields: {'name': '測試避難所 B'},
                      properties: null,
                    ),
                    StaticFeature(
                      id: 'validation:medical',
                      kind: 'medical',
                      geometry: PointGeometry(
                        GeoPoint(longitude: 121.5945, latitude: 25.0625),
                      ),
                      fields: {'name': '測試醫療點', 'facility_type': '診所'},
                      properties: null,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _ValidationBridge extends MapBridge {
  _ValidationBridge()
    : super(
        methodChannel: const MethodChannel(
          'com.resilientgeo.mesh/route-validation/map',
        ),
        eventChannel: const EventChannel(
          'com.resilientgeo.mesh/route-validation/events',
        ),
      );

  final calls = ValueNotifier(0);

  @override
  Future<EvacuationRouteResult> calculateEvacuationRoute({
    required GeoPoint origin,
    required ShelterRouteCandidate destination,
    String mode = 'walk',
    DisasterType? disasterType,
  }) {
    calls.value++;
    return super.calculateEvacuationRoute(
      origin: origin,
      destination: destination,
      mode: mode,
      disasterType: disasterType,
    );
  }
}

class _ValidationLocation extends LocationController {
  @override
  Stream<GeoPoint> get locations => const Stream.empty();

  @override
  Future<GeoPoint?> requestCurrentLocation() async => _origin;
}
