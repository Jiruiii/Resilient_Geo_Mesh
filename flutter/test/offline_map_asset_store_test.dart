import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/offline_map_asset_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'native installation failure propagates and the next attempt retries',
    () async {
      const channel = MethodChannel('com.resilientgeo.mesh/offline_map_assets');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      var attempts = 0;
      messenger.setMockMethodCallHandler(channel, (call) async {
        attempts++;
        if (attempts == 1) {
          throw PlatformException(
            code: 'map_asset_error',
            message: 'Disk full',
          );
        }
        final assets = (call.arguments as Map)['assets'] as List;
        return {
          for (final asset in assets)
            asset: '/maps/${(asset as String).split('/').last}',
        };
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final store = OfflineMapAssetStore();
      await expectLater(
        store.installPmtiles(),
        throwsA(isA<PlatformException>()),
      );
      final files = await store.installPmtiles();
      expect(files.length, 5);
      await store.installPmtiles();
      expect(attempts, 2);
    },
  );
  test('Android glyphs and sprites resolve inside the Flutter APK bundle', () {
    const style =
        '{"glyphs":"asset://assets/map/fonts/{fontstack}/{range}.pbf",'
        '"sprite":"asset://assets/map/sprites/v4/dark",'
        '"url":"pmtiles://file:///data/user/0/app/maps/base.pmtiles"}';
    final rewritten = jsonDecode(
      OfflineMapAssetStore.rewriteAndroidStyleAssetUris(style),
    );
    expect(
      rewritten['glyphs'],
      'asset://flutter_assets/assets/map/fonts/{fontstack}/{range}.pbf',
    );
    expect(
      rewritten['sprite'],
      'asset://flutter_assets/assets/map/sprites/v4/dark',
    );
    expect(
      rewritten['url'],
      'pmtiles://file:///data/user/0/app/maps/base.pmtiles',
    );
  });
  test('hydrates the editable reference label asset into a map style', () {
    const style =
        '{"sources":{"taiwan-reference-labels":{'
        '"type":"geojson",'
        '"data":"asset://assets/map/labels/taiwan-reference-labels.geojson"'
        '}}}';
    const labels =
        '{"type":"FeatureCollection","features":['
        '{"type":"Feature","properties":{"name":"台北101"},'
        '"geometry":{"type":"Point","coordinates":[121.5645,25.033]}}'
        ']}';

    final hydrated = OfflineMapAssetStore.injectReferenceLabels(style, labels);
    final source =
        ((jsonDecode(hydrated) as Map<String, dynamic>)['sources']
                as Map<String, dynamic>)['taiwan-reference-labels']
            as Map<String, dynamic>;

    expect(source['data'], containsPair('type', 'FeatureCollection'));
    expect(jsonEncode(source['data']), contains('台北101'));
  });

  test('rewrites PMTiles asset URIs to installed local files', () {
    const style =
        '{"url":"pmtiles://asset://assets/map/pmtiles/taiwan.pmtiles",'
        '"glyphs":"asset://assets/map/fonts/{fontstack}/{range}.pbf"}';

    final rewritten = OfflineMapAssetStore.rewriteStyleAssetUris(
      style,
      assetFiles: <String, String>{
        'assets/map/pmtiles/taiwan.pmtiles':
            '/data/user/0/com.example/files/maps/taiwan.pmtiles',
        'assets/map/fonts/{fontstack}/{range}.pbf':
            '/data/user/0/com.example/files/maps/fonts/{fontstack}/{range}.pbf',
      },
    );

    expect(
      rewritten,
      '{"url":"pmtiles://file:///data/user/0/com.example/files/maps/taiwan.pmtiles",'
      '"glyphs":"file:///data/user/0/com.example/files/maps/fonts/{fontstack}/{range}.pbf"}',
    );
  });

  test('rewrites PMTiles and style assets to web package URLs', () {
    const style =
        '{"url":"pmtiles://asset://assets/map/pmtiles/taiwan.pmtiles",'
        '"glyphs":"asset://assets/map/fonts/{fontstack}/{range}.pbf",'
        '"sprite":"asset://assets/map/sprites/v4/light"}';

    final assetsBase = Uri.base.resolve('assets/assets/');
    final glyphsUri =
        '${assetsBase.resolve('map/fonts/')}'
        '{fontstack}/{range}.pbf';
    expect(
      OfflineMapAssetStore.rewriteWebStyleAssetUris(style),
      '{"url":"pmtiles://${assetsBase.resolve('map/pmtiles/taiwan.pmtiles')}",'
      '"glyphs":"$glyphsUri",'
      '"sprite":"${assetsBase.resolve('map/sprites/v4/light')}"}',
    );
  });

  test('rewrites web styles to absolute assets and direct PMTiles tiles', () {
    const style =
        '{'
        '"sprite":"asset://assets/map/sprites/v4/light",'
        '"glyphs":"asset://assets/map/fonts/{fontstack}/{range}.pbf",'
        '"sources":{'
        '"taiwan":{"type":"vector",'
        '"url":"pmtiles://asset://assets/map/pmtiles/taiwan.pmtiles",'
        '"minzoom":0,"maxzoom":12}'
        '}'
        '}';

    final document =
        jsonDecode(OfflineMapAssetStore.rewriteWebStyleAssetUris(style))
            as Map<String, dynamic>;
    final assetsBase = Uri.base.resolve('assets/assets/');
    final source =
        (document['sources'] as Map<String, dynamic>)['taiwan']
            as Map<String, dynamic>;
    final archiveUri = assetsBase.resolve('map/pmtiles/taiwan.pmtiles');
    final glyphsUri =
        '${assetsBase.resolve('map/fonts/')}'
        '{fontstack}/{range}.pbf';

    expect(
      document['sprite'],
      assetsBase.resolve('map/sprites/v4/light').toString(),
    );
    expect(document['glyphs'], glyphsUri);
    expect(source['tiles'], <String>['pmtiles://$archiveUri/{z}/{x}/{y}']);
    expect(source.containsKey('url'), isFalse);
  });
}
