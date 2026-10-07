import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:pointer_interceptor/pointer_interceptor.dart';

import '../data/map_bridge.dart';
import '../data/offline_search_worker.dart';
import '../data/app_performance.dart';
import '../data/attestation_index.dart';
import '../data/bridge_failure.dart';
import '../data/corroboration.dart';
import '../data/crowd_report_models.dart';
import '../data/display_time.dart';
import '../data/evacuation_models.dart';
import '../data/location_controller.dart';
import '../data/map_administrative.dart';
import '../data/map_models.dart';
import '../data/maplibre_map_config.dart';
import '../data/map_runtime_state.dart';
import '../data/route_event_snapshot.dart';
import '../data/map_search.dart';
import '../data/map_search_asset.dart';
import '../data/ncdr_map_filter.dart';
import '../data/offline_address_pack_store.dart';
import '../data/offline_map_asset_store.dart';
import '../widgets/feature_details_sheet.dart';
import '../widgets/crowd_report_sheet.dart';
import '../widgets/evacuation_route_sheet.dart';
import '../widgets/layer_filter_panel.dart';
import '../widgets/map_canvas.dart';
import '../widgets/map_layers.dart' show MapIconCatalog, featureName;
import 'sync_status_screen.dart';

class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    this.staticFeatures,
    this.staticFeaturesPending = false,
    this.staticFeaturesFailed = false,
    this.initialState,
    this.bridge,
    this.eventUpdates,
    this.locationController,
    this.themeMode = ThemeMode.system,
    this.animationEnabled = true,
    this.active = true,
    this.routeClock,
  });

  /// Optional deterministic inputs keep widget tests independent of channels.
  final StaticFeatureCollection? staticFeatures;

  /// Android is still verifying the nationwide layers (first launch only).
  final bool staticFeaturesPending;

  /// Verification failed; nothing unverified is shown instead.
  final bool staticFeaturesFailed;
  final MapInitialState? initialState;
  final MapBridge? bridge;
  final Stream<List<MeshEvent>>? eventUpdates;

  /// Tests can inject deterministic data and a fake location controller.
  final LocationController? locationController;
  final ThemeMode themeMode;
  final bool animationEnabled;
  final bool active;

  /// Deterministic expiry clock for widget tests.
  final DateTime Function()? routeClock;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> with WidgetsBindingObserver {
  late final MapBridge _bridge;
  late final LocationController _locationController;
  final OfflineAddressPackStore _addressPackStore = OfflineAddressPackStore();
  final TextEditingController _searchController = TextEditingController();
  final TextEditingController _reportAddressController =
      TextEditingController();
  StreamSubscription<List<MeshEvent>>? _eventSubscription;
  StreamSubscription<GeoPoint>? _locationSubscription;
  StaticFeatureCollection? _staticFeatures;
  MapAdministrativeIndex? _administrativeIndex;
  TaiwanSearchAsset? _searchAsset;
  List<TaiwanSearchEntry> _addressSearchEntries = const <TaiwanSearchEntry>[];
  AddressPackCatalog? _addressPackCatalog;
  MapSearchIndex? _searchIndex;
  OfflineSearchWorker? _searchWorker;
  List<MapSearchResult> _mapSearchResults = const [];
  List<MapSearchResult> _reportSearchResults = const [];
  int _mapSearchGeneration = 0;
  int _reportSearchGeneration = 0;
  Timer? _mapSearchDebounce;
  Timer? _reportAddressSearchDebounce;
  List<MeshEvent> _persistedEvents = const <MeshEvent>[];
  bool _showShelters = true;
  bool _showMedical = true;
  bool _showEvents = true;
  bool _emergencyModeEnabled = false;
  StaticFeature? _selectedFeature;
  MeshEvent? _selectedEvent;
  MapRuntimeState _runtimeState = const MapRuntimeState(
    themeMode: ThemeMode.system,
    zoomPercentage: MapLibreMapConfig.initialOverviewPercentage,
    currentLocation: null,
    animationEnabled: true,
  );
  MapSearchResult? _searchSelection;
  GeoPoint? _focusPoint;
  int _focusRequestId = 0;
  String _searchText = '';
  CrowdReportDraft? _reportDraft;
  CrowdReportSheetStep _reportStep = CrowdReportSheetStep.edit;
  bool _reportSheetVisible = false;
  bool _reportPicking = false;
  bool _reportSubmitting = false;
  String? _reportDeliveryEventId;
  StaticFeature? _routeDestination;
  EvacuationRouteResult? _routeResult;
  String? _routeErrorMessage;
  bool _routeSheetVisible = false;
  bool _routeLoading = false;
  bool _routeStale = false;
  String? _routeLoadingMessage;
  int _routeRequestToken = 0;
  DisasterType? _disasterType;
  StaticFeature? _requestedRouteDestination;
  bool _routeRecommendation = false;
  bool _routeWorkRunning = false;
  bool _routeRefreshReady = false;
  bool _foreground = true;
  Timer? _routeRefreshTimer;
  Timer? _routeExpiryTimer;
  RouteEventSnapshot? _observedRouteEvents;
  String? _routeUpdateReason;
  String? _routeUpdateNotice;

  DateTime get _routeNow =>
      (widget.routeClock?.call() ?? DateTime.now()).toUtc();
  String _eventFingerprint(Iterable<MeshEvent> events) =>
      RouteEventSnapshot(events, _routeNow).fingerprint;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _bridge = widget.bridge ?? MapBridge();
    _locationController = widget.locationController ?? LocationController();
    _locationSubscription = _locationController.locations.listen((location) {
      if (!mounted) return;
      if (_runtimeState.currentLocation == location) return;
      setState(() {
        _runtimeState = _runtimeState.copyWith(currentLocation: location);
      });
    });
    _runtimeState = _runtimeState.copyWith(
      themeMode: widget.themeMode,
      animationEnabled: widget.animationEnabled,
    );
    _load();
  }

  @override
  void didUpdateWidget(covariant MapScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _refreshRouteVisibility();
    final nextFeatures = widget.staticFeatures;
    if (nextFeatures != null &&
        !identical(oldWidget.staticFeatures, nextFeatures)) {
      // Verified layers can arrive after the first frame (see
      // MapAppController._loadVerifiedStaticFeatures).
      setState(() {
        _staticFeatures = nextFeatures;
        _rebuildSearchIndex();
      });
    }
    final preferencesChanged =
        oldWidget.themeMode != widget.themeMode ||
        oldWidget.animationEnabled != widget.animationEnabled;
    if (!preferencesChanged) return;
    setState(() {
      _runtimeState = _runtimeState.copyWith(
        themeMode: preferencesChanged ? widget.themeMode : null,
        animationEnabled: preferencesChanged ? widget.animationEnabled : null,
      );
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _routeRefreshTimer?.cancel();
    _routeExpiryTimer?.cancel();
    _searchWorker?.close();
    if (!kReleaseMode) AppPerformance.search = null;
    _eventSubscription?.cancel();
    _locationSubscription?.cancel();
    _mapSearchDebounce?.cancel();
    _reportAddressSearchDebounce?.cancel();
    _searchController.dispose();
    _reportAddressController.dispose();
    if (widget.locationController == null) {
      unawaited(_locationController.dispose());
    }
    super.dispose();
  }

  Future<void> _load() async {
    unawaited(_loadSearchAssetInBackground());
    unawaited(_loadAddressPacks());
    final featureFuture =
        widget.staticFeatures == null
            ? _loadStaticFeatures()
            : Future<StaticFeatureCollection>.value(widget.staticFeatures);
    final stateFuture =
        widget.initialState == null
            ? _loadInitialStateSafely()
            : Future<MapInitialState>.value(widget.initialState);
    final administrativeFuture = _loadAdministrativeIndexSafely();
    final staticFeatures = await featureFuture;
    if (!mounted) return;
    setState(() {
      // A newer collection may have arrived through didUpdateWidget meanwhile.
      _staticFeatures = widget.staticFeatures ?? staticFeatures;
      _rebuildSearchIndex();
    });
    unawaited(
      administrativeFuture.then((administrativeIndex) {
        if (!mounted) return;
        setState(() {
          _administrativeIndex = administrativeIndex;
          _rebuildSearchIndex();
        });
      }),
    );
    unawaited(
      stateFuture.then((initialState) {
        if (!mounted) return;
        setState(() {
          _persistedEvents = initialState.events;
          _emergencyModeEnabled = initialState.emergencyModeEnabled;
        });
        _listenForEventUpdates();
      }),
    );
  }

  Future<StaticFeatureCollection> _loadStaticFeatures() async {
    return const StaticFeatureCollection(
      schemaVersion: 'feature-v0',
      datasetId: 'resilientgeo-taiwan',
      snapshotAt: null,
      features: <StaticFeature>[],
    );
  }

  Future<void> _loadAddressPacks() async {
    List<TaiwanSearchEntry> installed = const <TaiwanSearchEntry>[];
    try {
      installed = await _addressPackStore.loadInstalledPacks();
    } on Object {
      // Keep the map available if an old local package cannot be read.
    }
    if (mounted && installed.isNotEmpty) {
      setState(() {
        _addressSearchEntries = installed;
        _rebuildSearchIndex();
      });
    }
    try {
      final catalog = await _addressPackStore.loadCatalog();
      if (!mounted) return;
      setState(() => _addressPackCatalog = catalog);
    } on Object {
      // A verified installed county package remains searchable offline.
    }
  }

  Future<void> _openAddressPackDialog() async {
    var catalog = _addressPackCatalog;
    try {
      catalog ??= await _addressPackStore.loadCatalog();
      _addressPackCatalog = catalog;
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('無法載入門牌索引目錄：$error')));
      return;
    }
    if (!mounted) return;
    final installed = Set<String>.from(_addressPackStore.installedCountyCodes);
    final progressByCounty = <String, Map<String, dynamic>>{};
    var allowMobileData = false;
    String? downloadingCounty;
    String? message;
    Timer? progressTimer;

    void pollProgress(String countyCode, StateSetter dialogSetState) {
      progressTimer?.cancel();
      progressTimer = Timer.periodic(const Duration(milliseconds: 600), (
        _,
      ) async {
        try {
          final progress = await _addressPackStore.progress(countyCode);
          if (!context.mounted) return;
          dialogSetState(() => progressByCounty[countyCode] = progress);
        } on Object {
          // Keep the latest progress visible if a transient status poll fails.
        }
      });
    }

    await showDialog<void>(
      context: context,
      builder:
          (dialogContext) => StatefulBuilder(
            builder:
                (context, dialogSetState) => AlertDialog(
                  title: const Text('門牌索引（按縣市下載）'),
                  content: SizedBox(
                    width: 520,
                    height: 520,
                    child: Column(
                      children: <Widget>[
                        if (!kIsWeb)
                          SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            title: const Text('允許使用行動網路下載'),
                            value: allowMobileData,
                            onChanged:
                                (value) => dialogSetState(
                                  () => allowMobileData = value,
                                ),
                          ),
                        if (message != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Text(
                              message!,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                          ),
                        Expanded(
                          child: ListView.separated(
                            itemCount: catalog!.counties.length,
                            separatorBuilder:
                                (_, _) => const Divider(height: 1),
                            itemBuilder: (context, index) {
                              final county = catalog!.counties[index];
                              final progress =
                                  progressByCounty[county.code] ??
                                  const <String, dynamic>{};
                              final state =
                                  progress['state'] as String? ?? 'idle';
                              final isInstalled = installed.contains(
                                county.code,
                              );
                              final isDownloading =
                                  downloadingCounty == county.code &&
                                  const {
                                    'checking',
                                    'downloading',
                                    'verifying',
                                  }.contains(state);
                              final details =
                                  county.available
                                      ? '${county.locatedCount ?? 0} 筆門牌位置${county.partial ? '・來源仍有未定位或排除資料' : ''}'
                                      : '尚無門牌資料涵蓋';
                              final total =
                                  (progress['total'] as num?)?.toDouble() ?? 0;
                              final loaded =
                                  (progress['loaded'] as num?)?.toDouble() ?? 0;
                              final trailing =
                                  isInstalled
                                      ? const Text('已下載')
                                      : isDownloading
                                      ? SizedBox(
                                        width: 78,
                                        child: Column(
                                          mainAxisAlignment:
                                              MainAxisAlignment.center,
                                          children: <Widget>[
                                            LinearProgressIndicator(
                                              value:
                                                  total > 0
                                                      ? (loaded / total)
                                                          .clamp(0, 1)
                                                          .toDouble()
                                                      : null,
                                            ),
                                            const SizedBox(height: 4),
                                            Text(
                                              total > 0
                                                  ? '${(loaded / total * 100).round()}%'
                                                  : '準備中',
                                            ),
                                          ],
                                        ),
                                      )
                                      : county.available
                                      ? TextButton(
                                        onPressed:
                                            downloadingCounty == null
                                                ? () async {
                                                  dialogSetState(() {
                                                    downloadingCounty =
                                                        county.code;
                                                    message = null;
                                                  });
                                                  pollProgress(
                                                    county.code,
                                                    dialogSetState,
                                                  );
                                                  try {
                                                    final result =
                                                        await _addressPackStore
                                                            .downloadCounty(
                                                              county,
                                                              allowMobileData:
                                                                  allowMobileData,
                                                            );
                                                    if (result.ready) {
                                                      installed.add(
                                                        county.code,
                                                      );
                                                      if (mounted) {
                                                        setState(() {
                                                          _addressPackStore
                                                              .installedCountyCodes
                                                              .add(county.code);
                                                        });
                                                      }
                                                    } else {
                                                      message =
                                                          result.message ??
                                                          '目前無法下載門牌索引';
                                                    }
                                                  } on Object catch (error) {
                                                    message = '下載或驗證失敗：$error';
                                                  } finally {
                                                    progressTimer?.cancel();
                                                    downloadingCounty = null;
                                                    if (dialogContext.mounted) {
                                                      final latestProgress =
                                                          await _addressPackStore
                                                              .progress(
                                                                county.code,
                                                              );
                                                      dialogSetState(() {
                                                        progressByCounty[county
                                                                .code] =
                                                            latestProgress;
                                                      });
                                                    }
                                                  }
                                                }
                                                : null,
                                        child: const Text('下載'),
                                      )
                                      : const Icon(Icons.block, size: 20);
                              return ListTile(
                                dense: true,
                                title: Text(county.name),
                                subtitle: Text(details),
                                trailing: SizedBox(
                                  width: 88,
                                  child: Center(child: trailing),
                                ),
                              );
                            },
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          catalog.attribution,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('關閉'),
                    ),
                  ],
                ),
          ),
    );
    progressTimer?.cancel();
  }

  Future<TaiwanSearchAsset> _loadSearchAsset() async {
    final raw = await rootBundle.loadString(
      'assets/map/search/taiwan-roads.json',
    );
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      throw const FormatException('Taiwan search asset root must be an object');
    }
    return TaiwanSearchAsset.fromJson(Map<String, dynamic>.from(decoded));
  }

  Future<MapAdministrativeIndex?> _loadAdministrativeIndexSafely() async {
    try {
      final raw = await rootBundle.loadString(
        OfflineMapAssetStore.referenceLabelsAsset,
      );
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return MapAdministrativeIndex.fromJson(
        Map<String, dynamic>.from(decoded),
      );
    } on Object {
      return null;
    }
  }

  Future<void> _loadSearchAssetInBackground() async {
    try {
      if (!kIsWeb) {
        final raw = await rootBundle.loadString(
          'assets/map/search/taiwan-roads.json',
        );
        final worker = await OfflineSearchWorker.start(raw);
        if (!mounted) {
          worker.close();
          return;
        }
        _searchWorker = worker;
        if (!kReleaseMode) AppPerformance.search = worker.search;
        _rebuildSearchIndex();
        return;
      }
      final asset = await _loadSearchAsset();
      if (!mounted) return;
      setState(() {
        _searchAsset = asset;
        _rebuildSearchIndex();
      });
    } on Object {
      // Static facilities and the map remain usable if the optional search
      // index asset is unavailable; no online fallback is introduced.
    }
  }

  void _rebuildSearchIndex() {
    final staticFeatures = _staticFeatures;
    if (staticFeatures == null) {
      _searchIndex = null;
      return;
    }
    _searchIndex = MapSearchIndex(
      staticFeatures.features,
      roadEntries: _searchAsset?.entries ?? const <TaiwanSearchEntry>[],
      addressEntries: _addressSearchEntries,
      administrativeAreas:
          _administrativeIndex?.searchableAreas ??
          const <MapAdministrativeArea>[],
    );
    _searchWorker?.update(
      staticFeatures.features,
      _administrativeIndex?.searchableAreas ?? const [],
      _addressSearchEntries,
    );
    if (_searchText.isNotEmpty) unawaited(_refreshSearchResults(_searchText));
  }

  Future<MapInitialState> _loadInitialStateSafely() async {
    try {
      return await _bridge.getInitialState();
    } catch (_) {
      return const MapInitialState(
        events: <MeshEvent>[],
        emergencyModeEnabled: false,
      );
    }
  }

  void _listenForEventUpdates() {
    final updates =
        widget.eventUpdates ??
        (widget.initialState == null ? _bridge.events : null);
    _eventSubscription = updates?.listen(_applyEventSnapshot, onError: (_) {});
  }

  void _applyEventSnapshot(List<MeshEvent> events) {
    if (!mounted) return;
    setState(() {
      _persistedEvents = events;
    });
    _checkRouteEvents();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _refreshRouteVisibility();
  }

  void _refreshRouteVisibility() {
    if (!_foreground || !widget.active) {
      _routeExpiryTimer?.cancel();
      return;
    }
    _checkRouteEvents();
    _maybeRunRouteRefresh();
  }

  void _checkRouteEvents() {
    if (!_routeSheetVisible) return;
    final snapshot = RouteEventSnapshot(_persistedEvents, _routeNow);
    final reason = _observedRouteEvents?.changeReason(snapshot);
    _observedRouteEvents = snapshot;
    if (reason != null) _invalidateRoute(reason);
    _armRouteExpiry();
  }

  void _armRouteExpiry() {
    _routeExpiryTimer?.cancel();
    if (!_routeSheetVisible || !_foreground || !widget.active) return;
    final expires = RouteEventSnapshot.nextExpiry(_persistedEvents, _routeNow);
    if (expires == null) return;
    _routeExpiryTimer = Timer(expires.difference(_routeNow), _checkRouteEvents);
  }

  void _invalidateRoute(String reason) {
    if (!_routeSheetVisible) return;
    // Native work cannot be cancelled. Invalidate its response and wait before
    // starting another request, so bursts never queue overlapping native work.
    _routeRequestToken++;
    _routeUpdateReason = reason;
    setState(() {
      _routeResult = null;
      _routeErrorMessage = null;
      _routeStale = true;
      _routeLoading = true;
      _routeLoadingMessage = '正在更新逃生路線…';
      _routeUpdateNotice = '$reason，正在自動重新規劃';
    });
    _routeRefreshReady = false;
    _routeRefreshTimer?.cancel();
    _routeRefreshTimer = Timer(const Duration(milliseconds: 600), () {
      _routeRefreshReady = true;
      _maybeRunRouteRefresh();
    });
  }

  void _maybeRunRouteRefresh() {
    if (!mounted ||
        !_routeSheetVisible ||
        !_routeRefreshReady ||
        _routeWorkRunning ||
        !_foreground ||
        !widget.active) {
      return;
    }
    unawaited(_runRouteRequest());
  }

  Future<void> _calculateRouteTo(StaticFeature shelter) async {
    if (_routeLoading) return;
    _requestedRouteDestination = shelter;
    _routeRecommendation = false;
    await _startRouteRequest();
  }

  Future<void> _recommendNearestShelter() async {
    if (_routeLoading) return;
    _requestedRouteDestination = null;
    _routeRecommendation = true;
    await _startRouteRequest();
  }

  Future<void> _startRouteRequest() async {
    _routeRefreshTimer?.cancel();
    _routeUpdateReason = null;
    _routeUpdateNotice = null;
    _observedRouteEvents = RouteEventSnapshot(_persistedEvents, _routeNow);
    _routeSheetVisible = true;
    _routeRefreshReady = true;
    _armRouteExpiry();
    if (_routeWorkRunning) {
      setState(() {
        _routeLoading = true;
        _routeDestination = _requestedRouteDestination;
        _routeResult = null;
        _routeErrorMessage = null;
        _routeStale = false;
        _selectedFeature = null;
        _selectedEvent = null;
      });
      return;
    }
    await _runRouteRequest();
  }

  Future<void> _runRouteRequest() async {
    _routeRefreshReady = false;
    _routeWorkRunning = true;
    _routeLoading = false;
    final reason = _routeUpdateReason;
    final requestToken = _routeRequestToken + 1;
    try {
      if (_routeRecommendation) {
        await _performShelterRecommendation();
      } else {
        await _performRouteTo(_requestedRouteDestination!);
      }
      if (mounted &&
          requestToken == _routeRequestToken &&
          _routeSheetVisible &&
          !_routeRefreshReady &&
          !_routeStale &&
          reason != null) {
        setState(() {
          _routeUpdateNotice =
              _routeErrorMessage != null
                  ? '$reason，重新規劃失敗，請重試'
                  : '$reason，已自動重新規劃';
        });
      }
    } on Object catch (error) {
      if (mounted &&
          requestToken == _routeRequestToken &&
          _routeSheetVisible &&
          !_routeStale) {
        setState(() {
          _routeLoading = false;
          _routeResult = null;
          _routeErrorMessage = _routeErrorMessageFor(error);
        });
      }
    } finally {
      _routeWorkRunning = false;
      if (mounted) {
        _armRouteExpiry();
        _maybeRunRouteRefresh();
      }
    }
  }

  void _retryRoute() {
    if (_routeLoading) return;
    unawaited(_startRouteRequest());
  }

  List<MeshEvent> get _visibleEvents {
    final byId = <String, MeshEvent>{};
    for (final event in _persistedEvents) {
      byId[meshEventIdentity(event)] = event;
    }
    final now = DateTime.now().toUtc();
    return AttestationIndex.fromEvents(byId.values, now: now)
        .mapDisplayEvents(byId.values)
        .where((event) => event.isShownAt(now))
        .where(isMapVisibleEvent)
        .toList(growable: false);
  }

  String? _corroborationOf(MeshEvent event) =>
      corroborationLabel(corroborationCount(event, _persistedEvents));

  void _showStaticSelection(List<StaticFeature> features) {
    if (features.isEmpty) return;
    if (features.length == 1) {
      setState(() {
        _selectedFeature = features.single;
        _selectedEvent = null;
      });
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      builder:
          (context) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('選擇地點', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 8),
                  ...features.map(
                    (feature) => ListTile(
                      title: Text(featureName(feature)),
                      subtitle: Text(
                        feature.kind == 'medical' ? '醫療院所' : '避難所',
                      ),
                      onTap: () {
                        Navigator.of(context).pop();
                        setState(() {
                          _selectedFeature = feature;
                          _selectedEvent = null;
                        });
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
    );
  }

  void _showEvent(MeshEvent event) => setState(() {
    _selectedEvent = event;
    _selectedFeature = null;
  });

  void _closeDetails() => setState(() {
    _selectedFeature = null;
    _selectedEvent = null;
  });

  Future<void> _performRouteTo(StaticFeature shelter) async {
    if (_routeLoading) return;
    final requestToken = ++_routeRequestToken;
    final eventFingerprint = _eventFingerprint(_persistedEvents);
    setState(() {
      _routeDestination = shelter;
      _routeResult = null;
      _routeErrorMessage = null;
      _routeLoading = true;
      _routeStale = false;
      _routeLoadingMessage = null;
      _routeSheetVisible = true;
      _selectedFeature = null;
      _selectedEvent = null;
    });

    final geometry = shelter.geometry;
    final shelterId = shelter.id;
    final shelterPoint = geometry is PointGeometry ? geometry.point : null;
    if (shelterId == null || shelterId.isEmpty || shelterPoint == null) {
      if (!mounted || requestToken != _routeRequestToken) return;
      setState(() {
        _routeLoading = false;
        _routeLoadingMessage = null;
        _routeResult = _invalidRouteResult;
      });
      return;
    }

    var origin = _runtimeState.currentLocation;
    if (origin == null) {
      origin = await _locationController.requestCurrentLocation();
      if (!mounted || requestToken != _routeRequestToken) return;
      if (origin == null) {
        setState(() {
          _routeLoading = false;
          _routeLoadingMessage = null;
          _routeErrorMessage = '無法取得目前位置，請開啟瀏覽器或裝置定位權限';
        });
        return;
      }
      setState(() {
        _runtimeState = _runtimeState.copyWith(currentLocation: origin);
      });
    }

    try {
      final result = await _bridge.calculateEvacuationRoute(
        origin: origin,
        disasterType: _disasterType,
        destination: ShelterRouteCandidate(
          id: shelterId,
          location: shelterPoint,
        ),
      );
      if (!mounted || requestToken != _routeRequestToken) return;
      final stale = _eventFingerprint(_persistedEvents) != eventFingerprint;
      if (stale) {
        _checkRouteEvents();
        return;
      }
      setState(() {
        _routeLoading = false;
        _routeLoadingMessage = null;
        _routeErrorMessage = null;
        _routeResult = result;
        _routeStale = stale;
      });
    } on Object catch (error) {
      if (!mounted || requestToken != _routeRequestToken) return;
      setState(() {
        _routeLoading = false;
        _routeLoadingMessage = null;
        _routeResult = null;
        _routeErrorMessage = _routeErrorMessageFor(error);
      });
    }
  }

  Future<void> _performShelterRecommendation() async {
    if (_routeLoading) return;
    final requestToken = ++_routeRequestToken;
    final eventFingerprint = _eventFingerprint(_persistedEvents);
    setState(() {
      _routeDestination = null;
      _routeResult = null;
      _routeErrorMessage = null;
      _routeLoading = true;
      _routeLoadingMessage = null;
      _routeStale = false;
      _routeSheetVisible = true;
      _selectedFeature = null;
      _selectedEvent = null;
    });

    var origin = _runtimeState.currentLocation;
    if (origin == null) {
      origin = await _locationController.requestCurrentLocation();
      if (!mounted || requestToken != _routeRequestToken) return;
      if (origin == null) {
        setState(() {
          _routeLoading = false;
          _routeErrorMessage = '無法取得目前位置，請開啟瀏覽器或裝置定位權限';
        });
        return;
      }
      setState(() {
        _runtimeState = _runtimeState.copyWith(currentLocation: origin);
      });
    }

    final features = _staticFeatures?.features ?? const <StaticFeature>[];
    final candidates = shortlistShelterCandidates(
      origin,
      features,
      limit: 50,
      maxDistanceM: 20000,
      disasterType: _disasterType,
    );
    if (candidates.isEmpty) {
      if (!mounted || requestToken != _routeRequestToken) return;
      setState(() {
        _routeLoading = false;
        _routeErrorMessage =
            _disasterType == null
                ? '20 公里內沒有可推薦的避難所'
                : '20 公里內沒有適用於${_disasterType!.label}或類別不明的候選避難所';
      });
      return;
    }
    final featuresById = <String, StaticFeature>{
      for (final feature in features)
        if (feature.id != null) feature.id!: feature,
    };

    EvacuationRouteResult? bestRoute;
    EvacuationRouteResult? failedRoute;
    StaticFeature? bestFeature;
    final searchClock = Stopwatch()..start();
    var checked = 0;
    for (var index = 0; index < candidates.length; index += 1) {
      if (searchClock.elapsed > const Duration(seconds: 15)) break;
      // Snap-to-graph may remove up to 300 m at the origin and 100 m at the shelter.
      // Beyond this bound, a candidate cannot improve the shortest route already found.
      if (index >= 5 &&
          bestRoute != null &&
          shelterAirDistanceM(origin, candidates[index].location) >
              bestRoute.distanceM! + 400) {
        break;
      }
      if (!mounted || requestToken != _routeRequestToken) return;
      if (_eventFingerprint(_persistedEvents) != eventFingerprint) {
        _checkRouteEvents();
        return;
      }
      setState(() {
        _routeLoadingMessage = '正在比較可達避難所（${index + 1}/${candidates.length}）';
      });

      EvacuationRouteResult result;
      try {
        result = await _bridge.calculateEvacuationRoute(
          origin: origin,
          destination: candidates[index],
          disasterType: _disasterType,
        );
        checked++;
      } on Object catch (error) {
        if (!mounted || requestToken != _routeRequestToken) return;
        _finishRecommendationWithError(
          requestToken,
          _routeErrorMessageFor(error),
        );
        return;
      }
      if (!mounted || requestToken != _routeRequestToken) return;
      if (_eventFingerprint(_persistedEvents) != eventFingerprint) {
        _checkRouteEvents();
        return;
      }

      if (result.status == EvacuationRouteStatus.noRoute) {
        failedRoute ??= result;
        // All candidates share this origin. Trying more shelters cannot
        // make an origin outside the bundled road network routable.
        if (result.warnings.any(
          (warning) => warning.code == 'ORIGIN_OFF_GRAPH',
        )) {
          setState(() {
            _routeLoading = false;
            _routeLoadingMessage = null;
            _routeResult = result;
            _routeErrorMessage = null;
          });
          return;
        }
        continue;
      }
      if (result.status != EvacuationRouteStatus.ok) {
        setState(() {
          _routeLoading = false;
          _routeLoadingMessage = null;
          _routeResult = result;
          _routeErrorMessage = null;
        });
        return;
      }
      final distance = result.distanceM;
      if (distance == null || !distance.isFinite || distance < 0) {
        _finishRecommendationWithError(requestToken, '路線資料格式錯誤，未顯示路線');
        return;
      }
      if (bestRoute == null || distance < bestRoute.distanceM!) {
        bestRoute = result;
        bestFeature = featuresById[candidates[index].id];
      }
    }

    if (!mounted || requestToken != _routeRequestToken) return;
    if (_eventFingerprint(_persistedEvents) != eventFingerprint) {
      _checkRouteEvents();
      return;
    }
    setState(() {
      _routeLoading = false;
      _routeLoadingMessage = null;
      _routeResult = (bestRoute ?? failedRoute ?? _noRouteResult).withWarning(
        RouteWarning(
          code: 'RECOMMENDATION_SCOPE',
          eventId: null,
          message: '已比較 $checked 處候選避難所；搜尋限於 20 公里內、最多 50 處，推薦不涵蓋範圍外設施',
        ),
      );
      if (bestRoute == null && checked == 0) {
        _routeErrorMessage = '已檢查 $checked 處候選避難所（20 公里內，最多 50 處），未找到可達路線';
      }
      _routeDestination = bestFeature;
      if (bestRoute != null || checked > 0) _routeErrorMessage = null;
    });
  }

  void _finishRecommendationWithError(int requestToken, String message) {
    if (!mounted || requestToken != _routeRequestToken) return;
    setState(() {
      _routeLoading = false;
      _routeLoadingMessage = null;
      _routeResult = null;
      _routeErrorMessage = message;
      _routeStale = false;
    });
  }

  void _closeRoute() {
    _routeRefreshTimer?.cancel();
    _routeExpiryTimer?.cancel();
    _routeRefreshReady = false;
    _observedRouteEvents = null;
    _routeUpdateReason = null;
    _routeUpdateNotice = null;
    // Incrementing the token means a late native response cannot reopen or
    // replace a route the user dismissed.
    _routeRequestToken += 1;
    setState(() {
      _routeDestination = null;
      _routeResult = null;
      _routeErrorMessage = null;
      _routeSheetVisible = false;
      _routeLoading = false;
      _routeLoadingMessage = null;
      _routeStale = false;
    });
  }

  String _routeErrorMessageFor(Object error) => switch (error) {
    BridgeFailure(:final code) => switch (code) {
      BridgeFailureCode.unavailable => '此功能需要 Android App，Chrome 僅供地圖與資料預覽',
      BridgeFailureCode.graphUnavailable => '離線路網尚未載入',
      BridgeFailureCode.invalidInput => '起點或避難所資料不完整',
      BridgeFailureCode.routeEngineError => '路線計算失敗，請稍後再試',
      _ => '路線計算失敗，請稍後再試',
    },
    FormatException() => '路線資料格式錯誤，未顯示路線',
    _ => '路線計算失敗，請稍後再試',
  };

  Future<void> _openLayerPanel() async {
    StateSetter? updateModal;
    var panelOpen = true;
    var modeChanged = false;
    // Open immediately even if a preview host has no native channel.
    unawaited(
      _bridge
          .getInitialState()
          .then((state) {
            if (!mounted || !panelOpen || modeChanged) return;
            setState(() => _emergencyModeEnabled = state.emergencyModeEnabled);
            updateModal?.call(() {});
          })
          .catchError((Object _) {}),
    );
    await showModalBottomSheet<void>(
      context: context,
      builder:
          (context) => StatefulBuilder(
            builder: (context, modalSetState) {
              updateModal = modalSetState;
              return LayerFilterPanel(
                showShelters: _showShelters,
                showMedical: _showMedical,
                showEvents: _showEvents,
                emergencyModeEnabled: _emergencyModeEnabled,
                disasterType: _disasterType,
                onDisasterTypeChanged:
                    _routeLoading
                        ? null
                        : (value) {
                          if (value == _disasterType) return;
                          setState(() {
                            _disasterType = value;
                          });
                          _invalidateRoute('災害情境變更');
                          modalSetState(() {});
                        },
                onOpenSyncStatus: () {
                  Navigator.of(context).pop();
                  unawaited(_openSyncStatus());
                },
                onSheltersChanged: (value) {
                  setState(() => _showShelters = value);
                  modalSetState(() {});
                },
                onMedicalChanged: (value) {
                  setState(() => _showMedical = value);
                  modalSetState(() {});
                },
                onEventsChanged: (value) {
                  setState(() => _showEvents = value);
                  modalSetState(() {});
                },
                onEmergencyModeChanged: (value) async {
                  modeChanged = true;
                  await _setEmergencyMode(value);
                  if (context.mounted) modalSetState(() {});
                },
              );
            },
          ),
    );
    panelOpen = false;
  }

  Future<void> _openSyncStatus() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SyncStatusScreen(bridge: _bridge),
      ),
    );
    try {
      final status = await _bridge.getSyncStatus();
      if (mounted) {
        setState(() => _emergencyModeEnabled = status.emergencyModeEnabled);
      }
    } catch (_) {
      /* Status page exposes the error; preserve the last mode. */
    }
  }

  Future<void> _setEmergencyMode(bool enabled) async {
    try {
      final confirmed = await _bridge.setEmergencyMode(enabled: enabled);
      if (mounted) setState(() => _emergencyModeEnabled = confirmed);
    } catch (_) {
      _showMessage('緊急模式需由 Android 主機提供');
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  void _openCrowdReport() {
    _reportAddressSearchDebounce?.cancel();
    _reportAddressController.clear();
    setState(() {
      _selectedFeature = null;
      _selectedEvent = null;
      _reportDraft = const CrowdReportDraft(
        category: CrowdReportCategory.roadBlockage,
        location: null,
        locationSource: null,
        description: '',
      );
      _reportStep = CrowdReportSheetStep.edit;
      _reportSheetVisible = true;
      _reportPicking = false;
    });
  }

  void _closeCrowdReport() {
    if (_reportSubmitting) return;
    _reportAddressSearchDebounce?.cancel();
    setState(() {
      _reportDraft = null;
      _reportSheetVisible = false;
      _reportPicking = false;
      _reportStep = CrowdReportSheetStep.edit;
    });
    _reportAddressController.clear();
  }

  Future<void> _setReportCurrentLocation() async {
    final location = await _locationController.requestCurrentLocation();
    if (!mounted) return;
    if (location == null) {
      _showMessage('無法取得目前位置，請開啟瀏覽器或裝置定位權限');
      return;
    }
    final draft = _reportDraft;
    if (draft == null) return;
    setState(() {
      _runtimeState = _runtimeState.copyWith(currentLocation: location);
      _reportDraft = draft.copyWith(
        location: location,
        locationSource: CrowdReportLocationSource.currentLocation,
        locationHint: null,
      );
    });
  }

  void _beginReportMapPick() {
    if (_reportDraft == null || _reportSubmitting) return;
    setState(() {
      _reportSheetVisible = false;
      _reportPicking = true;
      _selectedFeature = null;
      _selectedEvent = null;
    });
  }

  void _returnToReportForm() {
    if (_reportDraft == null || _reportSubmitting) return;
    setState(() {
      _reportPicking = false;
      _reportSheetVisible = true;
    });
  }

  void _confirmReportMapLocation() {
    final draft = _reportDraft;
    if (draft == null || draft.location == null) {
      _showMessage('請先讓中心圖釘取得地圖位置');
      return;
    }
    setState(() {
      _reportPicking = false;
      _reportSheetVisible = true;
    });
  }

  void _onReportCameraSettled(GeoPoint point) {
    final draft = _reportDraft;
    if (!mounted || draft == null) return;
    setState(() {
      _reportDraft = draft.copyWith(
        location: point,
        locationSource: CrowdReportLocationSource.mapPick,
      );
    });
  }

  void _onReportAddressChanged(String value) {
    _reportSearchGeneration++;
    if (!mounted) return;
    _reportAddressSearchDebounce?.cancel();
    if (value.trim().isEmpty) {
      unawaited(_refreshSearchResults(value, report: true));
      return;
    }
    _reportAddressSearchDebounce = Timer(const Duration(milliseconds: 180), () {
      if (!mounted) return;
      unawaited(_refreshSearchResults(value, report: true));
    });
  }

  void _onReportAddressSelected(MapSearchResult result) {
    _reportSearchGeneration++;
    final draft = _reportDraft;
    if (draft == null || _reportSubmitting) return;
    final coordinate = result.coordinate;
    if (coordinate == null) {
      _showMessage('這筆院所資料尚未定位，請改用已定位地址或在地圖上選點');
      return;
    }
    _reportAddressSearchDebounce?.cancel();
    final query = _reportAddressController.text.trim();
    final hint = _locationHintFor(result, query);
    _reportAddressController.text = result.displayTitle;
    _reportAddressController.selection = TextSelection.collapsed(
      offset: _reportAddressController.text.length,
    );
    setState(() {
      _reportDraft = draft.copyWith(
        location: coordinate,
        locationSource: CrowdReportLocationSource.mapPick,
        locationHint: hint,
      );
      _focusPoint = coordinate;
      _focusRequestId += 1;
      _searchSelection = result;
      _reportSheetVisible = false;
      _reportPicking = true;
      _selectedFeature = null;
      _selectedEvent = null;
    });
  }

  CrowdReportLocationHint _locationHintFor(
    MapSearchResult result,
    String query,
  ) {
    final kind = result.searchKind ?? result.feature?.kind;
    final hintKind = switch (kind) {
      'county' => CrowdReportLocationHintKind.county,
      'subdivision' ||
      'district' ||
      'town' => CrowdReportLocationHintKind.district,
      'village' => CrowdReportLocationHintKind.village,
      'road' => CrowdReportLocationHintKind.road,
      _ => CrowdReportLocationHintKind.facility,
    };
    final precision = switch (hintKind) {
      CrowdReportLocationHintKind.county ||
      CrowdReportLocationHintKind.district ||
      CrowdReportLocationHintKind.village => CrowdReportLocationPrecision.area,
      CrowdReportLocationHintKind.road => CrowdReportLocationPrecision.road,
      CrowdReportLocationHintKind.facility =>
        CrowdReportLocationPrecision.point,
    };
    return CrowdReportLocationHint(
      query: query,
      label: result.displayTitle,
      kind: hintKind,
      precision: precision,
    );
  }

  void _showReportConfirmation() {
    final draft = _reportDraft;
    if (draft == null) return;
    final error = draft.validate();
    if (error != null) {
      _showMessage(error);
      return;
    }
    setState(() => _reportStep = CrowdReportSheetStep.confirm);
  }

  Future<void> _submitCrowdReport() async {
    final draft = _reportDraft;
    if (draft == null || _reportSubmitting) return;
    final validationError = draft.validate();
    if (validationError != null) {
      _showMessage(validationError);
      return;
    }
    setState(() => _reportSubmitting = true);
    try {
      final submission = await _bridge.submitCrowdReport(draft);
      if (!mounted) return;
      setState(() {
        _reportSubmitting = false;
        _reportDeliveryEventId = submission.eventId;
        _reportDraft = null;
        _reportSheetVisible = false;
        _reportStep = CrowdReportSheetStep.edit;
      });
      _showMessage('警示已建立：未驗證／待同步');
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _reportSubmitting = false);
      _showMessage(_reportErrorMessage(error));
    }
  }

  String _reportErrorMessage(Object error) => switch (error) {
    BridgeFailure(:final code) => switch (code) {
      BridgeFailureCode.unavailable => '此功能需要 Android App，Chrome 僅供地圖與資料預覽',
      BridgeFailureCode.signingUnavailable => '裝置安全簽署不可用，警示未送出',
      BridgeFailureCode.storageUnavailable => '警示無法儲存至待同步佇列，未送出',
      BridgeFailureCode.invalidInput => '警示資料無效，未送出',
      _ => '警示未送出，請稍後再試',
    },
    FormatException() => '警示資料格式錯誤，未送出',
    _ => '警示未送出，請稍後再試',
  };

  void _setZoomPercentage(int percentage) => setState(() {
    _runtimeState = _runtimeState.copyWith(zoomPercentage: percentage);
  });

  void _selectSearchResult(MapSearchResult result) {
    _mapSearchGeneration++;
    _mapSearchDebounce?.cancel();
    setState(() {
      _searchSelection = result;
      _focusPoint = result.coordinate;
      _selectedFeature = result.feature;
      _selectedEvent = null;
      _searchText = '';
      _mapSearchResults = const [];
      _searchController.clear();
      _focusRequestId += 1;
    });
  }

  void _onMapSearchChanged(String value) {
    _mapSearchGeneration++;
    _mapSearchDebounce?.cancel();
    if (value.trim().isEmpty) {
      if (_searchText.isEmpty) return;
      setState(() {
        _searchText = '';
        _mapSearchResults = const [];
      });
      return;
    }
    _mapSearchDebounce = Timer(const Duration(milliseconds: 180), () {
      if (!mounted) return;
      setState(() => _searchText = value);
      unawaited(_refreshSearchResults(value));
    });
  }

  Future<void> _refreshSearchResults(String text, {bool report = false}) async {
    final generation =
        report ? ++_reportSearchGeneration : ++_mapSearchGeneration;
    try {
      final baseResults =
          _searchWorker == null
              ? _searchIndex?.query(text) ?? const <MapSearchResult>[]
              : (await _searchWorker!.search(text)).results;
      var addressEntries = const <TaiwanSearchEntry>[];
      if (!report) {
        try {
          addressEntries = await _addressPackStore.search(text);
        } on Object {
          // Address packs are an optional local index; keep the bundled search usable.
        }
      }
      final addressResults = addressEntries.map(
        (entry) => MapSearchResult(
          feature: null,
          title: entry.name,
          typeLabel: '門牌位置',
          coordinate: entry.coordinate,
          region: entry.region,
          address: entry.address,
          resultId: entry.id,
          searchKind: 'address',
        ),
      );
      final prioritized = <MapSearchResult>[...addressResults, ...baseResults];
      final resultIds = <String>{};
      final results = prioritized
          .where((result) {
            final id = result.id;
            return id == null || resultIds.add(id);
          })
          .take(MapSearchIndex.maxResults)
          .toList(growable: false);
      if (!mounted ||
          generation !=
              (report ? _reportSearchGeneration : _mapSearchGeneration)) {
        return;
      }
      setState(() {
        if (report) {
          _reportSearchResults = results;
        } else {
          _mapSearchResults = results;
        }
      });
    } on Object {
      /* Optional index failure leaves the map usable. */
    }
  }

  Future<void> _focusCurrentLocation() async {
    final location = await _locationController.requestCurrentLocation();
    if (!mounted) return;
    if (location == null) {
      _showMessage('無法取得目前位置，請開啟瀏覽器或裝置定位權限');
      return;
    }
    setState(() {
      _runtimeState = _runtimeState.copyWith(currentLocation: location);
      _focusPoint = location;
      _searchSelection = null;
      _focusRequestId += 1;
    });
  }

  @override
  Widget build(BuildContext context) {
    final staticFeatures = _staticFeatures;
    if (staticFeatures == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final searchResults = _mapSearchResults;
    final reportAddressQuery =
        _reportSheetVisible && _reportStep == CrowdReportSheetStep.edit
            ? _reportAddressController.text
            : '';
    final reportAddressResults =
        reportAddressQuery.isEmpty
            ? const <MapSearchResult>[]
            : _reportSearchResults;
    return Scaffold(
      body: Stack(
        children: <Widget>[
          MapCanvas(
            runtimeState: _runtimeState,
            staticFeatures: staticFeatures.features,
            administrativeIndex: _administrativeIndex,
            visibleEvents: _visibleEvents,
            showShelters: _showShelters,
            showMedical: _showMedical,
            showEvents: _showEvents,
            onStaticFeatureSelected: _showStaticSelection,
            onEventSelected: _showEvent,
            onZoomPercentageChanged: _setZoomPercentage,
            onOpenLayerSettings: _openLayerPanel,
            onRequestLocation: _focusCurrentLocation,
            onMapTap: _closeDetails,
            onReportCameraIdle: _reportPicking ? _onReportCameraSettled : null,
            showReportLocationPicker: _reportPicking,
            route: _routeStale ? null : _routeResult,
            searchSelection: _searchSelection,
            focusPoint: _focusPoint,
            focusRequestId: _focusRequestId,
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  PointerInterceptor(
                    child: _SearchOverlay(
                      text: _searchText,
                      controller: _searchController,
                      results: searchResults,
                      onChanged: _onMapSearchChanged,
                      onSelected: _selectSearchResult,
                      onAddressPacksPressed: _openAddressPackDialog,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Flexible(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 520),
                          child: _StatusOverlay(
                            snapshotAt: staticFeatures.snapshotAt,
                            hasCurrentLocation:
                                _runtimeState.currentLocation != null,
                            reportDeliveryEventId: _reportDeliveryEventId,
                            staticFeaturesPending: widget.staticFeaturesPending,
                            staticFeaturesFailed: widget.staticFeaturesFailed,
                          ),
                        ),
                      ),
                      const Spacer(),
                      _MapQuickActions(
                        onReport:
                            _reportSheetVisible ||
                                    _reportPicking ||
                                    _routeSheetVisible
                                ? null
                                : _openCrowdReport,
                        onRecommend:
                            _reportSheetVisible ||
                                    _reportPicking ||
                                    _routeSheetVisible
                                ? null
                                : _recommendNearestShelter,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (_reportPicking)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Card(
                        child: Padding(
                          padding: EdgeInsets.all(10),
                          child: Text('請拖動地圖，讓中心圖釘對準警示位置'),
                        ),
                      ),
                    ),
                  if (!_reportPicking && !_reportSheetVisible)
                    PointerInterceptor(
                      child: ActionChip(
                        key: const ValueKey('evacuation-disaster-context'),
                        avatar: const Icon(Icons.tune, size: 18),
                        label: Text('避難情境：${_disasterType?.label ?? '不限類型'}'),
                        onPressed: _routeLoading ? null : _openLayerPanel,
                      ),
                    ),
                  const Spacer(),
                ],
              ),
            ),
          ),
          if (_selectedFeature != null)
            Align(
              alignment: Alignment.bottomCenter,
              child: FeatureDetailsSheet.feature(
                feature: _selectedFeature!,
                snapshotAt: staticFeatures.snapshotAt,
                onClose: _closeDetails,
                onPlanEvacuationRoute:
                    _selectedFeature!.kind == 'shelter'
                        ? () => _calculateRouteTo(_selectedFeature!)
                        : null,
              ),
            ),
          if (_selectedEvent != null)
            Align(
              alignment: Alignment.bottomCenter,
              child: FeatureDetailsSheet.event(
                event: _selectedEvent!,
                corroboration: _corroborationOf(_selectedEvent!),
                onClose: _closeDetails,
              ),
            ),
          if (_reportSheetVisible && _reportDraft != null)
            Align(
              alignment: Alignment.bottomCenter,
              child: CrowdReportSheet(
                draft: _reportDraft!,
                step: _reportStep,
                submitting: _reportSubmitting,
                onDraftChanged: (draft) => setState(() => _reportDraft = draft),
                onRequestCurrentLocation: _setReportCurrentLocation,
                onRequestMapPick: _beginReportMapPick,
                addressController: _reportAddressController,
                addressResults:
                    _reportAddressController.text.trim().isEmpty
                        ? const <MapSearchResult>[]
                        : reportAddressResults,
                onAddressChanged: _onReportAddressChanged,
                onAddressSelected: _onReportAddressSelected,
                onShowConfirmation: _showReportConfirmation,
                onBackToEdit:
                    () =>
                        setState(() => _reportStep = CrowdReportSheetStep.edit),
                onSubmit: _submitCrowdReport,
                onCancel: _closeCrowdReport,
              ),
            ),
          if (_reportPicking && _reportDraft != null)
            Align(
              alignment: Alignment.bottomCenter,
              child: CrowdReportMapPickerBar(
                draft: _reportDraft!,
                onBackToForm: _returnToReportForm,
                onConfirm: _confirmReportMapLocation,
              ),
            ),
          if (_routeSheetVisible)
            Align(
              alignment: Alignment.bottomCenter,
              child: EvacuationRouteSheet(
                route: _routeResult,
                loading: _routeLoading,
                errorMessage: _routeErrorMessage,
                stale: _routeStale,
                loadingMessage: _routeLoadingMessage,
                updateNotice: _routeUpdateNotice,
                destinationName:
                    _routeDestination == null
                        ? null
                        : featureName(_routeDestination!),
                onRecalculate: _retryRoute,
                onClose: _closeRoute,
              ),
            ),
        ],
      ),
    );
  }

}

class _StatusOverlay extends StatelessWidget {
  const _StatusOverlay({
    required this.snapshotAt,
    required this.hasCurrentLocation,
    required this.reportDeliveryEventId,
    this.staticFeaturesPending = false,
    this.staticFeaturesFailed = false,
  });

  final String? snapshotAt;
  final bool hasCurrentLocation;
  final String? reportDeliveryEventId;
  final bool staticFeaturesPending;
  final bool staticFeaturesFailed;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.94),
      borderRadius: BorderRadius.circular(12),
      boxShadow: const <BoxShadow>[
        BoxShadow(color: Colors.black26, blurRadius: 4),
      ],
    ),
    child: Padding(
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: double.infinity,
            child: FittedBox(
              alignment: Alignment.centerLeft,
              fit: BoxFit.scaleDown,
              child: Text(
                '更新時間：${formatUpdateTime(snapshotAt)}',
                maxLines: 1,
                softWrap: false,
              ),
            ),
          ),
          Text('目前位置：${hasCurrentLocation ? '已取得' : '尚未取得'}'),
          if (staticFeaturesPending)
            const Text(
              '避難所資料驗證中…',
              key: ValueKey<String>('static-features-pending'),
            ),
          if (staticFeaturesFailed)
            const Text(
              '避難所與醫療資料尚未驗證，未顯示未核實點位',
              key: ValueKey<String>('static-features-failed'),
            ),
          if (reportDeliveryEventId != null) ...<Widget>[
            const Text('民眾警示：未驗證／待同步'),
            Text('警示編號：$reportDeliveryEventId'),
          ],
        ],
      ),
    ),
  );
}

class _MapQuickActions extends StatelessWidget {
  const _MapQuickActions({this.onReport, this.onRecommend});

  final VoidCallback? onReport;
  final VoidCallback? onRecommend;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      _QuickActionButton(
        key: const ValueKey<String>('open-crowd-report-action'),
        label: '回報警示',
        icon: Icons.warning_amber_rounded,
        onPressed: onReport,
        buttonKey: const ValueKey<String>('open-crowd-report'),
      ),
      const SizedBox(width: 8),
      _QuickActionButton(
        key: const ValueKey<String>('recommend-nearest-shelter-action'),
        label: '推薦最近避難所',
        icon: MapIconCatalog.shelterRecommendation,
        onPressed: onRecommend,
        buttonKey: const ValueKey<String>('recommend-nearest-shelter'),
      ),
    ],
  );
}

class _QuickActionButton extends StatelessWidget {
  const _QuickActionButton({
    super.key,
    required this.label,
    required this.icon,
    required this.onPressed,
    required this.buttonKey,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final Key buttonKey;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    button: true,
    label: label,
    onTap: onPressed,
    child: ExcludeSemantics(
      child: Material(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.94),
        elevation: 4,
        borderRadius: BorderRadius.circular(14),
        child: IconButton(
          key: buttonKey,
          tooltip: label,
          onPressed: onPressed,
          icon: Icon(icon),
        ),
      ),
    ),
  );
}

class _SearchOverlay extends StatelessWidget {
  const _SearchOverlay({
    required this.text,
    required this.controller,
    required this.results,
    required this.onChanged,
    required this.onSelected,
    required this.onAddressPacksPressed,
  });

  final String text;
  final TextEditingController controller;
  final List<MapSearchResult> results;
  final ValueChanged<String> onChanged;
  final ValueChanged<MapSearchResult> onSelected;
  final VoidCallback onAddressPacksPressed;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder:
        (context, constraints) => ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: constraints.maxWidth.clamp(0, 480).toDouble(),
          ),
          child: Material(
            color: Theme.of(
              context,
            ).colorScheme.surface.withValues(alpha: 0.96),
            elevation: 4,
            borderRadius: BorderRadius.circular(14),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Semantics(
                  textField: true,
                  label: '搜尋地點',
                  child: TextField(
                    key: const ValueKey<String>('map-search-field'),
                    controller: controller,
                    onChanged: onChanged,
                    textInputAction: TextInputAction.search,
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      contentPadding: EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 12,
                      ),
                      hintText: '搜尋醫院、避難所或道路',
                      prefixIcon: Icon(Icons.search),
                      suffixIcon: IconButton(
                        tooltip: '下載縣市門牌索引',
                        onPressed: onAddressPacksPressed,
                        icon: const Icon(Icons.download_outlined),
                      ),
                    ),
                  ),
                ),
                if (text.trim().isNotEmpty && results.isNotEmpty)
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 220),
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: results.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final result = results[index];
                        final address =
                            result.address ??
                            result.feature?.details['address'];
                        final location = result.region;
                        final subtitle = <String>[
                          result.typeLabel,
                          if (location != null && location.isNotEmpty) location,
                          if (address is String && address.isNotEmpty) address,
                        ].join('・');
                        return ListTile(
                          dense: true,
                          title: Text(result.displayTitle),
                          subtitle: Text(subtitle),
                          onTap:
                              result.coordinate == null
                                  ? null
                                  : () => onSelected(result),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        ),
  );
}

const EvacuationRouteResult _invalidRouteResult = EvacuationRouteResult(
  status: EvacuationRouteStatus.invalidInput,
  polyline: <GeoPoint>[],
  distanceM: null,
  durationS: null,
  graphVersion: null,
  eventSnapshotAt: null,
  warnings: <RouteWarning>[],
  blockedEventIds: <String>[],
);

const EvacuationRouteResult _noRouteResult = EvacuationRouteResult(
  status: EvacuationRouteStatus.noRoute,
  polyline: <GeoPoint>[],
  distanceM: null,
  durationS: null,
  graphVersion: null,
  eventSnapshotAt: null,
  warnings: <RouteWarning>[],
  blockedEventIds: <String>[],
);
