import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../data/map_bridge.dart';
import '../data/map_models.dart';
import '../data/location_controller.dart';
import '../screens/map_screen.dart';
import '../theme/app_theme.dart';

/// Load buttons are disabled while a sync is running; say why instead of
/// leaving them silently dead.
String? drillRunningHint({required bool running}) =>
    running ? '同步進行中，無法載入或準備資料。要載入新版請先按「停止演練同步」，載入後再重新開始。' : null;

void runMeshDrillApp() =>
    runApp(MaterialApp(theme: AppTheme.light(), home: const MeshDrillScreen()));
const _channel = MethodChannel('com.resilientgeo.mesh/drill');

class MeshDrillScreen extends StatefulWidget {
  const MeshDrillScreen({super.key});
  @override
  State<MeshDrillScreen> createState() => _MeshDrillScreenState();
}

class _MeshDrillScreenState extends State<MeshDrillScreen> {
  final _bridge = MapBridge(
    methodChannel: _channel,
    eventChannel: const EventChannel('com.resilientgeo.mesh/drill/events'),
  );
  late final _events = _bridge.events;
  final _location = _DrillLocation();
  Timer? _timer;
  Map<dynamic, dynamic> _status = {};
  String? _error;
  bool _busy = false;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _poll());
  }

  Future<void> _poll() async {
    if (_busy) return;
    try {
      final value = await _channel.invokeMapMethod('status');
      if (mounted) setState(() => _status = value ?? {});
    } catch (_) {
      /* Action errors appear inline; polling must not replace them. */
    }
  }

  Future<void> _act(String action, [Map<String, Object>? args]) async {
    setState(() => _busy = true);
    try {
      final value = await _channel.invokeMapMethod(action, args);
      if (mounted) {
        setState(() {
          _status = value ?? {};
          _error = null;
          if (action == 'reset') _generation++;
        });
      }
    } on PlatformException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _location.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final running = _status['running'] == true;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              color: const Color(0xFFFFE3A3),
              child: const Text('離線雙機演練 · 非真實災情／政府公告\n固定演練位置；資料只留在本畫面，離開即清除。'),
            ),
            Wrap(
              spacing: 6,
              children: [
                TextButton(
                  onPressed:
                      _busy || running
                          ? null
                          : () => _act('prepare', {'role': 'sender'}),
                  child: const Text('A：載入發布資料'),
                ),
                TextButton(
                  onPressed:
                      _busy || running
                          ? null
                          : () => _act('prepare', {'role': 'receiver'}),
                  child: const Text('B：只準備接收'),
                ),
                FilledButton(
                  onPressed:
                      _busy || (!running && _status['prepared'] != true)
                          ? null
                          : () => _act(running ? 'stop' : 'start'),
                  child: Text(running ? '停止演練同步' : '開始演練同步'),
                ),
                TextButton(
                  onPressed: _busy ? null : () => _act('reset'),
                  child: const Text('重設演練'),
                ),
                TextButton(
                  onPressed:
                      () => showModalBottomSheet<void>(
                        context: context,
                        builder:
                            (_) => SafeArea(
                              child: ListView(
                                padding: const EdgeInsets.all(16),
                                children: [
                                  const Text('本機演練時間紀錄（相對同步啟動）'),
                                  ...((_status['timeline'] as List?) ?? []).map(
                                    (line) => SelectableText(line.toString()),
                                  ),
                                ],
                              ),
                            ),
                      ),
                  child: const Text('查看時間紀錄'),
                ),
              ],
            ),
            if (drillRunningHint(running: running) case final hint?)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(hint, style: const TextStyle(color: Color(0xFF8A5A00))),
              ),
            Text(
              '本機事件 ${_status['events'] ?? 0} 筆 · 本輪接收 ${_status['received'] ?? 0} 片',
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            if (_busy) const LinearProgressIndicator(),
            Expanded(
              child: MapScreen(
                key: ValueKey(_generation),
                bridge: _bridge,
                eventUpdates: _events,
                locationController: _location,
                initialState: const MapInitialState(
                  events: [],
                  emergencyModeEnabled: false,
                ),
                staticFeatures: const StaticFeatureCollection(
                  schemaVersion: 'exercise',
                  datasetId: 'exercise',
                  snapshotAt: null,
                  features: [
                    StaticFeature(
                      id: 'exercise:a',
                      kind: 'shelter',
                      geometry: PointGeometry(
                        GeoPoint(longitude: 121.5990, latitude: 25.0600),
                      ),
                      fields: {'name': '演練避難所 A'},
                      properties: null,
                    ),
                    StaticFeature(
                      id: 'exercise:b',
                      kind: 'shelter',
                      geometry: PointGeometry(
                        GeoPoint(longitude: 121.5920, latitude: 25.0600),
                      ),
                      fields: {'name': '演練避難所 B'},
                      properties: null,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DrillLocation extends LocationController {
  @override
  Stream<GeoPoint> get locations => const Stream.empty();
  @override
  Future<GeoPoint?> requestCurrentLocation() async =>
      const GeoPoint(longitude: 121.5910, latitude: 25.0610);
}
