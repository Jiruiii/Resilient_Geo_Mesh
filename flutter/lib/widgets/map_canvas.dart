import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:pointer_interceptor/pointer_interceptor.dart';

import '../data/map_camera_projection.dart';
import '../data/map_administrative.dart';
import '../data/evacuation_models.dart';
import '../data/map_models.dart';
import '../data/map_runtime_state.dart';
import '../data/map_search.dart';
import '../data/map_marker_projection.dart';
import '../data/map_event_focus.dart';
import '../data/map_zoom.dart';
import '../data/maplibre_map_config.dart';
import '../data/maplibre_overlay.dart';
import '../data/offline_map_asset_store.dart';
import '../data/flutter_test_environment.dart';
import 'map_layers.dart';
import 'map_zoom_controls.dart';

/// The single MapLibre renderer used by the app. Remote and raster tile
/// providers are intentionally absent from this widget.
class MapCanvas extends StatefulWidget {
  const MapCanvas({
    super.key,
    required this.runtimeState,
    required this.staticFeatures,
    required this.visibleEvents,
    required this.showShelters,
    required this.showMedical,
    required this.showEvents,
    required this.onStaticFeatureSelected,
    required this.onEventSelected,
    required this.onZoomPercentageChanged,
    required this.onOpenLayerSettings,
    required this.onRequestLocation,
    required this.onMapTap,
    this.onCoordinatePicked,
    this.onReportCameraIdle,
    this.showReportLocationPicker = false,
    this.route,
    this.administrativeIndex,
    this.onSearchFocus,
    this.onRecenter,
    this.searchSelection,
    this.focusPoint,
    this.focusRequestId = 0,
  });

  static const double minZoom = MapLibreMapConfig.minZoom;
  static const double maxZoom = MapLibreMapConfig.maxZoom;
  static const GeoPoint taiwanOverviewCenter =
      MapLibreMapConfig.taiwanOverviewCenter;

  final MapRuntimeState runtimeState;
  final List<StaticFeature> staticFeatures;
  final List<MeshEvent> visibleEvents;
  final bool showShelters;
  final bool showMedical;
  final bool showEvents;
  final StaticFeatureSelection onStaticFeatureSelected;
  final MeshEventSelection onEventSelected;
  final ValueChanged<int> onZoomPercentageChanged;
  final VoidCallback onOpenLayerSettings;
  final VoidCallback onRequestLocation;
  final VoidCallback onMapTap;
  final ValueChanged<GeoPoint>? onCoordinatePicked;
  final ValueChanged<GeoPoint>? onReportCameraIdle;
  final bool showReportLocationPicker;
  final EvacuationRouteResult? route;
  final MapAdministrativeIndex? administrativeIndex;
  final VoidCallback? onSearchFocus;
  final VoidCallback? onRecenter;
  final MapSearchResult? searchSelection;
  final GeoPoint? focusPoint;
  final int focusRequestId;

  @override
  State<MapCanvas> createState() => _MapCanvasState();
}

class _MapCanvasState extends State<MapCanvas> with TickerProviderStateMixin {
  static const _focusAnimationDuration = Duration(milliseconds: 650);
  static const _overviewPadding = EdgeInsets.fromLTRB(24, 24, 24, 120);
  static const _eventsSourceId = 'app-events';
  static const _eventsLineLayerId = 'app-events-lines';
  static const _eventsFillLayerId = 'app-events-polygons';
  static const _routeSourceId = 'app-evacuation-route';
  static const _routeLineLayerId = 'app-evacuation-route-line';

  final OfflineMapAssetStore _assetStore = OfflineMapAssetStore();
  final ValueNotifier<Offset?> _radarScreenPosition = ValueNotifier(null);
  final ValueNotifier<bool> _tilesLoading = ValueNotifier(true);
  final MapMarkerOverlayNotifier<MapMarkerData> _markerOverlay =
      MapMarkerOverlayNotifier<MapMarkerData>();
  late final AnimationController _pulseController;
  MapLibreMapController? _mapController;
  String? _styleJson;
  String? _requestedStyleAsset;
  int _styleLoadGeneration = 0;
  Widget? _platformMap;
  String? _platformMapStyle;
  LatLngBounds? _platformMapBounds;
  Object? _styleError;
  bool _styleLoaded = false;
  bool _eventSourceReady = false;
  bool _routeSourceReady = false;
  bool _routeLayerReady = false;
  bool _markerRefreshScheduled = false;
  bool _markerProjectionInFlight = false;
  Size? _mapViewportSize;
  CameraPosition? _cameraPosition;
  CameraPosition? _markerLayoutCamera;
  CameraPosition? _lastSettledMarkerCamera;
  final MapCameraProjectionFrameGate<CameraPosition>
  _cameraProjectionFrameGate = MapCameraProjectionFrameGate<CameraPosition>();
  bool _cameraIsMoving = false;
  bool _cameraBoundsCorrectionPending = false;
  double? _cameraBoundsZoomOverride;
  final MapZoomRequestGate _zoomRequestGate = MapZoomRequestGate();
  final MapMarkerProjectionGate _markerProjectionGate =
      MapMarkerProjectionGate();
  late final MapEventFocusGate _eventFocusGate;
  final MapMarkerLayoutCache<List<MapMarkerData>> _markerLayoutCache =
      MapMarkerLayoutCache<List<MapMarkerData>>();
  final MapMarkerZoomLayoutCache<List<MapMarkerData>> _overviewMarkerLayouts =
      MapMarkerZoomLayoutCache<List<MapMarkerData>>();
  List<MapMarkerData>? _locationBaseMarkers;
  List<MapMarkerData>? _markersWithLocation;
  GeoPoint? _lastMarkerLocation;
  bool _markerLayoutReady = false;
  int _lastFocusRequestId = -1;
  int _focusOperationToken = 0;
  Timer? _pulseStartTimer;
  Timer? _pulseStopTimer;
  Timer? _zoomRequestTimer;
  GeoPoint? _pendingEventFocus;
  GeoPoint? _radarEventPoint;
  Color? _radarColor;
  bool _pendingEventAnimated = true;
  bool _radarVisible = false;

  @override
  void initState() {
    super.initState();
    _eventFocusGate = MapEventFocusGate(
      hasInitialSnapshot: widget.visibleEvents.isNotEmpty,
    );
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadStyle();
  }

  @override
  void didUpdateWidget(covariant MapCanvas oldWidget) {
    super.didUpdateWidget(oldWidget);
    final reportCameraIdle = widget.onReportCameraIdle;
    final camera = _cameraPosition;
    if (oldWidget.onReportCameraIdle == null &&
        reportCameraIdle != null &&
        camera != null) {
      // Location picking starts at the current map centre; do not wait for
      // a camera-idle event that only arrives after the user drags.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.onReportCameraIdle == reportCameraIdle) {
          reportCameraIdle(_geoPointFromCamera(camera));
        }
      });
    }
    if (oldWidget.runtimeState.themeMode != widget.runtimeState.themeMode) {
      _loadStyle();
    }
    final eventsChanged =
        !_sameEventSnapshot(oldWidget.visibleEvents, widget.visibleEvents);
    if (eventsChanged || oldWidget.showEvents != widget.showEvents) {
      _overviewMarkerLayouts.clear();
      _markerLayoutCache.invalidate();
      unawaited(_updateEventSource());
      _queueMarkerRefresh();
    }
    if (oldWidget.route != widget.route) {
      unawaited(_ensureRouteLayer());
    }
    if (oldWidget.staticFeatures != widget.staticFeatures ||
        oldWidget.showShelters != widget.showShelters ||
        oldWidget.showMedical != widget.showMedical ||
        oldWidget.administrativeIndex != widget.administrativeIndex) {
      _overviewMarkerLayouts.clear();
      _markerLayoutCache.invalidate();
      _queueMarkerRefresh();
    }
    if (oldWidget.runtimeState.currentLocation !=
        widget.runtimeState.currentLocation) {
      _queueMarkerRefresh();
    }
    final focusingNewEvent = _recordNewEvents(oldWidget.visibleEvents);
    final focus = widget.focusPoint ?? widget.searchSelection?.coordinate;
    if (!focusingNewEvent &&
        focus != null &&
        widget.focusRequestId != _lastFocusRequestId) {
      _lastFocusRequestId = widget.focusRequestId;
      _scheduleLatestFocus(focus, widget.focusRequestId);
    }
    if (oldWidget.runtimeState.currentLocation !=
            widget.runtimeState.currentLocation &&
        widget.runtimeState.currentLocation != null &&
        widget.focusRequestId == _lastFocusRequestId) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _queueMarkerRefresh();
      });
    }
  }

  @override
  void dispose() {
    _pulseStartTimer?.cancel();
    _pulseStopTimer?.cancel();
    _zoomRequestTimer?.cancel();
    _pulseController.dispose();
    _radarScreenPosition.dispose();
    _tilesLoading.dispose();
    _markerOverlay.dispose();
    _mapController?.dispose();
    super.dispose();
  }

  bool get _animationsAllowed =>
      widget.runtimeState.animationEnabled &&
      !(MediaQuery.maybeOf(context)?.disableAnimations ?? false);

  bool get _usesPlatformMap =>
      !isFlutterTest &&
      (kIsWeb ||
          defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  Future<void> _loadStyle() async {
    final styleAsset = MapLibreMapConfig.styleAssetFor(
      themeMode: widget.runtimeState.themeMode,
      systemBrightness: Theme.of(context).brightness,
    );
    // Keyboard/viewport changes also notify inherited-widget dependents.
    // They must not reinstall the same native map style.
    if (_requestedStyleAsset == styleAsset) return;
    _requestedStyleAsset = styleAsset;
    final generation = ++_styleLoadGeneration;
    try {
      final style = await _assetStore.loadStyle(
        styleAsset: styleAsset,
        installNativeAssets: _usesPlatformMap && !kIsWeb,
      );
      if (!mounted || generation != _styleLoadGeneration) return;
      setState(() {
        _styleJson = style;
        _styleError = null;
        _styleLoaded = false;
        _markerLayoutReady = false;
        _markerLayoutCache.invalidate();
        _eventSourceReady = false;
        _routeSourceReady = false;
        _routeLayerReady = false;
      });
    } on Object catch (error) {
      if (!mounted || generation != _styleLoadGeneration) return;
      _requestedStyleAsset = null;
      setState(() => _styleError = error);
    }
  }

  bool _recordNewEvents(List<MeshEvent> oldEvents) {
    final oldKeys = oldEvents.map(eventKey).toSet();
    final newEvents = widget.visibleEvents
        .where((event) => !oldKeys.contains(eventKey(event)))
        .toList(growable: false);
    if (newEvents.isEmpty ||
        !_eventFocusGate.shouldFocusSnapshot(newEvents.map(eventKey))) {
      return false;
    }
    final focus = meshEventFocusPoint(newEvents.last);
    if (focus == null) return false;
    _pendingEventFocus = focus;
    _radarColor = eventColor(newEvents.last);
    _pendingEventAnimated = _animationsAllowed;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_focusPendingEvent());
    });
    return true;
  }

  Future<void> _focusPendingEvent() async {
    final focus = _pendingEventFocus;
    if (focus == null ||
        !await _focus(focus, animated: _pendingEventAnimated)) {
      return;
    }
    _pendingEventFocus = null;
    if (!_pendingEventAnimated) {
      _stopRadar();
      return;
    }
    _pulseStartTimer?.cancel();
    _pulseStopTimer?.cancel();
    _pulseStartTimer = Timer(_focusAnimationDuration, () {
      if (mounted) unawaited(_showRadarAndStop(focus));
    });
  }

  void _scheduleLatestFocus(GeoPoint point, int requestId) {
    final operationToken = ++_focusOperationToken;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          operationToken != _focusOperationToken ||
          requestId != widget.focusRequestId) {
        return;
      }
      unawaited(_focus(point, animated: _animationsAllowed));
    });
  }

  Future<void> _showRadarAndStop(GeoPoint point) async {
    await _showRadar(point);
    if (!mounted || _radarEventPoint != point) return;
    _pulseStopTimer = Timer(const Duration(milliseconds: 3600), () {
      if (mounted) _stopRadar();
    });
  }

  Future<void> _showRadar(GeoPoint point) async {
    _radarEventPoint = point;
    final hasPosition = await _updateRadarScreenPosition(point);
    if (!mounted || _radarEventPoint != point || !hasPosition) return;
    setState(() => _radarVisible = true);
    _pulseController
      ..reset()
      ..repeat();
  }

  void _stopRadar() {
    _pulseStartTimer?.cancel();
    _pulseStartTimer = null;
    _pulseStopTimer?.cancel();
    _pulseStopTimer = null;
    _pulseController.stop();
    _radarEventPoint = null;
    _radarColor = null;
    _radarScreenPosition.value = null;
    if (mounted && _radarVisible) setState(() => _radarVisible = false);
  }

  void _setZoomPercentage(int percentage) {
    final clamped = percentage.clamp(0, 100).toInt();
    widget.onZoomPercentageChanged(clamped);
    final request = _zoomRequestGate.request();
    _zoomRequestTimer?.cancel();
    _zoomRequestTimer = Timer(const Duration(milliseconds: 16), () {
      _zoomRequestTimer = null;
      unawaited(_applyZoomPercentage(clamped, request));
    });
  }

  Future<void> _applyZoomPercentage(int percentage, int request) async {
    if (!_zoomRequestGate.isCurrent(request)) return;
    if (percentage == MapLibreMapConfig.overviewPercentage) {
      await _moveToTaiwanOverview(animated: _animationsAllowed);
      return;
    }
    final zoom = ZoomPercentage.toZoom(
      percentage: percentage,
      minZoom: MapCanvas.minZoom,
      maxZoom: MapCanvas.maxZoom,
      overviewZoom: _overviewReferenceZoom,
    );
    final controller = _mapController;
    if (controller == null || !_zoomRequestGate.isCurrent(request)) return;
    await _prepareNativeCameraBoundsForZoom(zoom);
    if (!_zoomRequestGate.isCurrent(request)) return;
    // Slider changes are coalesced so an old camera command cannot finish
    // after a newer value and move the map back to a stale zoom.
    final current = _cameraPosition;
    final update =
        current == null
            ? CameraUpdate.zoomTo(zoom)
            : CameraUpdate.newLatLngZoom(current.target, zoom);
    await controller.moveCamera(update);
  }

  Future<void> _recenter() async {
    widget.onRecenter?.call();
    _pendingEventFocus = null;
    _stopRadar();
    _zoomRequestTimer?.cancel();
    _zoomRequestGate.request();
    final controller = _mapController;
    if (controller == null) return;
    await _moveToTaiwanHome(animated: _animationsAllowed);
  }

  Future<void> _moveToTaiwanOverview({required bool animated}) async {
    final controller = _mapController;
    if (controller == null) return;
    final overview = MapLibreMapConfig.taiwanOverviewCameraForViewport(
      _mapViewportSize ?? Size.zero,
      padding: _overviewPadding,
    );
    await _prepareNativeCameraBoundsForZoom(overview.zoom);
    widget.onZoomPercentageChanged(MapLibreMapConfig.overviewPercentage);
    if (animated) {
      await controller.animateCamera(
        CameraUpdate.newLatLngZoom(_latLng(overview.target), overview.zoom),
        duration: _focusAnimationDuration,
      );
    } else {
      await controller.moveCamera(
        CameraUpdate.newLatLngZoom(_latLng(overview.target), overview.zoom),
      );
    }
  }

  Future<void> _moveToTaiwanHome({required bool animated}) async {
    await _moveToTaiwanOverview(animated: animated);
  }

  void _onMapSettled() {
    // The native map can report "camera idle" on every frame while nothing
    // moves. Re-running the settle work for an unchanged camera kept calling
    // onReportCameraIdle (rebuilding MapScreen while picking a report
    // location) and rescheduling bounds corrections on every frame.
    final settled = _cameraPosition;
    final lastSettled = _lastSettledMarkerCamera;
    if (settled != null &&
        lastSettled != null &&
        lastSettled.target == settled.target &&
        lastSettled.zoom == settled.zoom &&
        _markerLayoutReady &&
        !_cameraIsMoving &&
        !_cameraBoundsCorrectionPending) {
      return;
    }
    _cameraBoundsCorrectionPending = false;
    _cameraIsMoving = false;
    final position = _cameraPosition;
    if (position == null) return;
    final previous = _lastSettledMarkerCamera;
    final cameraChanged =
        previous?.target != position.target || previous?.zoom != position.zoom;
    final zoomChanged = previous?.zoom != position.zoom;
    if (cameraChanged) {
      _lastSettledMarkerCamera = position;
      final rawMarkerZoom = ZoomPercentage.toZoom(
        percentage: MapLibreMapConfig.revealAllPercentage,
        minZoom: MapCanvas.minZoom,
        maxZoom: MapCanvas.maxZoom,
        overviewZoom: _overviewReferenceZoom,
      );
      if (zoomChanged || position.zoom >= rawMarkerZoom) {
        // Aggregated layouts are independent of the camera centre. Reuse
        // them throughout a pan; only zoom transitions or raw-point viewport
        // filtering need a new layout.
        _markerLayoutCache.invalidate();
        _queueMarkerRefresh();
      }
    } else if (!_markerLayoutReady) {
      _queueMarkerRefresh();
    }
    widget.onReportCameraIdle?.call(
      GeoPoint(
        longitude: position.target.longitude,
        latitude: position.target.latitude,
      ),
    );
    final boundsZoom = _cameraBoundsZoomOverride;
    if (boundsZoom == null || (position.zoom - boundsZoom).abs() >= 0.05) {
      _cameraBoundsZoomOverride = position.zoom;
      if (mounted) setState(() {});
    }
    _scheduleCameraBoundsCorrection(position);
    final percentage = ZoomPercentage.fromZoom(
      zoom: position.zoom,
      minZoom: MapCanvas.minZoom,
      maxZoom: MapCanvas.maxZoom,
      overviewZoom: _overviewReferenceZoom,
    );
    if (percentage != widget.runtimeState.zoomPercentage) {
      widget.onZoomPercentageChanged(percentage);
    }
  }

  void _onMapIdle() {
    if (_tilesLoading.value) _tilesLoading.value = false;
  }

  Future<bool> _focus(GeoPoint point, {required bool animated}) async {
    final controller = _mapController;
    if (controller == null || !_styleLoaded) return false;
    _zoomRequestTimer?.cancel();
    _zoomRequestGate.request();
    const focusPercentage = MapLibreMapConfig.focusPercentage;
    final zoom = ZoomPercentage.toZoom(
      percentage: focusPercentage,
      minZoom: MapCanvas.minZoom,
      maxZoom: MapCanvas.maxZoom,
      overviewZoom: _overviewReferenceZoom,
    );
    widget.onZoomPercentageChanged(focusPercentage);
    final update = CameraUpdate.newLatLngZoom(_latLng(point), zoom);
    await _prepareNativeCameraBoundsForZoom(zoom);
    if (animated) {
      await controller.animateCamera(update, duration: _focusAnimationDuration);
    } else {
      await controller.moveCamera(update);
    }
    return true;
  }

  void _onCameraMove(CameraPosition position) {
    _cameraPosition = position;
    _cameraIsMoving = true;
    _markerProjectionGate.request();
    _cameraProjectionFrameGate.enqueue(
      position,
      (callback) {
        WidgetsBinding.instance.addPostFrameCallback((_) => callback());
        WidgetsBinding.instance.scheduleFrame();
      },
      (latest) {
        if (!mounted) return;
        if (!_translateMarkerOverlayForCamera(latest) &&
            !_projectMarkersSynchronously(latest)) {
          _queueMarkerRefresh();
        }
      },
    );
  }

  void _scheduleCameraBoundsCorrection(CameraPosition position) {
    if (_cameraBoundsCorrectionPending) return;
    final target = MapLibreMapConfig.clampCameraTargetForViewport(
      position.target,
      zoom: position.zoom,
      viewportSize: _mapViewportSize ?? Size.zero,
      padding: _overviewPadding,
    );
    if (target == position.target) return;
    final controller = _mapController;
    if (controller == null) return;
    _cameraBoundsCorrectionPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_cameraIsMoving) {
        _cameraBoundsCorrectionPending = false;
        return;
      }
      final current = _cameraPosition;
      if (current == null) {
        _cameraBoundsCorrectionPending = false;
        return;
      }
      final corrected = MapLibreMapConfig.clampCameraTargetForViewport(
        current.target,
        zoom: current.zoom,
        viewportSize: _mapViewportSize ?? Size.zero,
        padding: _overviewPadding,
      );
      if (corrected == current.target) {
        _cameraBoundsCorrectionPending = false;
        return;
      }
      unawaited(_moveCameraToCorrectedTarget(controller, corrected));
    });
  }

  Future<void> _moveCameraToCorrectedTarget(
    MapLibreMapController controller,
    LatLng target,
  ) async {
    try {
      await controller.moveCamera(CameraUpdate.newLatLng(target));
    } finally {
      _cameraBoundsCorrectionPending = false;
    }
  }

  Future<void> _prepareNativeCameraBoundsForZoom(double zoom) async {
    _cameraBoundsZoomOverride = zoom;
    if (!mounted) return;
    setState(() {});
    await WidgetsBinding.instance.endOfFrame;
  }

  double get _overviewReferenceZoom {
    final viewportSize = _mapViewportSize;
    if (viewportSize == null || viewportSize.isEmpty) {
      return MapLibreMapConfig.overviewZoom;
    }
    return MapLibreMapConfig.taiwanOverviewCameraForViewport(
      viewportSize,
      padding: _overviewPadding,
    ).zoom;
  }

  void _queueMarkerRefresh() {
    final request = _markerProjectionGate.request();
    if (_markerRefreshScheduled || _markerProjectionInFlight) return;
    _markerRefreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _markerRefreshScheduled = false;
      if (mounted) unawaited(_refreshMarkerPositions(request));
    });
  }

  List<MapMarkerData> _markers({double? zoom}) {
    if (_usesPlatformMap &&
        (!_styleLoaded || _mapController == null || _mapViewportSize == null)) {
      return const <MapMarkerData>[];
    }
    final currentZoom = zoom ?? _cameraPosition?.zoom;
    final baseMarkers = _markerLayoutCache.getOrBuild(() {
      final zoomPercentage =
          currentZoom == null
              ? null
              : ZoomPercentage.fromZoom(
                zoom: currentZoom,
                minZoom: MapCanvas.minZoom,
                maxZoom: MapCanvas.maxZoom,
                overviewZoom: _overviewReferenceZoom,
              );
      final revealAllAtZoom =
          currentZoom == null
              ? null
              : ZoomPercentage.toZoom(
                percentage: MapLibreMapConfig.revealAllPercentage,
                minZoom: MapCanvas.minZoom,
                maxZoom: MapCanvas.maxZoom,
                overviewZoom: _overviewReferenceZoom,
              );
      final focusDataMarkerOnTap =
          zoomPercentage != null &&
          zoomPercentage >= MapLibreMapConfig.revealAllPercentage &&
          zoomPercentage < MapLibreMapConfig.fullMarkerPercentage;
      final cacheOverviewLayout =
          currentZoom != null &&
          zoomPercentage != null &&
          widget.administrativeIndex != null &&
          zoomPercentage < MapLibreMapConfig.revealAllPercentage;
      if (cacheOverviewLayout) {
        final cached = _overviewMarkerLayouts.get(currentZoom);
        if (cached != null) return cached;
      }
      void selectStaticFeature(List<StaticFeature> features) {
        if (focusDataMarkerOnTap && features.isNotEmpty) {
          final geometry = features.first.geometry;
          if (geometry is PointGeometry) _focusDataMarker(geometry.point);
        }
        widget.onStaticFeatureSelected(features);
      }

      void selectEvent(MeshEvent event) {
        if (focusDataMarkerOnTap) {
          final point = meshEventFocusPoint(event);
          if (point != null) _focusDataMarker(point);
        }
        widget.onEventSelected(event);
      }

      final layout = MapLayers.buildMarkers(
        features: _featuresForMarkerLayout(currentZoom, revealAllAtZoom),
        events: widget.visibleEvents,
        showShelters: widget.showShelters,
        showMedical: widget.showMedical,
        showEvents: widget.showEvents,
        onStaticFeatureSelected: selectStaticFeature,
        onEventSelected: selectEvent,
        onClusterSelected: _focusCluster,
        administrativeIndex: widget.administrativeIndex,
        revealAllAtZoom: revealAllAtZoom,
        currentLocation: null,
        zoom: currentZoom,
        zoomPercentage: zoomPercentage,
      );
      if (cacheOverviewLayout) {
        _overviewMarkerLayouts.put(currentZoom, layout);
      }
      return layout;
    });
    final location = widget.runtimeState.currentLocation;
    if (location == null) return baseMarkers;
    if (!identical(_locationBaseMarkers, baseMarkers) ||
        _lastMarkerLocation != location) {
      _locationBaseMarkers = baseMarkers;
      _lastMarkerLocation = location;
      _markersWithLocation = [
        ...baseMarkers,
        MapLayers.currentLocationMarker(location),
      ];
    }
    return _markersWithLocation!;
  }

  List<StaticFeature> _featuresForMarkerLayout(
    double? zoom,
    double? revealAllAtZoom,
  ) {
    final viewport = _mapViewportSize;
    final camera = _cameraPosition;
    if (zoom == null ||
        revealAllAtZoom == null ||
        zoom < revealAllAtZoom ||
        viewport == null ||
        camera == null) {
      return widget.staticFeatures;
    }

    final bounds = MapCameraProjection.viewportBounds(
      cameraTarget: _geoPointFromCamera(camera),
      zoom: zoom,
      viewportSize: viewport,
      paddingPixels: 128,
    );
    return widget.staticFeatures
        .where((feature) {
          final geometry = feature.geometry;
          if (geometry is! PointGeometry) return true;
          return bounds.contains(geometry.point);
        })
        .toList(growable: false);
  }

  void _focusDataMarker(GeoPoint point) {
    final controller = _mapController;
    if (controller == null) return;
    _zoomRequestTimer?.cancel();
    _zoomRequestTimer = null;
    _zoomRequestGate.request();
    final currentZoom = _cameraPosition?.zoom ?? _overviewReferenceZoom;
    final targetZoom = ZoomPercentage.toZoom(
      percentage: MapLibreMapConfig.fullMarkerPercentage,
      minZoom: MapCanvas.minZoom,
      maxZoom: MapCanvas.maxZoom,
      overviewZoom: _overviewReferenceZoom,
    );
    if (targetZoom <= currentZoom + 1e-6) return;
    unawaited(_animateToCluster(controller, point, targetZoom));
  }

  void _focusCluster(GeoPoint point, {double? targetZoom}) {
    final controller = _mapController;
    if (controller == null) return;
    _zoomRequestTimer?.cancel();
    _zoomRequestTimer = null;
    _zoomRequestGate.request();
    final currentZoom = _cameraPosition?.zoom ?? _overviewReferenceZoom;
    final nextZoom =
        (targetZoom ?? _fallbackClusterZoom(currentZoom))
            .clamp(MapCanvas.minZoom, MapCanvas.maxZoom)
            .toDouble();
    if (nextZoom <= currentZoom + 1e-6) return;
    unawaited(_animateToCluster(controller, point, nextZoom));
  }

  Future<void> _animateToCluster(
    MapLibreMapController controller,
    GeoPoint point,
    double zoom,
  ) async {
    await _prepareNativeCameraBoundsForZoom(zoom);
    if (!mounted) return;
    await controller.animateCamera(
      CameraUpdate.newLatLngZoom(_latLng(point), zoom),
      duration: _focusAnimationDuration,
    );
  }

  double _fallbackClusterZoom(double currentZoom) {
    if (currentZoom < 8.5) return 10.2;
    if (currentZoom < 11.5) return 11.6;
    return currentZoom + 2;
  }

  bool _projectMarkersSynchronously(CameraPosition position) {
    if (_usesPlatformMap && (!_styleLoaded || _mapController == null)) {
      return false;
    }
    final viewportSize = _mapViewportSize;
    if (viewportSize == null || viewportSize.isEmpty) return false;

    final markers = _markers(zoom: position.zoom);
    final next = _projectMarkerPositions(
      markers: markers,
      position: position,
      viewportSize: viewportSize,
    );
    if (!mounted) return true;

    _markerOverlay.replace(markers: markers, positions: next);
    _markerLayoutCamera = position;
    if (!_markerLayoutReady) {
      setState(() => _markerLayoutReady = true);
    }
    final radarPoint = _radarEventPoint;
    if (radarPoint != null) {
      _radarScreenPosition.value = MapCameraProjection.projectPoint(
        point: radarPoint,
        cameraTarget: _geoPointFromCamera(position),
        zoom: position.zoom,
        viewportSize: viewportSize,
      );
    }
    return true;
  }

  bool _translateMarkerOverlayForCamera(CameraPosition position) {
    final viewportSize = _mapViewportSize;
    final layoutCamera = _markerLayoutCamera;
    if (viewportSize == null || layoutCamera == null) return false;
    if ((position.zoom - layoutCamera.zoom).abs() > 0.0001) return false;
    _markerOverlay.translate(
      MapCameraProjection.panTranslation(
        fromCameraTarget: _geoPointFromCamera(layoutCamera),
        toCameraTarget: _geoPointFromCamera(position),
        zoom: position.zoom,
      ),
    );
    return true;
  }

  Map<Key, Offset> _projectMarkerPositions({
    required List<MapMarkerData> markers,
    required CameraPosition position,
    required Size viewportSize,
  }) {
    final points = MapCameraProjection.projectPoints(
      points: markers.map((marker) => marker.point).toList(growable: false),
      cameraTarget: _geoPointFromCamera(position),
      zoom: position.zoom,
      viewportSize: viewportSize,
    );
    final next = <Key, Offset>{};
    for (
      var index = 0;
      index < markers.length && index < points.length;
      index++
    ) {
      next[markers[index].key] = points[index];
    }
    return next;
  }

  void _updateMapViewportSize(Size size) {
    if (!mounted || size.isEmpty || _mapViewportSize == size) return;
    final currentCamera = _cameraPosition;
    _mapViewportSize = size;
    _overviewMarkerLayouts.clear();
    _markerLayoutCache.invalidate();
    if (currentCamera == null || !_projectMarkersSynchronously(currentCamera)) {
      _queueMarkerRefresh();
    }
  }

  static GeoPoint _geoPointFromCamera(CameraPosition position) => GeoPoint(
    longitude: position.target.longitude,
    latitude: position.target.latitude,
  );

  Future<void> _refreshMarkerPositions(int request) async {
    if (_markerProjectionInFlight) return;
    _markerProjectionInFlight = true;
    final controller = _mapController;
    try {
      if (controller == null) return;
      if (_usesPlatformMap && !_styleLoaded) return;
      final markers = _markers(zoom: _cameraPosition?.zoom);
      if (markers.isEmpty) {
        if (_markerProjectionGate.isCurrent(request) && mounted) {
          _markerOverlay.replace(
            markers: markers,
            positions: const <Key, Offset>{},
          );
          _markerLayoutCamera = _cameraPosition;
          setState(() => _markerLayoutReady = true);
        }
        return;
      }
      // Paint the current layout immediately using the shared camera model.
      // Native projection below can correct platform rounding after the map
      // settles, but a slow platform response must not leave bubbles blank.
      if (_markerProjectionGate.isCurrent(request) && _cameraPosition != null) {
        _projectMarkersSynchronously(_cameraPosition!);
      }
      if (kIsWeb) return;
      final points = await controller.toScreenLocationBatch(
        markers.map((marker) => _latLng(marker.point)),
      );
      if (!mounted || !_markerProjectionGate.isCurrent(request)) return;
      final next = <Key, Offset>{};
      for (
        var index = 0;
        index < markers.length && index < points.length;
        index++
      ) {
        final point = points[index];
        next[markers[index].key] = _nativeScreenPosition(
          Offset(point.x.toDouble(), point.y.toDouble()),
        );
      }
      _markerOverlay.replace(markers: markers, positions: next);
      _markerLayoutCamera = _cameraPosition;
      setState(() => _markerLayoutReady = true);
      final radarPoint = _radarEventPoint;
      if (radarPoint != null) {
        await _updateRadarScreenPosition(radarPoint, request: request);
      }
    } on Object {
      // The native view can be between style/camera lifecycles. The next map
      // idle callback will retry without interrupting the rest of the UI.
    } finally {
      _markerProjectionInFlight = false;
      if (mounted && !_markerProjectionGate.isCurrent(request)) {
        _queueMarkerRefresh();
      }
    }
  }

  Future<void> _onStyleLoaded() async {
    _styleLoaded = true;
    _markerLayoutReady = false;
    _tilesLoading.value = true;
    _markerLayoutCache.invalidate();
    await _ensureEventLayers();
    await _ensureRouteLayer();
    _queueMarkerRefresh();
    if (_pendingEventFocus != null) {
      await _focusPendingEvent();
      return;
    }
    final focus = widget.focusPoint ?? widget.searchSelection?.coordinate;
    if (focus != null) {
      _lastFocusRequestId = widget.focusRequestId;
      _scheduleLatestFocus(focus, widget.focusRequestId);
    }
  }

  Future<void> _ensureEventLayers() async {
    final controller = _mapController;
    if (!MapLibreOverlayData.showEventAreaOverlay ||
        controller == null ||
        !_styleLoaded) {
      return;
    }
    try {
      if (!_eventSourceReady) {
        await controller.addGeoJsonSource(
          _eventsSourceId,
          MapLibreOverlayData.eventFeatureCollection(
            widget.showEvents ? widget.visibleEvents : const <MeshEvent>[],
          ),
        );
        await controller.addFillLayer(
          _eventsSourceId,
          _eventsFillLayerId,
          const FillLayerProperties(
            fillColor: ['get', 'color'],
            fillOpacity: ['get', 'opacity'],
            fillOutlineColor: ['get', 'color'],
          ),
          enableInteraction: false,
        );
        await controller.addLineLayer(
          _eventsSourceId,
          _eventsLineLayerId,
          const LineLayerProperties(
            lineColor: ['get', 'color'],
            lineOpacity: 0.95,
            lineWidth: ['get', 'line_width'],
          ),
          enableInteraction: false,
        );
        _eventSourceReady = true;
      } else {
        await _updateEventSource();
      }
    } on Object {
      // Keep the map usable if an older native MapLibre build cannot add a
      // runtime layer. The Flutter marker overlay still remains available.
    }
  }

  Future<void> _updateEventSource() async {
    if (!MapLibreOverlayData.showEventAreaOverlay ||
        !_eventSourceReady ||
        _mapController == null) {
      return;
    }
    try {
      await _mapController!.setGeoJsonSource(
        _eventsSourceId,
        MapLibreOverlayData.eventFeatureCollection(
          widget.showEvents ? widget.visibleEvents : const <MeshEvent>[],
        ),
      );
    } on Object {
      // A style replacement invalidates the old source; style callback will
      // rebuild it.
    }
  }

  Future<void> _ensureRouteLayer() async {
    final controller = _mapController;
    if (controller == null || !_styleLoaded) return;
    try {
      if (!_routeSourceReady) {
        await controller.addGeoJsonSource(
          _routeSourceId,
          routeFeatureCollection(widget.route),
        );
        _routeSourceReady = true;
      }
      if (!_routeLayerReady) {
        await controller.addLineLayer(
          _routeSourceId,
          _routeLineLayerId,
          const LineLayerProperties(
            lineColor: '#2563EB',
            lineOpacity: 0.95,
            lineWidth: 6,
          ),
          enableInteraction: false,
        );
        _routeLayerReady = true;
      }
      await controller.setGeoJsonSource(
        _routeSourceId,
        routeFeatureCollection(widget.route),
      );
    } on Object {
      // A route layer is an enhancement. Native layer incompatibility must not
      // hide the map or the Flutter route summary.
    }
  }

  Future<void> _onMapClick(math.Point<double> point, LatLng coordinates) async {
    if (widget.onReportCameraIdle != null) return;
    final coordinatePicker = widget.onCoordinatePicked;
    if (coordinatePicker != null) {
      coordinatePicker(
        GeoPoint(
          longitude: coordinates.longitude,
          latitude: coordinates.latitude,
        ),
      );
      return;
    }
    final overlay = _markerOverlay.value;
    final markers =
        _usesPlatformMap
            ? overlay.markers
            : _markers(zoom: _cameraPosition?.zoom);
    final markerHits = hitTestMapMarkers(
      markers: markers,
      positions: overlay.positions,
      point: _nativeScreenPosition(Offset(point.x, point.y)),
      translation: overlay.translation,
    );
    if (markerHits.isNotEmpty) {
      markerHits.last.onTap();
      return;
    }

    final controller = _mapController;
    if (MapLibreOverlayData.showEventAreaOverlay &&
        controller != null &&
        _eventSourceReady &&
        widget.showEvents) {
      try {
        final rendered = await controller.queryRenderedFeatures(point, <String>[
          _eventsLineLayerId,
          _eventsFillLayerId,
        ], null);
        for (final feature in rendered) {
          if (feature is! Map) continue;
          final properties = feature['properties'];
          final id = properties is Map ? properties['event_id'] : null;
          if (id is! String) continue;
          final event = widget.visibleEvents.firstWhere(
            (candidate) => meshEventIdentity(candidate) == id,
            orElse:
                () => const MeshEvent(
                  namespace: null,
                  eventId: null,
                  eventVersion: null,
                  eventType: null,
                  severity: null,
                  source: null,
                  issuedAt: null,
                  expiresAt: null,
                  applyState: null,
                  geometry: null,
                  attributes: null,
                ),
          );
          if (event.eventId != null) {
            widget.onEventSelected(event);
            return;
          }
        }
      } on Object {
        // A map tap remains a valid interaction on platforms without
        // rendered-feature query support.
      }
    }

    widget.onMapTap();
  }

  Future<bool> _updateRadarScreenPosition(
    GeoPoint point, {
    int? request,
  }) async {
    final controller = _mapController;
    if (controller == null || !_styleLoaded) return false;
    try {
      final screen = await controller.toScreenLocation(_latLng(point));
      if (request != null && !_markerProjectionGate.isCurrent(request)) {
        return false;
      }
      _radarScreenPosition.value = _nativeScreenPosition(
        Offset(screen.x.toDouble(), screen.y.toDouble()),
      );
      return true;
    } on Object {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportSize = constraints.biggest;
        if (!viewportSize.isEmpty && viewportSize != _mapViewportSize) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _updateMapViewportSize(viewportSize);
          });
        }
        final baseMap =
            !_usesPlatformMap
                ? _buildPreviewSurface()
                : _styleError != null
                ? _buildErrorSurface()
                : _styleJson == null
                ? _buildLoadingSurface()
                : _buildMapLibreMap(viewportSize);
        final markers = _markers(zoom: _cameraPosition?.zoom);
        return Stack(
          fit: StackFit.expand,
          children: <Widget>[
            baseMap,
            if (_usesPlatformMap && _styleJson != null && _styleError == null)
              ValueListenableBuilder<bool>(
                valueListenable: _tilesLoading,
                builder: (context, tilesLoading, _) {
                  if (!tilesLoading && _markerLayoutReady) {
                    return const SizedBox.shrink();
                  }
                  return Positioned.fill(
                    child: IgnorePointer(
                      child: ColoredBox(
                        color: const Color.fromRGBO(248, 252, 255, 0.72),
                        child: Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              const CircularProgressIndicator(),
                              const SizedBox(height: 12),
                              Text(tilesLoading ? '正在載入地圖圖磚…' : '正在準備地圖標記…'),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            if (_usesPlatformMap && _animationsAllowed && _radarVisible)
              Positioned.fill(
                child: ValueListenableBuilder<Offset?>(
                  valueListenable: _radarScreenPosition,
                  builder: (context, center, _) {
                    if (center == null) return const SizedBox.shrink();
                    return AnimatedBuilder(
                      animation: _pulseController,
                      builder:
                          (context, _) => IgnorePointer(
                            child: CustomPaint(
                              painter: _RadarPulsePainter(
                                _pulseController.value,
                                center,
                                _radarColor ?? const Color(0xFFF97316),
                              ),
                            ),
                          ),
                    );
                  },
                ),
              ),
            if (_usesPlatformMap)
              ClipRect(
                child: ValueListenableBuilder<
                  MapMarkerOverlayFrame<MapMarkerData>
                >(
                  valueListenable: _markerOverlay,
                  builder:
                      (context, frame, child) => Transform.translate(
                        offset: frame.translation,
                        child: child,
                      ),
                  child: RepaintBoundary(
                    child: ValueListenableBuilder<
                      MapMarkerOverlayFrame<MapMarkerData>
                    >(
                      valueListenable: _markerOverlay.layout,
                      builder:
                          (context, layout, _) => Stack(
                            fit: StackFit.expand,
                            // Keep offscreen county bubbles available while
                            // panning; the parent clips after translation.
                            clipBehavior: Clip.none,
                            children: layout.markers
                                .map(
                                  (marker) => _buildPositionedMarker(
                                    marker,
                                    layout.positions,
                                  ),
                                )
                                .toList(growable: false),
                          ),
                    ),
                  ),
                ),
              ),
            if (_usesPlatformMap &&
                widget.staticFeatures.isNotEmpty &&
                (widget.showShelters || widget.showMedical))
              ValueListenableBuilder<MapMarkerOverlayFrame<MapMarkerData>>(
                valueListenable: _markerOverlay,
                builder: (context, frame, _) {
                  final percentage = widget.runtimeState.zoomPercentage;
                  if (!_markerLayoutReady ||
                      percentage <= 25 ||
                      percentage >= MapLibreMapConfig.revealAllPercentage ||
                      _hasVisibleFacilityMarker(frame, viewportSize)) {
                    return const SizedBox.shrink();
                  }
                  return Positioned(
                    left: 12,
                    bottom: 190,
                    child: PointerInterceptor(
                      child: Material(
                        color: Theme.of(context).colorScheme.surface,
                        elevation: 3,
                        borderRadius: BorderRadius.circular(16),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 200),
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                const Text('目前畫面沒有院所／避難所標記'),
                                const SizedBox(height: 4),
                                Text(
                                  '返回全臺後，點選數字圓點可快速探索縣市。',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                TextButton.icon(
                                  onPressed: () => unawaited(_recenter()),
                                  icon: const Icon(Icons.public, size: 18),
                                  label: const Text('返回全臺'),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            if (!_usesPlatformMap) ..._buildPreviewMarkers(markers),
            if (widget.showReportLocationPicker)
              const Positioned.fill(
                child: IgnorePointer(
                  child: Center(
                    child: Padding(
                      key: ValueKey<String>('report-location-center-pin'),
                      padding: EdgeInsets.only(bottom: 34),
                      child: Icon(
                        Icons.location_pin,
                        size: 48,
                        color: Color(0xFF00796B),
                      ),
                    ),
                  ),
                ),
              ),
            Positioned(
              right: 12,
              bottom: 12,
              child: SafeArea(
                child: PointerInterceptor(
                  child: MapZoomControls(
                    zoomPercentage: widget.runtimeState.zoomPercentage,
                    onZoomPercentageChanged: _setZoomPercentage,
                    onOpenLayerSettings: widget.onOpenLayerSettings,
                    onRequestLocation: widget.onRequestLocation,
                    onRecenter: _recenter,
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Offset _nativeScreenPosition(Offset position) =>
      MapCameraProjection.fromNativeScreenPosition(
        position,
        physicalPixels:
            !kIsWeb && defaultTargetPlatform == TargetPlatform.android,
        devicePixelRatio: MediaQuery.devicePixelRatioOf(context),
      );

  bool _hasVisibleFacilityMarker(
    MapMarkerOverlayFrame<MapMarkerData> frame,
    Size viewportSize,
  ) {
    // The search and status controls cover the top of the map. A bubble
    // behind them cannot help someone exploring the current area.
    final usableMap = Rect.fromLTRB(
      12,
      260,
      viewportSize.width - 12,
      viewportSize.height - 120,
    );
    for (final marker in frame.markers) {
      if (marker.shelterCount == 0 && marker.medicalCount == 0) continue;
      final position = frame.positions[marker.key];
      if (position != null &&
          usableMap.contains(position + frame.translation)) {
        return true;
      }
    }
    return false;
  }

  Widget _buildPositionedMarker(
    MapMarkerData marker,
    Map<Key, Offset> positions,
  ) {
    final screen = positions[marker.key];
    if (screen == null) return const SizedBox.shrink();
    return Positioned(
      key: marker.key,
      left: screen.dx - (marker.width / 2),
      top: screen.dy - (marker.height / 2),
      width: marker.width,
      height: marker.height,
      // Let the platform map receive taps and multi-touch gestures. Its
      // _onMapClick handler hit-tests this overlay to preserve marker taps;
      // allowing each Flutter marker to claim pointers can block pinch zoom.
      child: IgnorePointer(child: marker.child),
    );
  }

  /// Desktop Flutter does not host the MapLibre platform view. Keep the
  /// provider-neutral marker widgets available there for UI development and
  /// accessibility tests; Android/iOS use the real screen projection above.
  Iterable<Widget> _buildPreviewMarkers(List<MapMarkerData> markers) sync* {
    for (var index = 0; index < markers.length; index += 1) {
      final marker = markers[index];
      final column = index % 6;
      final row = index ~/ 6;
      yield Positioned(
        key: marker.key,
        left: 16 + (column * 44),
        top: 300 + (row * 44),
        width: marker.width,
        height: marker.height,
        child: marker.child,
      );
    }
  }

  Widget _buildMapLibreMap(Size viewportSize) {
    final initial = MapLibreMapConfig.initialCamera(
      currentLocation: widget.runtimeState.currentLocation,
    );
    _cameraPosition ??= CameraPosition(
      target: _latLng(initial.target),
      zoom: initial.zoom,
    );
    final bounds = MapLibreMapConfig.cameraTargetBoundsForZoom(
      _cameraBoundsZoomOverride ?? _cameraPosition?.zoom ?? initial.zoom,
      viewportSize: viewportSize,
    );
    // Marker movement only changes the Flutter overlay. Reusing this widget
    // avoids serializing the large style and diffing native options each frame.
    if (_platformMap != null &&
        _platformMapStyle == _styleJson &&
        _platformMapBounds?.southwest == bounds.southwest &&
        _platformMapBounds?.northeast == bounds.northeast) {
      return _platformMap!;
    }
    _platformMapStyle = _styleJson;
    _platformMapBounds = bounds;
    return _platformMap = MapLibreMap(
      key: const ValueKey<String>('maplibre-platform-view'),
      styleString: _styleJson!,
      initialCameraPosition: CameraPosition(
        target: _latLng(initial.target),
        zoom: initial.zoom,
      ),
      cameraTargetBounds: CameraTargetBounds(bounds),
      minMaxZoomPreference: const MinMaxZoomPreference(
        MapLibreMapConfig.minZoom,
        MapLibreMapConfig.maxZoom,
      ),
      compassEnabled: false,
      logoEnabled: false,
      attributionButtonPosition: AttributionButtonPosition.bottomLeft,
      rotateGesturesEnabled: false,
      dragEnabled: true,
      scrollGesturesEnabled: true,
      zoomGesturesEnabled: true,
      doubleClickZoomEnabled: true,
      tiltGesturesEnabled: false,
      // Flutter markers are hit-tested from the map click callback. Native
      // basemap features may sit underneath them, so their taps must also
      // reach that callback.
      featureTapsTriggersMapClick: true,
      trackCameraPosition: true,
      onMapCreated: (controller) {
        _mapController = controller;
        _queueMarkerRefresh();
      },
      onStyleLoadedCallback: () => unawaited(_onStyleLoaded()),
      onCameraMove: _onCameraMove,
      onCameraIdle: _onMapSettled,
      onMapIdle: _onMapIdle,
      onMapClick: _onMapClick,
    );
  }

  Widget _buildPreviewSurface() => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onTap: () {
      final reportCameraIdle = widget.onReportCameraIdle;
      if (reportCameraIdle != null) {
        reportCameraIdle(MapCanvas.taiwanOverviewCenter);
      } else if (widget.onCoordinatePicked != null) {
        widget.onCoordinatePicked!(MapCanvas.taiwanOverviewCenter);
      } else {
        widget.onMapTap();
      }
    },
    child: ColoredBox(
      color:
          Theme.of(context).brightness == Brightness.dark
              ? const Color(0xFF171B20)
              : const Color(0xFFF2F0EC),
      child: const Center(child: Text('MapLibre 台灣離線地圖預覽')),
    ),
  );

  Widget _buildLoadingSurface() => const ColoredBox(
    color: Color(0xFFF2F0EC),
    child: Center(child: CircularProgressIndicator()),
  );

  Widget _buildErrorSurface() => ColoredBox(
    color:
        Theme.of(context).brightness == Brightness.dark
            ? const Color(0xFF171B20)
            : const Color(0xFFF2F0EC),
    child: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              '台灣 OSM 離線地圖樣式無法載入。\n${_styleError ?? '請重試。'}',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => unawaited(_loadStyle()),
              icon: const Icon(Icons.refresh),
              label: const Text('重試'),
            ),
          ],
        ),
      ),
    ),
  );

  static LatLng _latLng(GeoPoint point) =>
      LatLng(point.latitude, point.longitude);
}

bool _sameEventSnapshot(List<MeshEvent> left, List<MeshEvent> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    final first = left[index];
    final second = right[index];
    if (eventKey(first) != eventKey(second) ||
        first.issuedAt != second.issuedAt ||
        first.expiresAt != second.expiresAt ||
        first.severity != second.severity ||
        first.applyState != second.applyState ||
        first.verification != second.verification ||
        first.attributes?['map_visible'] != second.attributes?['map_visible'] ||
        meshEventFocusPoint(first) != meshEventFocusPoint(second)) {
      return false;
    }
  }
  return true;
}

class _RadarPulsePainter extends CustomPainter {
  const _RadarPulsePainter(this.progress, this.center, this.color);

  final double progress;
  final Offset center;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    for (var index = 0; index < 3; index += 1) {
      final phase = (progress + (index / 3)) % 1;
      final opacity = (1 - phase) * 0.72;
      canvas.drawCircle(
        center,
        18 + (phase * 90),
        Paint()
          ..color = color.withValues(alpha: opacity)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3 - (phase * 1.5),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RadarPulsePainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.center != center ||
      oldDelegate.color != color;
}
