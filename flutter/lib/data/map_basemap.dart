import 'dart:convert';

import 'map_basemap_probe_io.dart'
    if (dart.library.js_interop) 'map_basemap_probe_web.dart'
    as probe;

/// Which base map the user prefers.
///
/// The offline OSM PMTiles package is always installed underneath; NLSC EMAP
/// is an optional online raster drawn on top of it.
enum MapBasemapMode {
  /// EMAP while the NLSC tile server answers, otherwise offline OSM.
  auto,

  /// Always draw EMAP; tiles that cannot load reveal the OSM layer below.
  emap,

  /// Offline OSM only, as before EMAP support.
  osm;

  String get label => switch (this) {
    MapBasemapMode.auto => '自動',
    MapBasemapMode.emap => '國土測繪圖資',
    MapBasemapMode.osm => '離線 OSM',
  };

  String get description => switch (this) {
    MapBasemapMode.auto => '有網路用圖資，離線用 OSM',
    MapBasemapMode.emap => '一律使用線上圖資',
    MapBasemapMode.osm => '只用內建地圖，不連網',
  };

  static MapBasemapMode fromName(String? value) => switch (value) {
    'emap' => MapBasemapMode.emap,
    'osm' => MapBasemapMode.osm,
    _ => MapBasemapMode.auto,
  };
}

typedef EmapReachabilityProbe = Future<bool> Function();

/// NLSC EMAP raster layer injected above the offline OSM style.
///
/// The layer is part of every style and only its visibility changes, so
/// switching base maps never reloads the style or rebuilds app overlays.
class MapBasemap {
  const MapBasemap._();

  static const String emapSourceId = 'nlsc-emap';
  static const String emapLayerId = 'nlsc-emap';
  static const String emapTileTemplate =
      'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}';
  static const String emapAttribution = '© 內政部國土測繪中心';

  /// A 2.4 KB open-sea tile east of Taiwan keeps the periodic probe cheap.
  static final Uri emapProbeUri = Uri.parse(
    'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/12/1791/3436',
  );
  static const Duration probeInterval = Duration(seconds: 60);

  /// Outside Taiwan NLSC answers with blank tiles; keep OSM visible there.
  static const List<double> emapBounds = <double>[118.0, 21.5, 122.2, 26.5];

  static bool emapVisible({
    required MapBasemapMode mode,
    required bool emapReachable,
  }) => switch (mode) {
    MapBasemapMode.auto => emapReachable,
    MapBasemapMode.emap => true,
    MapBasemapMode.osm => false,
  };

  /// MapLibre has no invert filter. Swapping the brightness range inverts
  /// luminance, and a 180° hue rotation restores the original hues.
  static Map<String, Object> emapPaint({required bool dark}) =>
      dark
          ? const <String, Object>{
            'raster-brightness-min': 0.86,
            'raster-brightness-max': 0.15,
            'raster-hue-rotate': 180,
            'raster-saturation': -0.3,
            'raster-contrast': -0.05,
          }
          : const <String, Object>{};

  /// Adds the EMAP source and a hidden raster layer above every OSM layer.
  static String injectEmapLayer(String styleJson, {required bool dark}) {
    final decoded = jsonDecode(styleJson);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Map style is not a JSON object');
    }
    final sources = decoded['sources'];
    final layers = decoded['layers'];
    if (sources is! Map<String, dynamic> || layers is! List) {
      throw const FormatException('Map style has no sources or layers');
    }
    sources[emapSourceId] = <String, Object>{
      'type': 'raster',
      'tiles': <String>[emapTileTemplate],
      'tileSize': 256,
      'minzoom': 0,
      'maxzoom': 19,
      'bounds': emapBounds,
      'attribution': emapAttribution,
    };
    layers.removeWhere(
      (layer) => layer is Map && layer['id'] == emapLayerId,
    );
    layers.add(<String, Object>{
      'id': emapLayerId,
      'type': 'raster',
      'source': emapSourceId,
      'layout': const <String, String>{'visibility': 'none'},
      'paint': emapPaint(dark: dark),
    });
    return jsonEncode(decoded);
  }

  /// Requests one EMAP tile, bypassing caches, to learn whether NLSC answers.
  static Future<bool> probeEmap() => probe.probeEmapTile(emapProbeUri);
}
