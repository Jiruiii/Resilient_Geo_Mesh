import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/attestation_index.dart';
import '../data/map_bridge.dart';
import '../data/map_models.dart';
import '../data/ncdr_category.dart';
import '../data/ncdr_demo_events.dart';
import '../data/ncdr_map_filter.dart';
import '../data/notification_area_matcher.dart';
import '../data/taiwan_administrative_area_directory.dart';
import '../data/government_api.dart';
import '../data/offline_government_feed.dart';
import '../data/offline_map_web_static_layers.dart';
import '../data/rescue_service.dart';

/// App-level presentation coordinator.
///
/// Android remains the owner of Room and event writes. This controller only
/// reads the verified event stream once and fans it out to the map and the
/// notifications tab.
typedef DemoEventLoader = Future<List<MeshEvent>> Function();
typedef WebStaticLayerLoader = Future<String> Function();
typedef WebGovernmentFeedLoader = Future<WebGovernmentFeedSnapshot> Function();
typedef WebGovernmentFeedRevisionLoader = Future<int> Function();

class MapAppController extends ChangeNotifier with WidgetsBindingObserver {
  MapAppController({
    MapBridge? bridge,
    DemoEventLoader? demoEventLoader,
    bool? isWeb,
    WebStaticLayerLoader? webStaticLayerLoader,
    WebGovernmentFeedLoader? webGovernmentFeedLoader,
    RescueService? rescueService,
    WebGovernmentFeedRevisionLoader? webGovernmentFeedRevisionLoader,
    GovernmentAuthController? governmentAuthController,
  }) : bridge = bridge ?? MapBridge(),
       governmentAuth = governmentAuthController ?? GovernmentAuthController(),
       _demoEventLoader = demoEventLoader ?? _loadBundledNcdrDemoEvents,
       _isWeb = isWeb ?? kIsWeb,
       _webStaticLayerLoader = webStaticLayerLoader ?? loadWebNLSCStaticLayers,
       _webGovernmentFeedLoader =
           webGovernmentFeedLoader ?? loadWebGovernmentFeed,
       _rescueServiceOverride = rescueService,
       _webGovernmentFeedRevisionLoader =
           webGovernmentFeedRevisionLoader ?? loadWebGovernmentFeedRevision {
    WidgetsBinding.instance.addObserver(this);
    governmentAuth.onDeviceWarningCreated =
        _refreshNativeEventsAfterGovernmentWarning;
    governmentAuth.onCloudAnnouncementChanged =
        _scheduleCloudAnnouncementRefresh;
  }

  static const _themePreference = 'map.theme_mode';
  static const _animationPreference = 'map.animation_enabled';
  static const _readEventKeysPreference = 'map.read_event_keys';
  static const _deletedNotificationKeysPreference =
      'map.deleted_notification_keys';
  static const _notificationAreaIdsPreference = 'map.notification_area_ids';
  static const _emptyStaticFeatureCollection = StaticFeatureCollection(
    schemaVersion: 'feature-v0',
    datasetId: 'resilientgeo-taiwan',
    snapshotAt: null,
    features: <StaticFeature>[],
  );
  final MapBridge bridge;
  final GovernmentAuthController governmentAuth;
  final DemoEventLoader _demoEventLoader;
  final bool _isWeb;
  final WebStaticLayerLoader _webStaticLayerLoader;
  final WebGovernmentFeedLoader _webGovernmentFeedLoader;
  final RescueService? _rescueServiceOverride;
  late final RescueService rescueService =
      _rescueServiceOverride ??
      RescueService.forPlatform(bridge: bridge, isWeb: _isWeb);
  List<MeshEvent> _rescueNearby = const <MeshEvent>[];
  GeoPoint? _rescueCenter;
  DateTime? _rescueFetchedAt;
  Timer? _rescueTimer;
  bool _rescueFetching = false;
  final WebGovernmentFeedRevisionLoader _webGovernmentFeedRevisionLoader;
  final StreamController<List<MeshEvent>> _eventUpdates =
      StreamController<List<MeshEvent>>.broadcast();

  StreamSubscription<List<MeshEvent>>? _eventSubscription;
  Timer? _expiryTimer;
  Timer? _webFeedRefreshTimer;
  Timer? _crowdUploadRetryTimer;
  bool _webFeedRefreshing = false;
  int _webFeedRevision = 0;
  bool _webFeedStale = false;
  Object? eventUpdateError;
  bool retryingEvents = false;
  final Set<String> _readEventKeys = <String>{};
  final Set<String> _deletedNotificationKeys = <String>{};
  TaiwanAdministrativeAreaDirectory? _notificationAreaDirectory;
  Set<String> _notificationAreaIds = const <String>{
    TaiwanAdministrativeAreaDirectory.nationalAreaId,
  };
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

  /// True while Android or Web verifies static layers in the background. The
  /// map stays usable; events and any verified facilities appear afterward.
  bool staticFeaturesPending = false;
  Object? staticFeatureLoadError;
  Object? loadError;
  Object? demoEventLoadError;
  bool _disposed = false;

  Stream<List<MeshEvent>> get eventUpdates => _eventUpdates.stream;

  String? get snapshotAt => staticFeatures?.snapshotAt;

  List<MeshEvent> get events {
    final byId = <String, MeshEvent>{};
    for (final event in _withoutExpiredEvents(_publishedEvents)) {
      byId[meshEventIdentity(event)] = event;
    }
    return byId.values.toList(growable: false);
  }

  /// Attestations are surfaced through the crowd report they verify, so they
  /// never appear as notifications of their own. Dismissal only filters this
  /// local list; the verified event stream remains intact for the map/cache.
  List<MeshEvent> get notificationEvents => events
      .where((event) => !isAttestationEvent(event))
      .where(isNcdrCategoryVisibleInApp)
      .where(
        (event) =>
            _notificationAreaDirectory == null ||
            eventMatchesNotificationAreas(
              event,
              _notificationAreaIds,
              _notificationAreaDirectory!,
            ),
      )
      .where(
        (event) => !_deletedNotificationKeys.contains(meshEventIdentity(event)),
      )
      .toList(growable: false);

  /// Read status belongs to this app install/browser and is keyed by event
  /// version, matching notification dismissal and map marker identity.
  Set<String> get readEventKeys => Set<String>.unmodifiable(_readEventKeys);

  List<MeshEvent> get unreadEvents => notificationEvents
      .where((event) => !_readEventKeys.contains(meshEventIdentity(event)))
      .toList(growable: false);

  int get notificationCount => unreadEvents.length;

  TaiwanAdministrativeAreaDirectory? get notificationAreaDirectory =>
      _notificationAreaDirectory;

  Set<String> get notificationAreaIds =>
      Set<String>.unmodifiable(_notificationAreaIds);

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
        if (_isWeb) {
          staticFeatures = _emptyStaticFeatureCollection;
          staticFeaturesPending = true;
          persistedEvents = const <MeshEvent>[];
          initialState = MapInitialState(
            events: const <MeshEvent>[],
            emergencyModeEnabled: false,
          );
          unawaited(_loadWebStaticFeatures());
          unawaited(_refreshWebGovernmentFeed());
        } else {
          final rawStatic = await _loadPreferredStaticAsset();
          if (_disposed) return;
          staticFeatures = StaticFeatureCollection.fromJson(
            Map<String, dynamic>.from(jsonDecode(rawStatic) as Map),
          );
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
      unawaited(governmentAuth.restore());
      if (nativeBridgeAvailable) {
        _listenToNativeEvents();
        unawaited(_syncQueuedCrowdReports());
        _crowdUploadRetryTimer?.cancel();
        _crowdUploadRetryTimer = Timer.periodic(const Duration(seconds: 30), (
          _,
        ) {
          if (!_disposed) unawaited(_syncQueuedCrowdReports());
        });
      }
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
      final snapshot = await bridge.getStaticFeatures();
      if (_disposed) return;
      staticFeatures = snapshot;
    } on Object catch (error) {
      staticFeatureLoadError = error;
    } finally {
      staticFeaturesPending = false;
      _notifyIfAlive();
    }
  }

  Future<void> _loadWebStaticFeatures() async {
    try {
      final rawStatic = await _loadPreferredStaticAsset();
      if (_disposed) return;
      staticFeatures = StaticFeatureCollection.fromJson(
        Map<String, dynamic>.from(jsonDecode(rawStatic) as Map),
      );
    } on Object catch (error) {
      if (_disposed) return;
      staticFeatureLoadError = error;
      staticFeatures = _emptyStaticFeatureCollection;
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
    try {
      _notificationAreaDirectory =
          await TaiwanAdministrativeAreaDirectory.load();
    } on Object {
      _notificationAreaDirectory = null;
    }
    final preferences = await SharedPreferences.getInstance();
    themeMode = _themeModeFromName(preferences.getString(_themePreference));
    animationEnabled = preferences.getBool(_animationPreference) ?? true;
    _notificationAreaIds = const <String>{
      TaiwanAdministrativeAreaDirectory.nationalAreaId,
    };
    try {
      final storedAreaIds = preferences.getStringList(
        _notificationAreaIdsPreference,
      );
      final directory = _notificationAreaDirectory;
      if (storedAreaIds != null &&
          storedAreaIds.isNotEmpty &&
          directory != null) {
        final hasOnlyKnownIds = storedAreaIds.every(
          (areaId) =>
              areaId == TaiwanAdministrativeAreaDirectory.nationalAreaId ||
              directory.areaById(areaId) != null,
        );
        final normalized = directory.normalizeSelection(storedAreaIds.toSet());
        if (hasOnlyKnownIds && normalized.isNotEmpty) {
          _notificationAreaIds = normalized;
        }
      }
    } on Object {
      _notificationAreaIds = const <String>{
        TaiwanAdministrativeAreaDirectory.nationalAreaId,
      };
    }
    _readEventKeys
      ..clear()
      ..addAll(
        preferences.getStringList(_readEventKeysPreference) ?? const <String>[],
      );
    _deletedNotificationKeys
      ..clear()
      ..addAll(
        preferences.getStringList(_deletedNotificationKeysPreference) ??
            const <String>[],
      );
  }

  void _listenToNativeEvents() {
    _eventSubscription = bridge.events.listen(
      (events) {
        if (_disposed) return;
        final verifiedEvents = _withoutUnsupportedEvents(events);
        persistedEvents = verifiedEvents;
        eventUpdateError = null;
        _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
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

  /// Re-read the local Room snapshot after a government device write.
  /// The EventChannel normally delivers this update; the snapshot also covers
  /// a listener that was interrupted while the warning was committed.
  Future<void> _refreshNativeEventsAfterGovernmentWarning() async {
    if (_disposed || !nativeBridgeAvailable) return;
    try {
      final state = await bridge.getInitialState();
      if (_disposed) return;
      persistedEvents = _withoutUnsupportedEvents(state.events);
      eventUpdateError = null;
      _eventUpdates.add(List<MeshEvent>.unmodifiable(persistedEvents));
      _scheduleExpiryRefresh();
      _notifyIfAlive();
    } on Object catch (error) {
      if (_disposed) return;
      eventUpdateError = error;
      _notifyIfAlive();
    }
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
      _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
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
      _webFeedRevision = snapshot.revision;
      _webFeedStale = snapshot.stale;
      persistedEvents = List<MeshEvent>.unmodifiable(
        _withoutExpiredEvents(_withoutUnsupportedEvents(snapshot.events)),
      );
      initialState = MapInitialState(
        events: persistedEvents,
        emergencyModeEnabled: false,
      );
      eventUpdateError =
          snapshot.warning == null ? null : StateError(snapshot.warning!);
      _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
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

  /// Reloads the browser's signed feed after its persisted download scope changes.
  Future<void> refreshGovernmentFeed() =>
      _refreshWebGovernmentFeed(manual: true);

  void _scheduleCloudAnnouncementRefresh({
    required String eventId,
    required int eventVersion,
    required bool retracted,
  }) {
    if (_disposed) return;
    unawaited(
      _refreshCloudAnnouncementFromSignedFeed(
        eventId: eventId,
        eventVersion: eventVersion,
        retracted: retracted,
      ),
    );
  }

  Future<void> _refreshCloudAnnouncementFromSignedFeed({
    required String eventId,
    required int eventVersion,
    required bool retracted,
  }) async {
    if (_disposed) return;
    final wasLocallyVisible = events.any((event) => event.eventId == eventId);
    var startingRevision = _webFeedRevision;
    Object? lastError;

    if (!_isWeb && nativeBridgeAvailable) {
      try {
        final status = await bridge.getGovernmentSyncStatus();
        startingRevision = (status['revision'] as num?)?.toInt() ?? 0;
      } on Object catch (error) {
        lastError = error;
      }
    }
    var latestLoadedRevision = startingRevision;

    // The publisher consumes the server outbox asynchronously. Android syncs
    // the verified Room feed; Web polls only signed feed metadata, then loads
    // all signed chunks once a new revision is available.
    for (var attempt = 0; attempt < 12; attempt++) {
      if (_disposed) return;
      var observedRevision = startingRevision;
      try {
        if (_isWeb && !nativeBridgeAvailable) {
          final feedRevision = await _webGovernmentFeedRevisionLoader();
          observedRevision = feedRevision;
          if (feedRevision > latestLoadedRevision) {
            await _refreshWebGovernmentFeed();
            observedRevision = _webFeedRevision;
            latestLoadedRevision = _webFeedRevision;
          }
        } else if (nativeBridgeAvailable) {
          final status = await bridge.syncGovernmentNow();
          observedRevision =
              (status['revision'] as num?)?.toInt() ?? startingRevision;
          if (observedRevision > latestLoadedRevision) {
            latestLoadedRevision = observedRevision;
          }
          await _refreshNativeEventsAfterGovernmentWarning();
        } else {
          return;
        }

        if (_disposed) return;
        MeshEvent? current;
        for (final event in events) {
          if (event.eventId == eventId) {
            current = event;
            break;
          }
        }
        final applied =
            retracted
                ? current == null &&
                    (wasLocallyVisible ||
                        observedRevision > startingRevision) &&
                    (!_isWeb || !_webFeedStale)
                : current != null &&
                    (current.eventVersion ?? 0) >= eventVersion;
        if (applied) {
          eventUpdateError = null;
          _notifyIfAlive();
          return;
        }
      } on Object catch (error) {
        lastError = error;
      }

      await Future<void>.delayed(const Duration(seconds: 2));
    }

    if (_disposed) return;
    eventUpdateError = lastError ?? StateError('公告已送出，但簽章 feed 尚未發布新版本。');
    _notifyIfAlive();
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
      _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
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

  /// Map centre after the camera settles. Fetches rescue points around it at
  /// most once per 60 s unless the centre moved more than ~1 km.
  void setRescueViewport(GeoPoint center) {
    final previous = _rescueCenter;
    _rescueCenter = center;
    final moved =
        previous == null ||
        (previous.longitude - center.longitude).abs() > 0.01 ||
        (previous.latitude - center.latitude).abs() > 0.01;
    final stale =
        _rescueFetchedAt == null ||
        DateTime.now().difference(_rescueFetchedAt!) >=
            const Duration(seconds: 60);
    if (moved || stale) unawaited(_refreshRescueNearby());
    _rescueTimer ??= Timer.periodic(
      const Duration(seconds: 60),
      (_) => unawaited(_refreshRescueNearby()),
    );
  }

  Future<void> _refreshRescueNearby() async {
    final center = _rescueCenter;
    if (_disposed || center == null || _rescueFetching) return;
    _rescueFetching = true;
    try {
      _rescueNearby = List<MeshEvent>.unmodifiable(
        await rescueService.nearby(RescueBounds.around(center)),
      );
      _rescueFetchedAt = DateTime.now();
      _publishEvents();
    } on RescueFailure {
      // Offline or server not configured: keep what we have; the map never
      // shows unverified server data in its place.
    } finally {
      _rescueFetching = false;
    }
  }

  /// Persisted (Room or signed government feed) plus verified server rescue points.
  List<MeshEvent> get _publishedEvents {
    final byId = <String, MeshEvent>{};
    for (final event in <MeshEvent>[...persistedEvents, ..._rescueNearby]) {
      final key = meshEventIdentity(event);
      final existing = byId[key];
      if (existing == null ||
          (event.eventVersion ?? 0) > (existing.eventVersion ?? 0)) {
        byId[key] = event;
      }
    }
    return byId.values.toList(growable: false);
  }

  void _publishEvents() {
    _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
    _notifyIfAlive();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || _disposed) return;
    persistedEvents = _withoutExpiredEvents(persistedEvents);
    _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
    _scheduleExpiryRefresh();
    _notifyIfAlive();
    if (nativeBridgeAvailable) unawaited(_syncQueuedCrowdReports());
    if (_isWeb && !nativeBridgeAvailable) {
      unawaited(_refreshWebGovernmentFeed());
    } else if (eventUpdateError != null) {
      unawaited(retryEventUpdates());
    }
  }

  Future<void> _syncQueuedCrowdReports() async {
    try {
      await bridge.syncPendingCrowdReports();
    } on Object {
      // The queue remains local and will retry at the next interval or resume.
    }
  }

  Future<void> markEventRead(MeshEvent event) async {
    final key = meshEventIdentity(event);
    if (!_readEventKeys.add(key)) return;
    _notifyIfAlive();
    await _persistNotificationKeys(_readEventKeysPreference, _readEventKeys);
  }

  Future<void> setNotificationAreaIds(Set<String> areaIds) async {
    final directory = _notificationAreaDirectory;
    if (directory == null || areaIds.isEmpty) return;
    final hasOnlyKnownIds = areaIds.every(
      (areaId) =>
          areaId == TaiwanAdministrativeAreaDirectory.nationalAreaId ||
          directory.areaById(areaId) != null,
    );
    if (!hasOnlyKnownIds) return;
    final normalized = directory.normalizeSelection(areaIds);
    if (normalized.isEmpty ||
        normalized.length == _notificationAreaIds.length &&
            normalized.containsAll(_notificationAreaIds)) {
      return;
    }
    _notificationAreaIds = normalized;
    _notifyIfAlive();
    final preferences = await SharedPreferences.getInstance();
    final sortedIds = normalized.toList()..sort();
    await preferences.setStringList(_notificationAreaIdsPreference, sortedIds);
  }

  Future<void> markAllNotificationsRead() async {
    var changed = false;
    for (final event in notificationEvents) {
      changed = _readEventKeys.add(meshEventIdentity(event)) || changed;
    }
    if (!changed) return;
    _notifyIfAlive();
    await _persistNotificationKeys(_readEventKeysPreference, _readEventKeys);
  }

  Future<void> deleteNotification(MeshEvent event) async {
    if (!_deletedNotificationKeys.add(meshEventIdentity(event))) return;
    _notifyIfAlive();
    await _persistNotificationKeys(
      _deletedNotificationKeysPreference,
      _deletedNotificationKeys,
    );
  }

  Future<void> deleteAllNotifications() async {
    var changed = false;
    for (final event in notificationEvents) {
      changed =
          _deletedNotificationKeys.add(meshEventIdentity(event)) || changed;
    }
    if (!changed) return;
    _notifyIfAlive();
    await _persistNotificationKeys(
      _deletedNotificationKeysPreference,
      _deletedNotificationKeys,
    );
  }

  Future<void> restoreNotification(MeshEvent event) async {
    if (!_deletedNotificationKeys.remove(meshEventIdentity(event))) return;
    _notifyIfAlive();
    await _persistNotificationKeys(
      _deletedNotificationKeysPreference,
      _deletedNotificationKeys,
    );
  }

  Future<void> _persistNotificationKeys(String key, Set<String> values) async {
    final preferences = await SharedPreferences.getInstance();
    final sortedKeys = values.toList()..sort();
    await preferences.setStringList(key, sortedKeys);
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
    governmentAuth.onDeviceWarningCreated = null;
    governmentAuth.onCloudAnnouncementChanged = null;
    WidgetsBinding.instance.removeObserver(this);
    _expiryTimer?.cancel();
    _webFeedRefreshTimer?.cancel();
    _rescueTimer?.cancel();
    _crowdUploadRetryTimer?.cancel();
    _eventSubscription?.cancel();
    _eventUpdates.close();
    governmentAuth.dispose();
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
