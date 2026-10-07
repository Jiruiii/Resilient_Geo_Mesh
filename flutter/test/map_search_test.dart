import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_administrative.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/map_search.dart';
import 'package:resilientgeo_flutter/data/map_search_asset.dart';

void main() {
  final hospital = StaticFeature.fromJson(<String, dynamic>{
    'id': 'medical:1',
    'kind': 'medical',
    'name': 'Neihu General Hospital',
    'address': 'Taipei NEIHU Road 1',
    'facility_type': '醫院',
    'geometry': <String, dynamic>{
      'type': 'Point',
      'coordinates': <double>[121.59, 25.08],
    },
  });
  final shelter = StaticFeature.fromJson(<String, dynamic>{
    'id': 'shelter:2',
    'kind': 'shelter',
    'name': '潭美國小',
    'address': '內湖區新明路22號',
    'disaster_types': <String>['水災', '震災'],
    'available_count': null,
    'geometry': <String, dynamic>{
      'type': 'Point',
      'coordinates': <double>[121.58, 25.06],
    },
  });
  final road = StaticFeature.fromJson(<String, dynamic>{
    'id': 'osm:way:3',
    'kind': 'road',
    'name': 'Minquan East ROAD',
    'road_class': 'primary',
    'geometry': <String, dynamic>{
      'type': 'LineString',
      'coordinates': <dynamic>[
        <double>[121.56, 25.07],
        <double>[121.62, 25.09],
      ],
    },
  });

  test(
    'matches names and addresses case-insensitively using local features',
    () {
      final index = MapSearchIndex(<StaticFeature>[hospital, shelter, road]);

      expect(index.query('general HOSPITAL').single.feature, same(hospital));
      expect(index.query('taipei neihu').single.feature, same(hospital));
      expect(index.query('east road').single.feature, same(road));
    },
  );

  test('searches id, kind, and other detail values without changing nulls', () {
    final index = MapSearchIndex(<StaticFeature>[hospital, shelter, road]);

    expect(index.query('shelter:2').single.feature, same(shelter));
    expect(index.query('medical').single.feature, same(hospital));
    expect(index.query('震災').single.feature, same(shelter));
    expect(shelter.details['available_count'], isNull);
  });

  test(
    'returns display labels and focus coordinates for every supported kind',
    () {
      final results = MapSearchIndex(<StaticFeature>[
        hospital,
        shelter,
        road,
      ]).query('');

      expect(results, isEmpty);

      final hospitalResult = MapSearchIndex(<StaticFeature>[
        hospital,
      ]).query('n');
      expect(hospitalResult.single.typeLabel, '醫療院所');
      expect(hospitalResult.single.coordinate!.longitude, 121.59);
      expect(hospitalResult.single.coordinate!.latitude, 25.08);

      final shelterResult = MapSearchIndex(<StaticFeature>[
        shelter,
      ]).query('潭美');
      expect(shelterResult.single.typeLabel, '避難所');
      expect(shelterResult.single.coordinate!.longitude, 121.58);

      final roadResult = MapSearchIndex(<StaticFeature>[road]).query('primary');
      expect(roadResult.single.typeLabel, '道路');
      expect(roadResult.single.coordinate!.longitude, 121.59);
      expect(roadResult.single.coordinate!.latitude, 25.08);
    },
  );

  test('returns at most eight tied matches in source order', () {
    final features = List<StaticFeature>.generate(
      10,
      (index) => StaticFeature.fromJson(<String, dynamic>{
        'id': 'road:$index',
        'kind': 'road',
        'name': '共同道路',
        'geometry': <String, dynamic>{
          'type': 'Point',
          'coordinates': <double>[121.56 + index / 1000, 25.07],
        },
      }),
    );

    final results = MapSearchIndex(features).query('共同');

    expect(results, hasLength(8));
    expect(results.map((result) => result.id), <String>[
      'road:0',
      'road:1',
      'road:2',
      'road:3',
      'road:4',
      'road:5',
      'road:6',
      'road:7',
    ]);
  });

  test('address search uses county doorplate entries only for address-like queries', () {
    final address = TaiwanSearchEntry(
      id: 'address:63000:abc',
      name: '臺北市松山區三民里三民路９５巷１號',
      aliases: const <String>['臺北市松山區三民路95巷1號'],
      kind: 'address',
      region: '臺北市松山區',
      coordinate: const GeoPoint(longitude: 121.5638, latitude: 25.0594),
    );
    final index = MapSearchIndex(
      const <StaticFeature>[],
      addressEntries: <TaiwanSearchEntry>[address],
    );

    final result = index.query('台北市 松山區 三民路 95巷1號').single;
    expect(result.searchKind, 'address');
    expect(result.address, '臺北市松山區三民里三民路９５巷１號');
    expect(result.coordinate!.longitude, 121.5638);
    expect(index.query('三民路'), isEmpty);
  });

  test('ignores whitespace-only queries and features without coordinates', () {
    final missingGeometry = StaticFeature.fromJson(<String, dynamic>{
      'id': 'medical:missing',
      'kind': 'medical',
      'name': '無座標醫院',
    });
    final index = MapSearchIndex(<StaticFeature>[hospital, missingGeometry]);

    expect(index.query('   '), isEmpty);
    expect(index.query('無座標'), isEmpty);
  });

  test(
    'searches unresolved medical directory rows without returning a coordinate',
    () {
      final unresolved = StaticFeature.fromJson(<String, dynamic>{
        'id': 'medical-directory:h002',
        'kind': 'medical-directory',
        'name': '待定位診所',
        'address': '花蓮縣花蓮市民生路1號',
        'geometry_status': 'unresolved',
        'point_feature_id': null,
        'geometry': null,
      });

      final result =
          MapSearchIndex(<StaticFeature>[unresolved]).query('花蓮市民生路').single;

      expect(result.feature, same(unresolved));
      expect(result.coordinate, isNull);
      expect(result.typeLabel, '醫療院所（尚未定位）');
    },
  );

  test(
    'links located medical directory search to its verified map point once',
    () {
      final point = StaticFeature.fromJson(<String, dynamic>{
        'id': 'medical:h001',
        'kind': 'medical',
        'name': '臺北醫院',
        'address': '臺北市大安區仁愛路1號',
        'geometry': <String, dynamic>{
          'type': 'Point',
          'coordinates': <double>[121.52, 25.04],
        },
      });
      final directory = StaticFeature.fromJson(<String, dynamic>{
        'id': 'medical-directory:h001',
        'kind': 'medical-directory',
        'name': '臺北醫院',
        'address': '臺北市大安區仁愛路1號',
        'geometry_status': 'located',
        'point_feature_id': 'medical:h001',
        'geometry': <String, dynamic>{
          'type': 'Point',
          'coordinates': <double>[121.52, 25.04],
        },
      });

      final results = MapSearchIndex(<StaticFeature>[
        point,
        directory,
      ]).query('臺北醫院');

      expect(results, hasLength(1));
      expect(results.single.feature, same(directory));
      expect(
        results.single.coordinate,
        const GeoPoint(longitude: 121.52, latitude: 25.04),
      );
    },
  );

  test('parses latitude then longitude within Taiwan', () {
    expect(
      parseTaiwanCoordinate('25.011549, 121.545053'),
      const GeoPoint(longitude: 121.545053, latitude: 25.011549),
    );
  });

  test('rejects coordinates outside Taiwan', () {
    expect(parseTaiwanCoordinate('35.0, 139.0'), isNull);
  });

  test('returns a coordinate result without a facility feature', () {
    final query = MapSearchIndex(
      <StaticFeature>[],
    ).search('25.011549, 121.545053');

    expect(query.isCoordinate, isTrue);
    expect(query.results, hasLength(1));
    expect(query.results.single.feature, isNull);
    expect(query.results.single.typeLabel, '經緯度');
    expect(
      query.results.single.coordinate,
      const GeoPoint(longitude: 121.545053, latitude: 25.011549),
    );
  });

  test('does not treat an invalid coordinate-shaped query as a name', () {
    final feature = StaticFeature.fromJson(<String, dynamic>{
      'id': 'road:coordinate-like',
      'kind': 'road',
      'name': '35.0, 139.0',
      'geometry': <String, dynamic>{
        'type': 'Point',
        'coordinates': <double>[121.5, 25.0],
      },
    });

    expect(
      MapSearchIndex(<StaticFeature>[feature]).query('35.0, 139.0'),
      isEmpty,
    );
  });

  test('preserves two same-name roads in different regions', () {
    final index = MapSearchIndex(
      const [],
      roadEntries: <TaiwanSearchEntry>[
        TaiwanSearchEntry.fromJson(<String, dynamic>{
          'id': 'way:1',
          'name': '中山路',
          'aliases': <String>[],
          'kind': 'road',
          'region': '臺北市',
          'coordinate': <double>[121.52, 25.04],
        }),
        TaiwanSearchEntry.fromJson(<String, dynamic>{
          'id': 'way:2',
          'name': '中山路',
          'aliases': <String>[],
          'kind': 'road',
          'region': '高雄市',
          'coordinate': <double>[120.30, 22.63],
        }),
      ],
    );

    final results = index.query('中山路');

    expect(
      results.map((item) => item.region),
      containsAll(<String>['臺北市', '高雄市']),
    );
    expect(results.every((item) => item.feature == null), isTrue);
  });

  test('searches administrative areas before map drag refinement', () {
    const area = MapAdministrativeArea(
      key: 'subdivision:內湖區:臺北市',
      level: MapAdministrativeLevel.subdivision,
      name: '內湖區',
      displayName: '臺北市內湖區',
      parent: '臺北市',
      point: GeoPoint(longitude: 121.59, latitude: 25.08),
    );

    final results = MapSearchIndex(
      const [],
      administrativeAreas: const <MapAdministrativeArea>[area],
    ).query('內湖區');

    expect(results, hasLength(1));
    expect(results.single.title, '臺北市內湖區');
    expect(results.single.typeLabel, '行政區');
    expect(results.single.coordinate, area.point);
  });

  test('returns a road contained in a longer address query', () {
    final results = MapSearchIndex(
      const [],
      roadEntries: <TaiwanSearchEntry>[
        TaiwanSearchEntry.fromJson(<String, dynamic>{
          'id': 'way:success-road',
          'name': '成功路',
          'aliases': <String>[],
          'kind': 'road',
          'region': null,
          'coordinate': <double>[121.59, 25.08],
        }),
      ],
    ).query('臺北市內湖區成功路一段');

    expect(results.single.title, '成功路');
  });

  test('adds nearby administrative context to an unlabelled road', () {
    const county = MapAdministrativeArea(
      key: 'county:新北市:',
      level: MapAdministrativeLevel.county,
      name: '新北市',
      displayName: '新北市',
      parent: null,
      point: GeoPoint(longitude: 121.55, latitude: 25.05),
    );
    const subdivision = MapAdministrativeArea(
      key: 'subdivision:三重區:新北市',
      level: MapAdministrativeLevel.subdivision,
      name: '三重區',
      displayName: '三重區',
      parent: '新北市',
      point: GeoPoint(longitude: 121.487157, latitude: 25.063101),
    );

    final results = MapSearchIndex(
      const [],
      roadEntries: <TaiwanSearchEntry>[
        TaiwanSearchEntry.fromJson(<String, dynamic>{
          'id': 'way:wanquan-sanchong',
          'name': '萬全街',
          'aliases': <String>[],
          'kind': 'road',
          'region': null,
          'coordinate': <double>[121.487157, 25.063101],
        }),
      ],
      administrativeAreas: const <MapAdministrativeArea>[county, subdivision],
    ).query('新北市三重區萬全街');

    final road = results.singleWhere((result) => result.searchKind == 'road');
    expect(road.region, '新北市三重區');
  });

  test(
    'does not return unrelated roads from an administrative context match',
    () {
      const county = MapAdministrativeArea(
        key: 'county:新北市:',
        level: MapAdministrativeLevel.county,
        name: '新北市',
        displayName: '新北市',
        parent: null,
        point: GeoPoint(longitude: 121.55, latitude: 25.05),
      );
      const subdivision = MapAdministrativeArea(
        key: 'subdivision:三重區:新北市',
        level: MapAdministrativeLevel.subdivision,
        name: '三重區',
        displayName: '三重區',
        parent: '新北市',
        point: GeoPoint(longitude: 121.487157, latitude: 25.063101),
      );

      final results = MapSearchIndex(
        const [],
        roadEntries: <TaiwanSearchEntry>[
          TaiwanSearchEntry.fromJson(<String, dynamic>{
            'id': 'way:unrelated',
            'name': '機慢車專用道',
            'aliases': <String>[],
            'kind': 'road',
            'region': null,
            'coordinate': <double>[121.4872, 25.0631],
          }),
          TaiwanSearchEntry.fromJson(<String, dynamic>{
            'id': 'way:wanquan',
            'name': '萬全街',
            'aliases': <String>[],
            'kind': 'road',
            'region': null,
            'coordinate': <double>[121.487157, 25.063101],
          }),
        ],
        administrativeAreas: const <MapAdministrativeArea>[county, subdivision],
      ).query('新北市三重區萬全街');

      expect(
        results
            .where((result) => result.searchKind == 'road')
            .map((result) => result.title),
        everyElement('萬全街'),
      );
    },
  );
}
