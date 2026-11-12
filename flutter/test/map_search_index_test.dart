import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/map_search.dart';
import 'package:resilientgeo_flutter/data/map_search_asset.dart';

void main() {
  test('substring postings preserve scan results and ordering', () {
    final random = Random(41);
    const names = ['中正路', '成功路', '文化路一段', '中山北路', 'road alpha', '😀橋'];
    const regions = ['新北市板橋區', '臺北市內湖區', '新店區', ''];
    final entries = List.generate(
      500,
      (i) => TaiwanSearchEntry(
        id: 'osm:way:${100000 + i}',
        name: names[random.nextInt(names.length)],
        aliases: [names[random.nextInt(names.length)], 'alias $i'],
        kind: i % 10 == 0 ? 'medical' : 'road',
        region: regions[random.nextInt(regions.length)],
        coordinate: const GeoPoint(longitude: 121.5, latitude: 25.0),
      ),
    );
    final indexed = MapSearchIndex(const [], roadEntries: entries)..prepare();
    final scan = MapSearchIndex(
      const [],
      roadEntries: entries,
      indexedRoadSearch: false,
    );
    for (final query in [
      ...names,
      ...regions,
      '路',
      '正路',
      '成功',
      '板橋',
      'road',
      'medical',
      '1001',
      'osm:way:100123',
      'alias 13',
      '新北市板橋區文化路一段123號',
      '內湖區成功路二段',
      '臺北市內湖區未知街道',
      'unmatched',
      '😀',
      '25.03, 121.5',
      '',
      ' ROAD  ALPHA ',
    ]) {
      expect(
        indexed.query(query).map((r) => r.id).toList(),
        scan.query(query).map((r) => r.id).toList(),
        reason: query,
      );
    }
  });

  test('bundled roads are not matched by internal id or kind', () {
    final index = MapSearchIndex(
      const [],
      roadEntries: const [
        TaiwanSearchEntry(
          id: 'way:319679961',
          name: '成功路',
          aliases: [],
          kind: 'road',
          region: null,
          coordinate: GeoPoint(longitude: 121.5, latitude: 25.0),
        ),
      ],
    )..prepare();
    expect(index.query('成功路').single.id, 'way:319679961');
    expect(index.query('319679961'), isEmpty);
    expect(index.query('road'), isEmpty);
  });
}
