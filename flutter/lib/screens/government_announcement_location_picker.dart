import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/map_models.dart';
import '../data/map_runtime_state.dart';
import '../data/map_search.dart';
import '../data/map_search_asset.dart';
import '../data/offline_search_worker.dart';
import '../widgets/map_canvas.dart';

typedef GovernmentPlaceSearch =
    Future<List<MapSearchResult>> Function(String query);

class GovernmentAnnouncementLocationSelection {
  const GovernmentAnnouncementLocationSelection(this.point);

  final GeoPoint? point;
}

class GovernmentAnnouncementLocationPicker extends StatefulWidget {
  const GovernmentAnnouncementLocationPicker({
    super.key,
    this.initialLocation,
    this.searchPlaces,
  });

  final GeoPoint? initialLocation;
  final GovernmentPlaceSearch? searchPlaces;

  @override
  State<GovernmentAnnouncementLocationPicker> createState() =>
      _GovernmentAnnouncementLocationPickerState();
}

class _GovernmentAnnouncementLocationPickerState
    extends State<GovernmentAnnouncementLocationPicker> {
  final TextEditingController _searchController = TextEditingController();
  final FocusNode _searchFocus = FocusNode();
  OfflineSearchWorker? _searchWorker;
  MapSearchIndex? _searchIndex;
  Timer? _searchDebounce;
  List<MapSearchResult> _results = const <MapSearchResult>[];
  GeoPoint? _focusPoint;
  late GeoPoint _selectedPoint;
  int _focusRequestId = 0;
  int _searchGeneration = 0;
  bool _searchLoading = false;
  bool _resultsLoading = false;
  String? _searchError;

  @override
  void initState() {
    super.initState();
    _selectedPoint = widget.initialLocation ?? MapCanvas.taiwanOverviewCenter;
    _searchLoading = widget.searchPlaces == null;
    if (widget.searchPlaces == null) unawaited(_loadSearchIndex());
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchWorker?.close();
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  Future<void> _loadSearchIndex() async {
    try {
      final raw = await rootBundle.loadString(
        'assets/map/search/taiwan-roads.json',
      );
      if (!kIsWeb) {
        _searchWorker = await OfflineSearchWorker.start(raw);
      } else {
        final decoded = jsonDecode(raw);
        if (decoded is! Map) {
          throw const FormatException('Taiwan search index is invalid');
        }
        final asset = TaiwanSearchAsset.fromJson(
          Map<String, dynamic>.from(decoded),
        );
        _searchIndex = MapSearchIndex(
          const <StaticFeature>[],
          roadEntries: asset.entries,
        )..prepare();
      }
      if (mounted) {
        setState(() => _searchLoading = false);
        if (_searchController.text.trim().isNotEmpty) {
          _onSearchChanged(_searchController.text);
        }
      }
    } on Object {
      if (mounted) {
        setState(() {
          _searchLoading = false;
          _searchError = '地名索引暫時無法載入，仍可直接移動地圖選點。';
        });
      }
    }
  }

  void _onSearchChanged(String value) {
    final query = value.trim();
    final generation = ++_searchGeneration;
    _searchDebounce?.cancel();
    if (query.isEmpty) {
      setState(() {
        _results = const <MapSearchResult>[];
        _resultsLoading = false;
      });
      return;
    }
    if (_searchLoading) {
      setState(() {
        _results = const <MapSearchResult>[];
        _resultsLoading = false;
      });
      return;
    }
    setState(() => _resultsLoading = true);
    _searchDebounce = Timer(const Duration(milliseconds: 220), () {
      unawaited(_search(query, generation));
    });
  }

  Future<void> _search(String query, int generation) async {
    try {
      final injected = widget.searchPlaces;
      final results =
          injected != null
              ? await injected(query)
              : _searchWorker != null
              ? (await _searchWorker!.search(query)).results
              : _searchIndex?.query(query) ?? const <MapSearchResult>[];
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _results = results
            .where((result) => result.coordinate != null)
            .toList(growable: false);
        _resultsLoading = false;
      });
    } on Object {
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _results = const <MapSearchResult>[];
        _resultsLoading = false;
        _searchError = '搜尋暫時無法使用，仍可直接移動地圖選點。';
      });
    }
  }

  void _selectResult(MapSearchResult result) {
    final point = result.coordinate;
    if (point == null) return;
    _searchFocus.unfocus();
    setState(() {
      _searchController.text = result.displayTitle;
      _results = const <MapSearchResult>[];
      _selectedPoint = point;
      _focusPoint = point;
      _focusRequestId++;
    });
  }

  void _onMapCameraIdle(GeoPoint point) {
    if (_selectedPoint == point) return;
    setState(() => _selectedPoint = point);
  }

  String get _coordinateLabel =>
      '${_selectedPoint.latitude.toStringAsFixed(6)}, '
      '${_selectedPoint.longitude.toStringAsFixed(6)}';

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    child: Scaffold(
      appBar: AppBar(
        title: const Text('選擇公告位置'),
        leading: IconButton(
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
          icon: const Icon(Icons.arrow_back),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          MapCanvas(
            runtimeState: MapRuntimeState(
              themeMode: ThemeMode.light,
              zoomPercentage: 70,
              currentLocation: widget.initialLocation,
              animationEnabled: false,
            ),
            staticFeatures: const <StaticFeature>[],
            visibleEvents: const <MeshEvent>[],
            showShelters: false,
            showMedical: false,
            showEvents: false,
            onStaticFeatureSelected: (_) {},
            onEventSelected: (_) {},
            onZoomPercentageChanged: (_) {},
            onOpenLayerSettings: () {},
            onRequestLocation: () {},
            onMapTap: () {},
            onReportCameraIdle: _onMapCameraIdle,
            showReportLocationPicker: true,
            focusPoint: _focusPoint,
            focusRequestId: _focusRequestId,
          ),
          SafeArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
                  child: Material(
                    elevation: 4,
                    borderRadius: BorderRadius.circular(12),
                    child: TextField(
                      key: const ValueKey('government-location-search'),
                      controller: _searchController,
                      focusNode: _searchFocus,
                      onChanged: _onSearchChanged,
                      textInputAction: TextInputAction.search,
                      decoration: InputDecoration(
                        prefixIcon: const Icon(Icons.search),
                        hintText: '搜尋地名、道路或設施',
                        suffixIcon:
                            _searchController.text.isEmpty
                                ? null
                                : IconButton(
                                  tooltip: '清除搜尋',
                                  onPressed: () {
                                    _searchController.clear();
                                    _onSearchChanged('');
                                  },
                                  icon: const Icon(Icons.clear),
                                ),
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 14,
                        ),
                      ),
                    ),
                  ),
                ),
                if (_resultsLoading ||
                    _results.isNotEmpty ||
                    _searchController.text.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Material(
                      elevation: 4,
                      borderRadius: BorderRadius.circular(12),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 250),
                        child: _buildResults(),
                      ),
                    ),
                  ),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(
                        '移動地圖，讓中心圖釘對準位置。\n'
                        '目前座標：$_coordinateLabel',
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Row(
            children: <Widget>[
              TextButton(
                onPressed:
                    () => Navigator.of(
                      context,
                    ).pop(const GovernmentAnnouncementLocationSelection(null)),
                child: const Text('清除位置'),
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed:
                    () => Navigator.of(context).pop(
                      GovernmentAnnouncementLocationSelection(_selectedPoint),
                    ),
                icon: const Icon(Icons.check),
                label: const Text('確認位置'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  Widget _buildResults() {
    if (_resultsLoading) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: LinearProgressIndicator(),
      );
    }
    final query = _searchController.text.trim();
    if (_results.isEmpty) {
      return ListTile(
        title: Text(
          _searchError ??
              (_searchLoading
                  ? '正在載入台灣地名索引…'
                  : query.isEmpty
                  ? '輸入地名搜尋，或直接移動地圖選點'
                  : '找不到符合的地名，可直接移動地圖選點'),
        ),
      );
    }
    return ListView.builder(
      shrinkWrap: true,
      itemCount: _results.length,
      itemBuilder: (context, index) {
        final result = _results[index];
        final subtitle =
            <String?>[result.typeLabel, result.region, result.address]
                .whereType<String>()
                .where((value) => value.trim().isNotEmpty)
                .toSet();
        return ListTile(
          key: ValueKey<String>(
            'government-location-result-${result.id ?? result.title}',
          ),
          leading: const Icon(Icons.place_outlined),
          title: Text(result.displayTitle),
          subtitle: subtitle.isEmpty ? null : Text(subtitle.join('・')),
          onTap: () => _selectResult(result),
        );
      },
    );
  }
}
