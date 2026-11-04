import 'dart:async';

import 'package:flutter/material.dart';

import '../data/location_controller.dart';
import '../data/map_basemap.dart';
import '../data/map_models.dart';
import '../data/ncdr_map_filter.dart';
import '../screens/map_screen.dart';
import '../screens/notifications_screen.dart';
import '../screens/profile_screen.dart';
import '../theme/app_theme.dart';
import '../widgets/app_bottom_navigation.dart';
import 'showcase_clock.dart';
import 'showcase_scenario.dart';
import 'showcase_simulation.dart';

class ShowcaseApp extends StatefulWidget {
  const ShowcaseApp({super.key, this.basemapProbe});

  /// Overrides the NLSC reachability check in tests.
  final EmapReachabilityProbe? basemapProbe;

  @override
  State<ShowcaseApp> createState() => _ShowcaseAppState();
}

class _ShowcaseAppState extends State<ShowcaseApp> {
  static const Duration _alertDelay = Duration(seconds: 10);

  final GlobalKey<ScaffoldMessengerState> _scaffoldMessengerKey =
      GlobalKey<ScaffoldMessengerState>();
  ShowcaseScenario? _scenario;
  Object? _loadError;
  List<MeshEvent> _events = const <MeshEvent>[];
  Set<String> _read = <String>{};
  Set<String> _deleted = <String>{};
  StreamController<List<MeshEvent>>? _eventUpdates;
  Timer? _alertTimer;
  Timer? _emapProbeTimer;
  int _emapProbeGeneration = 0;
  bool _alertDelayElapsed = false;
  LocationController? _location;
  ShowcaseMapBridge? _bridge;
  ShowcaseRescueService? _rescue;
  int _selectedIndex = 0;
  int _resetGeneration = 0;
  int _focusRequestId = 0;
  MeshEvent? _focusedEvent;
  ThemeMode _themeMode = ThemeMode.system;
  bool _animationEnabled = true;
  MapBasemapMode _basemapMode = MapBasemapMode.auto;
  bool? _emapReachable;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final scenario = await ShowcaseScenario.load();
      if (!mounted) return;
      setState(() {
        _scenario = scenario;
        _newSimulation(scenario);
      });
      _startAlertDelay();
      _startEmapProbes();
    } on Object catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  void _newSimulation(ShowcaseScenario scenario) {
    final oldUpdates = _eventUpdates;
    final oldLocation = _location;
    _events = List<MeshEvent>.of(scenario.events);
    _read = <String>{};
    _deleted = <String>{};
    _eventUpdates = StreamController<List<MeshEvent>>.broadcast();
    _location = LocationController(
      gateway: ShowcaseLocationGateway(scenario.origin),
      webPlatform: true,
    );
    _bridge = ShowcaseMapBridge(
      onReport: _onReport,
      routes: scenario.routes,
      roadAlertActive:
          () => isShowcaseRoadClosureActive(
            events: _events,
            eventId: scenario.routes.blockedEventId,
            at: ShowcaseClock.scenarioTime,
          ),
    );
    _rescue = ShowcaseRescueService();
    _selectedIndex = 0;
    _focusRequestId = 0;
    _focusedEvent = null;
    _themeMode = ThemeMode.system;
    _animationEnabled = true;
    _basemapMode = MapBasemapMode.auto;
    _emapReachable = null;
    _resetGeneration += 1;
    if (oldUpdates != null) unawaited(oldUpdates.close());
    if (oldLocation != null) unawaited(oldLocation.dispose());
  }

  void _onReport(MeshEvent event) {
    if (!mounted) return;
    setState(() => _events = <MeshEvent>[..._events, event]);
    _eventUpdates?.add(_events);
  }

  void _startAlertDelay() {
    _alertTimer?.cancel();
    _alertDelayElapsed = false;
    _alertTimer = Timer(_alertDelay, () {
      _alertTimer = null;
      _alertDelayElapsed = true;
      _publishDelayedAlertIfReady();
    });
  }

  void _startEmapProbes() {
    _emapProbeTimer?.cancel();
    _emapProbeTimer = null;
    final generation = ++_emapProbeGeneration;
    if (_basemapMode == MapBasemapMode.osm) return;
    unawaited(_probeEmap(generation));
    _emapProbeTimer = Timer.periodic(MapBasemap.probeInterval, (_) {
      unawaited(_probeEmap(generation));
    });
  }

  Future<void> _probeEmap(int generation) async {
    final probe = widget.basemapProbe ?? MapBasemap.probeEmap;
    bool reachable;
    try {
      reachable = await probe();
    } on Object {
      reachable = false;
    }
    if (!mounted ||
        generation != _emapProbeGeneration ||
        _basemapMode == MapBasemapMode.osm ||
        reachable == _emapReachable) {
      return;
    }
    setState(() => _emapReachable = reachable);
  }

  void _setBasemapMode(MapBasemapMode mode) {
    if (_basemapMode == mode) return;
    setState(() {
      _basemapMode = mode;
      _emapReachable = null;
    });
    _startEmapProbes();
  }

  bool get _emapVisible =>
      MapBasemap.emapVisible(mode: _basemapMode, emapReachable: _emapReachable);

  void _publishDelayedAlertIfReady() {
    if (!_alertDelayElapsed || !mounted) return;
    final scenario = _scenario;
    if (scenario == null) return;
    final newEvents = scenario.delayedEvents
        .where(
          (event) =>
              !_events.any(
                (current) =>
                    meshEventIdentity(current) == meshEventIdentity(event),
              ),
        )
        .toList(growable: false);
    if (newEvents.isEmpty) return;
    setState(() => _events = <MeshEvent>[..._events, ...newEvents]);
    _eventUpdates?.add(List<MeshEvent>.unmodifiable(_events));
  }

  void _reset() {
    final scenario = _scenario;
    if (scenario == null) return;
    setState(() => _newSimulation(scenario));
    _startAlertDelay();
    _startEmapProbes();
    _scaffoldMessengerKey.currentState?.showSnackBar(
      const SnackBar(content: Text('展示情境已重設')),
    );
  }

  void _openNotificationOnMap(MeshEvent event) {
    final point = meshEventFocusPoint(event);
    if (!isMapVisibleEvent(event) || point == null) {
      _scaffoldMessengerKey.currentState?.showSnackBar(
        const SnackBar(content: Text('此通知沒有地圖位置')),
      );
      return;
    }
    setState(() {
      _read.add(meshEventIdentity(event));
      _selectedIndex = 0;
      _focusedEvent = event;
      _focusRequestId += 1;
    });
  }

  @override
  void dispose() {
    _alertTimer?.cancel();
    _emapProbeTimer?.cancel();
    _emapProbeGeneration += 1;
    final updates = _eventUpdates;
    if (updates != null) unawaited(updates.close());
    final location = _location;
    if (location != null) unawaited(location.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    scaffoldMessengerKey: _scaffoldMessengerKey,
    title: 'ResilientGeo 展示',
    theme: AppTheme.light(),
    darkTheme: AppTheme.dark(),
    themeMode: _themeMode,
    home: _buildHome(),
  );

  Widget _buildHome() {
    final scenario = _scenario;
    if (scenario == null) {
      return Scaffold(
        body: Center(
          child:
              _loadError == null
                  ? const CircularProgressIndicator()
                  : Text('無法載入展示情境：$_loadError'),
        ),
      );
    }
    final notificationEvents = _events
        .where((event) => !_deleted.contains(meshEventIdentity(event)))
        .toList(growable: false);
    final unread =
        notificationEvents
            .where((event) => !_read.contains(meshEventIdentity(event)))
            .length;
    return Scaffold(
      body: IndexedStack(
        index: _selectedIndex,
        children: <Widget>[
          MapScreen(
            key: ValueKey<String>('showcase-map-$_resetGeneration'),
            showcaseMode: true,
            showcaseOrigin: scenario.origin,
            staticFeatures: scenario.features,
            initialState: MapInitialState(
              events: _events,
              emergencyModeEnabled: false,
            ),
            bridge: _bridge,
            eventUpdates: _eventUpdates?.stream,
            locationController: _location,
            themeMode: _themeMode,
            animationEnabled: _animationEnabled,
            basemapMode: _basemapMode,
            emapReachable: _emapReachable,
            onBasemapModeChanged: _setBasemapMode,
            active: _selectedIndex == 0,
            routeClock: () => ShowcaseClock.scenarioTime,
            rescueService: _rescue,
            notificationFocusEvent: _focusedEvent,
            notificationFocusRequestId: _focusRequestId,
          ),
          NotificationsScreen(
            key: ValueKey<String>('showcase-notifications-$_resetGeneration'),
            events: notificationEvents,
            attestationSource: _events,
            readEventKeys: _read,
            onEventRead:
                (event) => setState(() => _read.add(meshEventIdentity(event))),
            onEventMapRequested: _openNotificationOnMap,
            onMarkAllRead:
                () => setState(
                  () => _read.addAll(notificationEvents.map(meshEventIdentity)),
                ),
            onEventDeleted:
                (event) =>
                    setState(() => _deleted.add(meshEventIdentity(event))),
            onDeleteAll:
                () => setState(
                  () => _deleted.addAll(
                    notificationEvents.map(meshEventIdentity),
                  ),
                ),
            onUndoDelete:
                (event) =>
                    setState(() => _deleted.remove(meshEventIdentity(event))),
          ),
          ProfileScreen(
            key: ValueKey<String>('showcase-profile-$_resetGeneration'),
            showcaseMode: true,
            onShowcaseReset: _reset,
            themeMode: _themeMode,
            animationEnabled: _animationEnabled,
            onThemeModeChanged: (mode) => setState(() => _themeMode = mode),
            onAnimationChanged:
                (value) => setState(() => _animationEnabled = value),
            basemapMode: _basemapMode,
            emapVisible: _emapVisible,
            onBasemapModeChanged: _setBasemapMode,
          ),
        ],
      ),
      bottomNavigationBar: AppBottomNavigation(
        currentIndex: _selectedIndex,
        notificationCount: unread,
        onSelected: (index) => setState(() => _selectedIndex = index),
      ),
    );
  }
}
