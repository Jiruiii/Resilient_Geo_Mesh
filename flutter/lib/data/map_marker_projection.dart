import 'package:flutter/material.dart';

/// Coalesces camera projection work so a burst of native camera callbacks is
/// applied at most once per Flutter frame, using the latest camera position.
class MapMarkerOverlayFrame<T> {
  MapMarkerOverlayFrame({
    required List<T> markers,
    required Map<Key, Offset> positions,
    this.translation = Offset.zero,
  }) : markers = List<T>.unmodifiable(markers),
       positions = Map<Key, Offset>.unmodifiable(positions);

  MapMarkerOverlayFrame._({
    required this.markers,
    required this.positions,
    required this.translation,
  });

  final List<T> markers;
  final Map<Key, Offset> positions;
  final Offset translation;
}

/// Publishes marker data and projected positions together so the platform-map
/// overlay can track camera changes without rebuilding the MapCanvas host.
class MapMarkerOverlayNotifier<T>
    extends ValueNotifier<MapMarkerOverlayFrame<T>> {
  MapMarkerOverlayNotifier()
    : super(
        MapMarkerOverlayFrame<T>(
          markers: const <Never>[],
          positions: const <Key, Offset>{},
        ),
      ) {
    layout = ValueNotifier<MapMarkerOverlayFrame<T>>(value);
  }

  late final ValueNotifier<MapMarkerOverlayFrame<T>> layout;

  List<T>? _markerSource;
  List<T> _markerSnapshot = List<T>.empty(growable: false);

  void replace({
    required List<T> markers,
    required Map<Key, Offset> positions,
  }) {
    if (!identical(markers, _markerSource)) {
      _markerSource = markers;
      _markerSnapshot = List<T>.unmodifiable(markers);
    }
    final frame = MapMarkerOverlayFrame<T>(
      markers: _markerSnapshot,
      positions: positions,
      translation: Offset.zero,
    );
    layout.value = frame;
    value = frame;
  }

  void translate(Offset translation) {
    if (value.translation == translation) return;
    value = MapMarkerOverlayFrame<T>._(
      markers: value.markers,
      positions: value.positions,
      translation: translation,
    );
  }

  @override
  void dispose() {
    layout.dispose();
    super.dispose();
  }
}

class MapCameraProjectionFrameGate<T> {
  T? _pending;
  bool _frameScheduled = false;

  void enqueue(
    T value,
    void Function(void Function()) scheduleFrame,
    void Function(T) apply,
  ) {
    _pending = value;
    if (_frameScheduled) return;
    _frameScheduled = true;
    scheduleFrame(() {
      _frameScheduled = false;
      final latest = _pending;
      _pending = null;
      if (latest != null) apply(latest);
    });
  }
}

/// Caches the expensive marker layout separately from its screen projection.
///
/// Panning changes marker positions but not the data grouping/layout. Callers
/// invalidate this cache when data, filters, or a settled zoom level changes.
class MapMarkerLayoutCache<T> {
  T? _value;
  bool _hasValue = false;
  bool _dirty = true;

  T getOrBuild(T Function() builder) {
    if (_hasValue && !_dirty) return _value!;
    final value = builder();
    _value = value;
    _hasValue = true;
    _dirty = false;
    return value;
  }

  void invalidate() {
    _dirty = true;
  }

  void clear() {
    _value = null;
    _hasValue = false;
    _dirty = true;
  }
}

/// Retains a small number of scale-specific overview layouts.
///
/// Bubble collision groups depend on the camera zoom even when the
/// administrative level is unchanged. Keying only by a broad zoom band can
/// reuse a layout whose bubbles overlap at a farther scale. A small LRU keeps
/// recent zoom stops reusable without growing as pinch zoom produces arbitrary
/// floating-point values.
class MapMarkerZoomLayoutCache<T> {
  MapMarkerZoomLayoutCache({this.maximumEntries = 8})
    : assert(maximumEntries > 0);

  final int maximumEntries;
  final Map<int, T> _values = <int, T>{};

  static int _keyFor(double zoom) => (zoom * 100).round();

  T? get(double zoom) {
    final key = _keyFor(zoom);
    if (!_values.containsKey(key)) return null;
    final value = _values.remove(key) as T;
    _values[key] = value;
    return value;
  }

  void put(double zoom, T value) {
    final key = _keyFor(zoom);
    _values.remove(key);
    _values[key] = value;
    while (_values.length > maximumEntries) {
      _values.remove(_values.keys.first);
    }
  }

  T getOrBuild(double zoom, T Function() builder) {
    final cached = get(zoom);
    if (cached != null) return cached;
    final value = builder();
    put(zoom, value);
    return value;
  }

  void clear() => _values.clear();
}

/// Guards asynchronous screen-coordinate conversions made through the
/// MapLibre platform channel. A camera move can finish after a newer move;
/// stale results must never overwrite the latest marker positions.
class MapMarkerProjectionGate {
  int _latestRequest = 0;

  int request() => ++_latestRequest;

  bool isCurrent(int request) => request == _latestRequest;
}
