import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'map_basemap.dart';
import 'maplibre_map_config.dart';
import 'offline_map_file_system.dart';
import 'offline_map_manifest.dart';

/// Installs range-readable PMTiles files in the native app-private directory.
///
/// Flutter assets are not suitable as native PMTiles sources because MapLibre
/// needs random byte ranges. Native platforms install files in the app-private
/// directory; Web rewrites package URLs and lets its protocol adapter serve
/// the requested archive from memory when the asset server lacks byte ranges.
class OfflineMapAssetStore {
  OfflineMapAssetStore({AssetBundle? bundle}) : _bundle = bundle ?? rootBundle;

  final AssetBundle _bundle;
  static const String referenceLabelsAsset =
      'assets/map/labels/taiwan-reference-labels.geojson';
  static const String referenceLabelsAssetUri =
      'asset://assets/map/labels/taiwan-reference-labels.geojson';
  static const MethodChannel _nativeChannel = MethodChannel(
    'com.resilientgeo.mesh/offline_map_assets',
  );
  Future<Map<String, String>>? _installedFiles;

  /// Hydrates the single editable label asset into either map style.
  ///
  /// Keeping the GeoJSON outside the light/dark style files means a label
  /// name or coordinate is changed once and remains consistent on every
  /// renderer.
  static String injectReferenceLabels(String styleJson, String labelsJson) {
    final decodedStyle = jsonDecode(styleJson);
    final decodedLabels = jsonDecode(labelsJson);
    if (decodedStyle is! Map<String, dynamic> ||
        decodedLabels is! Map<String, dynamic>) {
      throw const FormatException('Map style or reference labels is not JSON');
    }

    final sources = decodedStyle['sources'];
    if (sources is Map<String, dynamic>) {
      final source = sources['taiwan-reference-labels'];
      if (source is Map<String, dynamic> &&
          source['data'] == referenceLabelsAssetUri) {
        source['data'] = decodedLabels;
      }
    }
    return jsonEncode(decodedStyle);
  }

  static String rewriteStyleAssetUris(
    String styleJson, {
    required Map<String, String> assetFiles,
  }) {
    var rewritten = styleJson;
    for (final entry in assetFiles.entries) {
      final path = _fileUri(entry.value);
      rewritten = rewritten
          .replaceAll('pmtiles://asset://${entry.key}', 'pmtiles://$path')
          .replaceAll('asset://${entry.key}', path);
    }
    return rewritten;
  }

  static String rewriteWebStyleAssetUris(String styleJson) {
    final decoded = jsonDecode(styleJson);
    if (decoded is! Map<String, dynamic>) return styleJson;

    // Flutter Web serves an asset whose pubspec key is
    // `assets/map/...` at `/assets/assets/map/...` in both release builds and
    // the dev asset server. Keep this canonical URL here so styles work with
    // a static offline preview as well as `flutter run -d chrome`.
    final assetsBase = Uri.base.resolve('assets/assets/');

    String resolveAssetPath(String relativePath) {
      final tokenIndex = relativePath.indexOf('{');
      if (tokenIndex < 0) return assetsBase.resolve(relativePath).toString();
      final staticPath = relativePath.substring(0, tokenIndex);
      final template = relativePath.substring(tokenIndex);
      return '${assetsBase.resolve(staticPath)}$template';
    }

    String rewriteAssetUri(String value) {
      const prefix = 'asset://assets/';
      if (!value.startsWith(prefix)) return value;
      return resolveAssetPath(value.substring(prefix.length));
    }

    String rewriteWebUri(String value) {
      const prefix = 'pmtiles://asset://assets/';
      if (value.startsWith(prefix)) {
        final archiveUri = assetsBase.resolve(value.substring(prefix.length));
        return 'pmtiles://$archiveUri';
      }
      return rewriteAssetUri(value);
    }

    for (final key in <String>['sprite', 'glyphs', 'url']) {
      final value = decoded[key];
      if (value is String) decoded[key] = rewriteWebUri(value);
    }

    final sources = decoded['sources'];
    if (sources is Map) {
      for (final source in sources.values) {
        if (source is! Map) continue;
        final url = source['url'];
        if (url is! String || !url.startsWith('pmtiles://asset://assets/')) {
          continue;
        }
        source['tiles'] = <String>['${rewriteWebUri(url)}/{z}/{x}/{y}'];
        source.remove('url');
      }
    }

    return jsonEncode(decoded);
  }

  /// Android AssetManager sees Flutter's bundle below `flutter_assets/`.
  /// MapLibre reads glyphs and sprites directly, outside Flutter's asset loader.
  static String rewriteAndroidStyleAssetUris(String styleJson) =>
      styleJson.replaceAll('asset://assets/', 'asset://flutter_assets/assets/');

  Future<String> loadStyle({
    required String styleAsset,
    required bool installNativeAssets,
  }) async {
    final styleJson = await _bundle.loadString(styleAsset);
    final labelsJson = await _bundle.loadString(referenceLabelsAsset);
    final hydratedStyle = MapBasemap.injectEmapLayer(
      injectReferenceLabels(styleJson, labelsJson),
      dark: styleAsset == MapLibreMapConfig.darkStyleAsset,
    );
    if (kIsWeb) return rewriteWebStyleAssetUris(hydratedStyle);
    if (!installNativeAssets) return hydratedStyle;

    final installed = await installPmtiles();
    final rewritten = rewriteStyleAssetUris(
      hydratedStyle,
      assetFiles: installed,
    );
    return defaultTargetPlatform == TargetPlatform.android
        ? rewriteAndroidStyleAssetUris(rewritten)
        : rewritten;
  }

  Future<Map<String, String>> installPmtiles() {
    return _installedFiles ??= _installPmtiles().catchError((
      Object error,
      StackTrace stack,
    ) {
      // A failed install must be retryable after space/IO problems are fixed.
      _installedFiles = null;
      Error.throwWithStackTrace(error, stack);
    });
  }

  Future<Map<String, String>> _installPmtiles() async {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      try {
        final response = await _nativeChannel.invokeMethod<Object?>(
          'copyPmtiles',
          <String, dynamic>{
            'assets': OfflineMapPackageCatalog.all
                .map((package) => package.assetPath)
                .toList(growable: false),
            'versions': <String, String>{
              for (final package in OfflineMapPackageCatalog.all)
                package.assetPath: package.sha256,
            },
          },
        );
        if (response is Map) {
          final installed = <String, String>{};
          for (final package in OfflineMapPackageCatalog.all) {
            final path = response[package.assetPath];
            if (path is! String || path.isEmpty) break;
            installed[package.assetPath] = path;
          }
          if (installed.length == OfflineMapPackageCatalog.all.length) {
            return installed;
          }
        }
        // Real native IO errors propagate to the map's retry surface. Loading
        // hundreds of MB through rootBundle after a disk failure can exhaust
        // the Flutter heap and hides the original, actionable error.
      } on MissingPluginException {
        // Flutter preview hosts have no Android asset bridge; use the
        // deterministic bundle fallback below for tests and iOS previews.
      }
    }

    final installed = <String, String>{};
    for (final package in OfflineMapPackageCatalog.all) {
      final data = await _bundle.load(package.assetPath);
      final bytes = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      final fileName = package.fileName;
      final filePath = await copyMapAssetToPrivateDirectory(
        fileName: fileName,
        bytes: bytes,
      );
      installed[package.assetPath] = filePath;
    }
    return installed;
  }

  /// Used by diagnostics and tests to keep the on-disk manifest readable.
  static String manifestJson() => jsonEncode(<String, dynamic>{
    'packages': OfflineMapPackageCatalog.all
        .map((package) => package.toJson())
        .toList(growable: false),
  });

  static String _fileUri(String path) =>
      path.startsWith('file://') ? path : 'file://$path';
}
