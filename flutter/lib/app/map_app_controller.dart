import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/attestation_index.dart';
import '../data/map_bridge.dart';
import '../data/map_models.dart';
import '../data/ncdr_demo_events.dart';
import '../data/ncdr_map_filter.dart';
import '../data/offline_government_feed.dart';
import '../data/offline_map_web_static_layers.dart';

/// App-level presentation coordinator.
///
/// Android remains the owner of Room and event writes. This controller only
/// reads the verified event stream once and fans it out to the map and the
/// notifications tab.
typedef DemoEventLoader = Future<List<MeshEvent>> Function();
typedef WebStaticLayerLoader = Future<String> Function();
typedef WebGovernmentFeedLoader = Future<WebGovernmentFeedSnapshot> Function();

class MapAppController extends ChangeNotifier with WidgetsBindingObserver {
  MapAppController({
    MapBridge? bridge,
    DemoEventLoader? demoEventLoader,
    bool? isWeb,
    WebStaticLayerLoader? webStaticLayerLoader,
    WebGovernmentFeedLoader? webGovernmentFeedLoader,
  }) : bridge = bridge ?? MapBridge(),
       _demoEventLoader = demoEventLoader ?? _loadBundledNcdrDemoEvents,
       _isWeb = isWeb ?? kIsWeb,
       _webStaticLayerLoader = webStaticLayerLoader ?? loadWebNLSCStaticLayers,
       _webGovernmentFeedLoader =
           webGovernmentFeedLoader ?? loadWebGovernmentFeed {
    WidgetsBinding.instance.addObserver(this);
  }

  static const _themePreference = 'map.theme_mode';
  static const _animationPreference = 'map.animation_enabled';
  static const _readEventKeysPreference = 'map.read_event_keys';
  final MapBridge bridge;
  final DemoEventLoader _demoEventLoader;
  final bool _isWeb;
  final WebStaticLayerLoader _webStaticLayerLoader;
  final WebGovernmentFeedLoader _webGovernmentFeedLoader;
  final StreamController<List<MeshEvent>> _eventUpdates =
      StreamController<List<MeshEvent>>.broadcast();

  StreamSubscription<List<MeshEvent>>? _eventSubscription;
  Timer? _expiryTimer;
  Timer? _webFeedRefreshTimer;
  bool _webFeedRefreshing = false;
  Object? eventUpdateError;
  bool retryingEvents = false;
  final Set<String> _readEventKeys = <String>{};
  StaticFeatureCollection? staticFeatures;
  List<MeshEvent> persistedEvents = const <MeshEvent>[];
  MapInitialState initialState = const MapInitialState(
    events: <MeshEvent>[],
    emergencyModeEnabled: false,
  );
  ThemeMode themeMode = ThemeMode.system;
  bool animationEnabled = true;
  bool nativeBridgeAvailable = false;
  bool isLoading = true;

  /// True while Android is still verifying the static layers; the map is
  /// already usable and shelters appear once verification finishes.
  bool staticFeaturesPending = false;
  Object? staticFeatureLoadError;
  Object? loadError;
  Object? demoEventLoadError;
  bool _disposed = false;

  Stream<List<MeshEvent>> get eventUpdates => _eventUpdates.stream;

  String? get snapshotAt => staticFeatures?.snapshotAt;

  List<MeshEvent> get events {
    final byId = <String, MeshEvent>{};
    for (final event in _withoutExpiredEvents(persistedEvents)) {
      byId[meshEventIdentity(event)] = event;
    }
    return byId.values.toList(growable: false);
  }

  /// Attestations are surfaced through the crowd report they verify, so they
  /// never count as a notification of their own.
  List<MeshEvent> get unreadEvents => events
      .where((event) => !isAttestationEvent(event))
      .where((event) => !_readEventKeys.contains(meshEventIdentity(event)))
      .toList(growable: false);

  int get notificationCount => unreadEvents.length;

  Future<void> load() async {
    try {
      try {
        final loadedState = await bridge.getInitialState();
        if (_disposed) return;
        final verifiedEvents = _withoutUnsupportedEvents(loadedState.events);
        initialState = MapInitialState(
          events: verifiedEvents,
          emergencyModeEnabled: loadedState.emergencyModeEnabled,
          staticFeatures: loadedState.staticFeatures,
        );
        persistedEvents = verifiedEvents;
        nativeBridgeAvailable = true;
        if (loadedState.staticFeatures.isNotEmpty) {
          staticFeatures = StaticFeatureCollection(
            schemaVersion: 'feature-v0',
            datasetId: 'resilientgeo-taiwan',
            snapshotAt: null,
            features: loadedState.staticFeatures,
          );
        } else {
          // On an Android host, an absent nationwide layer means that no
          // verified static bundle is installed yet. Do not fall back to the
          // unverified preview JSON after the native bridge is available.
          staticFeatures = const StaticFeatureCollection(
            schemaVersion: 'feature-v0',
            datasetId: 'resilientgeo-taiwan',
            snapshotAt: null,
            features: <StaticFeature>[],
          );
        }
        if (loadedState.staticFeatures.isEmpty) {
          // Started before preferences load so the two overlap, and so a
          // preferences failure cannot keep the verified layer from loading.
          staticFeaturesPending = true;
          unawaited(_loadVerifiedStaticFeatures());
        }
      } on MissingPluginException {
        // The Web build uses the signed Server feed. Other hosts without an
        // Android bridge may still use the development-only event preview.
        // Static points always require a signed Server layer.
        if (!_isWeb && defaultTargetPlatform == TargetPlatform.android) rethrow;
        final rawStatic = await _loadPreferredStaticAsset();
        if (_disposed) return;
        staticFeatures = StaticFeatureCollection.fromJson(
          Map<String, dynamic>.from(jsonDecode(rawStatic) as Map),
        );
        if (_isWeb) {
          persistedEvents = const <MeshEvent>[];
          initialState = MapInitialState(
            events: const <MeshEvent>[],
            emergencyModeEnabled: false,
          );
          unawaited(_refreshWebGovernmentFeed());
        } else {
          try {
            final demoEvents = await _demoEventLoader();
            if (_disposed) return;
            persistedEvents = List<MeshEvent>.unmodifiable(demoEvents);
            initialState = MapInitialState(
              events: persistedEvents,
              emergencyModeEnabled: false,
            );
          } on Object catch (error) {
            demoEventLoadError = error;
            persistedEvents = const <MeshEvent>[];
            initialState = const MapInitialState(
              events: <MeshEvent>[],
              emergencyModeEnabled: false,
            );
          }
        }
      }

      if (_disposed) return;
      await _loadPreferences();
      if (_disposed) return;
      if (nativeBridgeAvailable) _listenToNativeEvents();
      _scheduleExpiryRefresh();
    } on Object catch (error) {
      loadError = error;
    } finally {
      isLoading = false;
      _notifyIfAlive();
    }
  }

  /// Verification of the nationwide layers takes seconds on first launch, so
  /// it no longer holds the splash screen. A failure keeps the empty verified
  /// collection: the preview JSON is never used once Android is present.
  Future<void> _loadVerifiedStaticFeatures() async {
    try {
      final features = await bridge.getStaticFeatures();
      if (_disposed) return;
      staticFeatures = StaticFeatureCollection(
        schemaVersion: 'feature-v0',
        datasetId: 'resilientgeo-taiwan',
        snapshotAt: null,
        features: features,
      );
    } on Object catch (error) {
      staticFeatureLoadError = error;
    } finally {
      staticFeaturesPending = false;
      _notifyIfAlive();
    }
  }

  Future<String> _loadPreferredStaticAsset() async {
    if (_isWeb) {
      try {
        final downloaded = await _webStaticLayerLoader();
        if (downloaded.isNotEmpty) return downloaded;
        staticFeatureLoadError = StateError('瀏覽器不支援離線靜態資料儲存，尚未顯示避難所與醫療院所');
      } on Object catch (error) {
        staticFeatureLoadError = error;
      }
      // The bundled preview predates source-coordinate verification. Never
      // show it as a substitute for the signed shelter and medical layers.
      return jsonEncode(<String, Object?>{
        'schema_version': 'feature-v0',
        'dataset_id': 'resilientgeo-taiwan',
        'snapshot_at': null,
        'features': <Object>[],
      });
    }
    staticFeatureLoadError = StateError('尚未取得已驗簽的避難所與醫療院所資料');
    return jsonEncode(<String, Object?>{
      'schema_version': 'feature-v0',
      'dataset_id': 'resilientgeo-taiwan',
      'snapshot_at': null,
      'features': <Object>[],
    });
  }

  Future<void> _loadPreferences() async {
    final preferences = await SharedPreferences.getInstance();
    themeMode = _themeModeFromName(preferences.getString(_themePreference));
    animationEnabled = preferences.getBool(_animationPreference) ?? true;
    _readEventKeys
      ..clear()
      ..addAll(
        preferences.getStringList(_readEventKeysPreference) ?? const <String>[],
      );
  }

  void _listenToNativeEvents() {
    _eventSubscription = bridge.events.listen(
      (events) {
        if (_disposed) return;
        final verifiedEvents = _withoutUnsupportedEvents(events);
        persistedEvents = verifiedEvents;
        eventUpdateError = null;
        _eventUpdates.add(List<MeshEvent>.unmodifiable(verifiedEvents));
        _scheduleExpiryRefresh();
        _notifyIfAlive();
      },
      onError: (Object error) {
        if (_disposed) return;
        eventUpdateError = error;
        _notifyIfAlive();
      },
    );
  }

  Future<void> retryEventUpdates() async {
    if (_disposed || retryingEvents) return;
    if (_isWeb && !nativeBridgeAvailable) {
      await _refreshWebGovernmentFeed(manual: true);
      return;
    }
    if (!nativeBridgeAvailable) return;
    retryingEvents = true;
    _notifyIfAlive();
    try {
      await _eventSubscription?.cancel();
      _eventSubscription = null;
      final state = await bridge.getInitialState();
      if (_disposed) return;
      persistedEvents = _withoutUnsupportedEvents(state.events);
      eventUpdateError = null;
      _eventUpdates.add(List<MeshEvent>.unmodifiable(persistedEvents));
      _listenToNativeEvents();
      _scheduleExpiryRefresh();
    } on Object catch (error) {
      eventUpdateError = error;
    } finally {
      retryingEvents = false;
      _notifyIfAlive();
    }
  }

  Future<void> _refreshWebGovernmentFeed({bool manual = false}) async {
    if (_disposed || !_isWeb || nativeBridgeAvailable || _webFeedRefreshing) {
      return;
    }
    _webFeedRefreshing = true;
    if (manual) {
      retryingEvents = true;
      _notifyIfAlive();
    }
    try {
      final snapshot = await _webGovernmentFeedLoader();
      if (_disposed) return;
      persistedEvents = List<MeshEvent>.unmodifiable(
        _withoutExpiredEvents(_withoutUnsupportedEvents(snapshot.events)),
      );
      initialState = MapInitialState(
        events: persistedEvents,
        emergencyModeEnabled: false,
      );
      eventUpdateError =
          snapshot.warning == null ? null : StateError(snapshot.warning!);
      _eventUpdates.add(persistedEvents);
      _scheduleExpiryRefresh();
    } on Object catch (error) {
      if (_disposed) return;
      eventUpdateError = error;
    } finally {
      _webFeedRefreshing = false;
      if (manual) retryingEvents = false;
      _scheduleWebFeedRefresh();
      _notifyIfAlive();
    }
  }

  void _scheduleWebFeedRefresh() {
    _webFeedRefreshTimer?.cancel();
    if (_disposed || !_isWeb || nativeBridgeAvailable) return;
    _webFeedRefreshTimer = Timer(const Duration(minutes: 5), () {
      if (!_disposed) unawaited(_refreshWebGovernmentFeed());
    });
  }

  void _scheduleExpiryRefresh() {
    _expiryTimer?.cancel();
    final now = DateTime.now().toUtc();
    DateTime? next;
    for (final event in persistedEvents) {
      final expires = DateTime.tryParse(event.expiresAt ?? '')?.toUtc();
      if (expires != null &&
          expires.isAfter(now) &&
          (next == null || expires.isBefore(next))) {
        next = expires;
      }
    }
    if (next == null || _disposed) return;
    _expiryTimer = Timer(next.difference(now), () {
      if (_disposed) return;
      persistedEvents = _withoutExpiredEvents(persistedEvents);
      _eventUpdates.add(List<MeshEvent>.unmodifiable(persistedEvents));
      _notifyIfAlive();
      _scheduleExpiryRefresh();
    });
  }

  List<MeshEvent> _withoutExpiredEvents(
    Iterable<MeshEvent> source, {
    DateTime? at,
  }) {
    final now = (at ?? DateTime.now()).toUtc();
    return source
        .where((event) {
          final expires = DateTime.tryParse(event.expiresAt ?? '')?.toUtc();
          return expires == null || expires.isAfter(now);
        })
        .toList(growable: false);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || _disposed) return;
    persistedEvents = _withoutExpiredEvents(persistedEvents);
    _eventUpdates.add(List<MeshEvent>.unmodifiable(persistedEvents));
    _scheduleExpiryRefresh();
    _notifyIfAlive();
    if (_isWeb && !nativeBridgeAvailable) {
      unawaited(_refreshWebGovernmentFeed());
    } else if (eventUpdateError != null) {
      unawaited(retryEventUpdates());
    }
  }

  Future<void> markEventRead(MeshEvent event) async {
    final key = meshEventIdentity(event);
    if (!_readEventKeys.add(key)) return;
    _notifyIfAlive();
    final preferences = await SharedPreferences.getInstance();
    final sortedKeys = _readEventKeys.toList()..sort();
    await preferences.setStringList(_readEventKeysPreference, sortedKeys);
  }

  Future<void> setThemeMode(ThemeMode value) async {
    themeMode = value;
    _notifyIfAlive();
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_themePreference, value.name);
  }

  Future<void> setAnimationEnabled(bool value) async {
    animationEnabled = value;
    _notifyIfAlive();
    final preferences = await SharedPreferences.getInstance();
    await preferences.setBool(_animationPreference, value);
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _expiryTimer?.cancel();
    _webFeedRefreshTimer?.cancel();
    _eventSubscription?.cancel();
    _eventUpdates.close();
    super.dispose();
  }

  void _notifyIfAlive() {
    if (!_disposed) notifyListeners();
  }
}

List<MeshEvent> _withoutUnsupportedEvents(Iterable<MeshEvent> events) =>
    List<MeshEvent>.unmodifiable(
      events.where(
        (event) =>
            !_isDemoEvent(event) &&
            !event.isRetiredShelterStatus &&
            isAppSupportedEvent(event),
      ),
    );

bool _isDemoEvent(MeshEvent event) =>
    event.namespace?.startsWith('demo.') == true ||
    event.eventId?.startsWith('demo:') == true ||
    event.attributes?['is_demo'] == true;

Future<List<MeshEvent>> _loadBundledNcdrDemoEvents() =>
    const NcdrDemoEventLoader().load();

ThemeMode _themeModeFromName(String? value) => switch (value) {
  'light' => ThemeMode.light,
  'dark' => ThemeMode.dark,
  _ => ThemeMode.system,
};
