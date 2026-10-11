import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final mode in <String>['light', 'dark']) {
    test(
      'Taiwan $mode style uses local PMTiles and Traditional Chinese',
      () async {
        final raw = await rootBundle.loadString(
          'assets/map/styles/taiwan-$mode.json',
        );
        final labelsRaw = await rootBundle.loadString(
          'assets/map/labels/taiwan-reference-labels.geojson',
        );
        final style = jsonDecode(raw) as Map<String, dynamic>;
        final labels = jsonDecode(labelsRaw) as Map<String, dynamic>;
        final sources = style['sources'] as Map<String, dynamic>;
        final layers = style['layers'] as List<dynamic>;

        expect(style['version'], 8);
        expect(style['metadata'], containsPair('map:locale', 'zh-Hant'));
        expect(style['glyphs'], startsWith('asset://assets/'));
        expect(
          style['glyphs'],
          'asset://assets/map/fonts/{fontstack}/{range}.pbf',
        );
        expect(style['sprite'], startsWith('asset://assets/'));
        expect(
          sources.keys,
          containsAll(<String>[
            'taiwan-overview',
            'taiwan-north',
            'taiwan-central',
            'taiwan-south',
            'taiwan-east',
            'taiwan-reference-labels',
          ]),
        );

        for (final source in sources.entries
            .where((entry) => entry.key != 'taiwan-reference-labels')
            .map((entry) => entry.value)) {
          final sourceJson = source as Map<String, dynamic>;
          expect(sourceJson['type'], 'vector');
          expect(sourceJson['url'], startsWith('pmtiles://asset://assets/'));
          expect(sourceJson['attribution'], contains('OpenStreetMap'));
          expect(
            sourceJson['bounds'],
            hasLength(4),
            reason: 'Do not request regional archives outside their coverage',
          );
        }
        final referenceSource =
            sources['taiwan-reference-labels'] as Map<String, dynamic>;
        expect(referenceSource['type'], 'geojson');
        expect(
          referenceSource['data'],
          'asset://assets/map/labels/taiwan-reference-labels.geojson',
        );
        final referenceData = jsonEncode(labels);
        expect(referenceData, contains('澎湖'));
        expect(referenceData, contains('綠島'));
        expect(referenceData, contains('金門'));
        expect(referenceData, contains('台北101'));
        expect(referenceData, contains('中正紀念堂'));
        expect(referenceData, contains('"label_type":"city"'));
        expect(referenceData, contains('"label_type":"district"'));
        expect(referenceData, contains('"label_type":"village"'));
        expect(referenceData, contains('"admin_level":"county"'));
        expect(referenceData, contains('"parent":"苗栗縣"'));
        expect(referenceData, isNot(contains('廈門')));
        expect(referenceData, isNot(contains('泉州')));

        final countyNames =
            (labels['features'] as List<dynamic>)
                .whereType<Map<String, dynamic>>()
                .map((feature) => feature['properties'])
                .whereType<Map<String, dynamic>>()
                .where((properties) => properties['admin_level'] == 'county')
                .map((properties) => properties['name'])
                .whereType<String>()
                .toSet();
        expect(countyNames, <String>{
          '臺北市',
          '新北市',
          '桃園市',
          '臺中市',
          '臺南市',
          '高雄市',
          '基隆市',
          '新竹市',
          '嘉義市',
          '宜蘭縣',
          '新竹縣',
          '苗栗縣',
          '彰化縣',
          '南投縣',
          '雲林縣',
          '嘉義縣',
          '屏東縣',
          '臺東縣',
          '花蓮縣',
          '澎湖縣',
          '金門縣',
          '連江縣',
        });
        expect(countyNames, isNot(contains('頭份市')));

        final cityFeatures = (labels['features'] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .where((feature) {
              final properties = feature['properties'];
              return properties is Map<String, dynamic> &&
                  properties['label_type'] == 'city' &&
                  properties['admin_level'] == 'county';
            })
            .toList(growable: false);
        List<num> cityPoint(String name) {
          final feature = cityFeatures.firstWhere(
            (item) =>
                (item['properties'] as Map<String, dynamic>)['name'] == name,
          );
          return ((feature['geometry'] as Map<String, dynamic>)['coordinates']
                  as List<dynamic>)
              .whereType<num>()
              .toList(growable: false);
        }

        final newTaipei = cityPoint('新北市');
        final taipei = cityPoint('臺北市');
        expect(
          (newTaipei[0] - taipei[0]).abs(),
          greaterThan(0.05),
          reason: '臺北市與新北市的代表點不能重疊，否則標籤和資料分組會相撞',
        );

        final chiayiCity = cityPoint('嘉義市');
        final chiayiCounty = cityPoint('嘉義縣');
        expect(
          (chiayiCity[0] - chiayiCounty[0]).abs(),
          greaterThan(0.08),
          reason: '嘉義市與嘉義縣的代表點不能過近，否則兩個縣市標籤會重疊',
        );

        expect(
          layers.whereType<Map<String, dynamic>>().map((layer) => layer['id']),
          containsAll(<String>[
            'taiwan-background',
            'taiwan-water',
            'taiwan-landuse',
            'taiwan-buildings',
            'taiwan-roads',
            'taiwan-reference-islands',
            'taiwan-reference-cities',
            'taiwan-reference-districts',
            'taiwan-reference-towns',
            'taiwan-reference-villages',
            'taiwan-reference-landmarks',
            'taiwan-north-roads',
            'taiwan-central-roads',
            'taiwan-south-roads',
            'taiwan-east-roads',
            'taiwan-road-labels',
            'taiwan-north-road-labels',
            'taiwan-central-road-labels',
            'taiwan-south-road-labels',
            'taiwan-east-road-labels',
          ]),
        );
        expect(
          layers.whereType<Map<String, dynamic>>().map((layer) => layer['id']),
          isNot(contains('taiwan-reference-city-points')),
        );
        expect(
          layers.whereType<Map<String, dynamic>>().map((layer) => layer['id']),
          isNot(contains('taiwan-reference-district-points')),
        );
        expect(
          layers.whereType<Map<String, dynamic>>().map((layer) => layer['id']),
          isNot(contains('taiwan-reference-town-points')),
        );
        expect(
          layers.whereType<Map<String, dynamic>>().map((layer) => layer['id']),
          isNot(
            anyOf(
              contains('taiwan-pois'),
              contains('taiwan-landmarks'),
              contains('taiwan-north-landmarks'),
              contains('taiwan-central-landmarks'),
              contains('taiwan-south-landmarks'),
              contains('taiwan-east-landmarks'),
            ),
          ),
        );
        final placeLayers = layers
            .whereType<Map<String, dynamic>>()
            .where((layer) => layer['source-layer'] == 'places')
            .toList(growable: false);
        expect(placeLayers, isEmpty);
        final referenceIslandLayer = layers
            .whereType<Map<String, dynamic>>()
            .firstWhere((layer) => layer['id'] == 'taiwan-reference-islands');
        expect(referenceIslandLayer['minzoom'], 5.0);
        expect(referenceIslandLayer['maxzoom'], 22);
        final referenceLandmarkLayer = layers
            .whereType<Map<String, dynamic>>()
            .firstWhere((layer) => layer['id'] == 'taiwan-reference-landmarks');
        expect(referenceLandmarkLayer['minzoom'], 11);
        expect(referenceLandmarkLayer['maxzoom'], 22);
        final referenceLandmarkLayout =
            referenceLandmarkLayer['layout'] as Map<String, dynamic>;
        expect(referenceLandmarkLayout['text-allow-overlap'], isTrue);
        expect(referenceLandmarkLayout['text-ignore-placement'], isTrue);

        final referenceCityLayer = layers
            .whereType<Map<String, dynamic>>()
            .firstWhere((layer) => layer['id'] == 'taiwan-reference-cities');
        expect(referenceCityLayer['minzoom'], 5.0);
        expect(referenceCityLayer['maxzoom'], 8.5);
        expect(jsonEncode(referenceCityLayer['filter']), contains('"city"'));
        final cityLayout = referenceCityLayer['layout'] as Map<String, dynamic>;
        expect(cityLayout['text-allow-overlap'], isFalse);
        expect(cityLayout['text-ignore-placement'], isFalse);
        expect(
          cityLayout['text-variable-anchor'],
          containsAll(['top', 'bottom']),
        );
        final referenceDistrictLayer = layers
            .whereType<Map<String, dynamic>>()
            .firstWhere((layer) => layer['id'] == 'taiwan-reference-districts');
        expect(referenceDistrictLayer['minzoom'], 8.5);
        expect(referenceDistrictLayer['maxzoom'], 11.5);
        expect(
          jsonEncode(referenceDistrictLayer['filter']),
          contains('"district"'),
        );
        final referenceVillageLayer = layers
            .whereType<Map<String, dynamic>>()
            .firstWhere((layer) => layer['id'] == 'taiwan-reference-villages');
        expect(referenceVillageLayer['minzoom'], 11.5);
        expect(referenceVillageLayer['maxzoom'], 22);
        expect(
          jsonEncode(referenceVillageLayer['filter']),
          contains('"village"'),
        );

        final roadLayers = layers
            .whereType<Map<String, dynamic>>()
            .where(
              (layer) =>
                  layer['source-layer'] == 'roads' && layer['type'] == 'line',
            )
            .toList(growable: false);
        expect(roadLayers, hasLength(5));
        for (final layer in roadLayers) {
          expect(jsonEncode(layer['filter']), '["!=",["get","route"],"ferry"]');
        }

        final roadLabelLayers = layers
            .whereType<Map<String, dynamic>>()
            .where(
              (layer) =>
                  layer['source-layer'] == 'roads' && layer['type'] == 'symbol',
            )
            .toList(growable: false);
        expect(roadLabelLayers, hasLength(5));
        for (final layer in roadLabelLayers) {
          final layout = layer['layout'] as Map<String, dynamic>;
          expect(layout['symbol-placement'], 'line');
          expect(layout['text-field'], isNotNull);
          expect(layout['text-font'], <String>['NotoSansRegular']);
        }

        final landmarkIndex = layers.indexWhere(
          (layer) =>
              layer is Map<String, dynamic> &&
              layer['id'] == 'taiwan-reference-landmarks',
        );
        final roadLineIndexes = <int>[];
        for (var index = 0; index < layers.length; index += 1) {
          final layer = layers[index];
          if (layer is Map<String, dynamic> &&
              layer['source-layer'] == 'roads' &&
              layer['type'] == 'line') {
            roadLineIndexes.add(index);
          }
        }
        expect(landmarkIndex, greaterThan(roadLineIndexes.reduce(math.max)));

        final geometryLayers =
            layers
                .whereType<Map<String, dynamic>>()
                .where((layer) => layer['type'] != 'symbol')
                .toList();
        final lastGeometry = layers.indexOf(geometryLayers.last);
        for (final layer in layers.whereType<Map<String, dynamic>>()) {
          if (layer['type'] == 'symbol') {
            expect(
              layers.indexOf(layer),
              greaterThan(lastGeometry),
              reason: '${layer['id']} must not be covered by regional fills',
            );
          }
          if (layer['source'] == 'taiwan-overview') {
            expect(
              layer['maxzoom'],
              13,
              reason: 'Overview geometry must not double-render over detail',
            );
          }
        }
        final earthLayers = geometryLayers.where(
          (layer) => layer['source-layer'] == 'earth',
        );
        expect(
          earthLayers,
          hasLength(5),
          reason: 'Detailed coastlines are needed in every regional package',
        );
        for (final layer in earthLayers.where(
          (layer) => layer['source'] != 'taiwan-overview',
        )) {
          expect(layer['minzoom'], 13);
        }

        final waterLayers = geometryLayers.where(
          (layer) => layer['source-layer'] == 'water',
        );
        expect(
          waterLayers.where((layer) => layer['type'] == 'fill'),
          hasLength(5),
        );
        expect(
          waterLayers.where((layer) => layer['type'] == 'line'),
          hasLength(5),
        );
        for (final layer in waterLayers) {
          expect(
            layer['filter'],
            [
              '==',
              ['geometry-type'],
              layer['type'] == 'fill' ? 'Polygon' : 'LineString',
            ],
            reason: 'Streams must not close into fictitious water polygons',
          );
        }

        final landuseLayers = layers
            .whereType<Map<String, dynamic>>()
            .where((layer) => layer['source-layer'] == 'landuse')
            .toList(growable: false);
        expect(landuseLayers, hasLength(5));
        for (final layer in landuseLayers) {
          final filterJson = jsonEncode(layer['filter']);
          expect(filterJson, contains('"national_park"'));
          expect(filterJson, contains('"nature_reserve"'));
        }

        for (final layer in layers.whereType<Map<String, dynamic>>().where(
          (layer) => layer['type'] == 'symbol',
        )) {
          expect(
            (layer['layout'] as Map<String, dynamic>)['text-font'],
            <String>['NotoSansRegular'],
          );
        }

        final facilityPoiLayers = layers
            .whereType<Map<String, dynamic>>()
            .where((layer) => layer['source-layer'] == 'pois')
            .where((layer) => (layer['id'] as String).endsWith('-pois'))
            .toList(growable: false);
        expect(facilityPoiLayers, isEmpty);

        final landmarkPoiLayers = layers
            .whereType<Map<String, dynamic>>()
            .where(
              (layer) =>
                  (layer['id'] as String).endsWith('-landmarks') &&
                  layer['source-layer'] == 'pois',
            )
            .toList(growable: false);
        expect(landmarkPoiLayers, isEmpty);

        final serialized = jsonEncode(style);
        expect(serialized, isNot(contains('https://')));
        expect(serialized, isNot(contains('http://')));
      },
    );
  }
}
