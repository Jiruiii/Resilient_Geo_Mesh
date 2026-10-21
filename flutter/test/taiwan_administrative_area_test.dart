import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_index.dart';

String _hashVersion(String character) =>
    'sha256:${List<String>.filled(64, character).join()}';

final _sourceVersion = _hashVersion('0');

typedef _Ring = List<List<double>>;
typedef _Polygon = List<_Ring>;
typedef _MultiPolygon = List<_Polygon>;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('loads the canonical county and town directory asset', () async {
    final directory = await TaiwanAdministrativeAreaDirectory.load();

    expect(directory.sourceVersion, startsWith('sha256:'));
    expect(directory.counties, hasLength(22));
    expect(directory.towns, hasLength(368));
    expect(directory.childrenOf('tw.65000'), isNotEmpty);
  });

  test(
    'loads the official packed spatial asset with the matching source version',
    () async {
      final directory = await TaiwanAdministrativeAreaDirectory.load();
      final index = await TaiwanAdministrativeAreaIndex.load(directory);

      expect(
        index.resolvePoint(
          const GeoPoint(longitude: 121.517, latitude: 25.0478),
        ),
        hasLength(1),
      );
      expect(
        index.resolvePoint(
          const GeoPoint(longitude: 119.5663, latitude: 23.5657),
        ),
        hasLength(1),
      );
      expect(
        index.resolvePoint(const GeoPoint(longitude: 130, latitude: 0)),
        isEmpty,
      );
    },
  );

  test('normalizes national, county and descendant town selections', () {
    final directory = _directory();

    expect(
      directory.normalizeSelection(<String>{
        'tw.00001',
        'tw.00001001',
        'tw.00001002',
      }),
      <String>{'tw.00001'},
    );
    expect(
      directory.normalizeSelection(<String>{'tw.national', 'tw.00001001'}),
      <String>{'tw.national'},
    );
    expect(directory.normalizeSelection(<String>{'tw.99999'}), isEmpty);
    expect(directory.displayName('tw.00001001'), '測試縣 測試鎮一');
  });

  test(
    'resolves unique, outside, shared-boundary, hole and multipolygon points',
    () {
      final directory = _directory();
      final index = TaiwanAdministrativeAreaIndex.fromJson(
        directory,
        _spatialIndex(directory),
      );

      expect(
        index
            .resolvePoint(const GeoPoint(longitude: 1, latitude: 1))
            .map((area) => area.areaId),
        <String>['tw.00001001'],
      );
      expect(
        index.resolvePoint(const GeoPoint(longitude: 50, latitude: 50)),
        isEmpty,
      );
      expect(
        index
            .resolvePoint(const GeoPoint(longitude: 10, latitude: 5))
            .map((area) => area.areaId),
        <String>['tw.00001001', 'tw.00001002'],
      );
      expect(
        index.resolvePoint(const GeoPoint(longitude: 35, latitude: 5)),
        isEmpty,
      );
      expect(
        index
            .resolvePoint(const GeoPoint(longitude: 43, latitude: 1))
            .map((area) => area.areaId),
        <String>['tw.00001003'],
      );
    },
  );

  test(
    'rejects spatial assets from a different official directory version',
    () {
      final directory = _directory();
      final spatial = _spatialIndex(directory);
      spatial['source_version'] = _hashVersion('1');

      expect(
        () => TaiwanAdministrativeAreaIndex.fromJson(directory, spatial),
        throwsFormatException,
      );
    },
  );

  test('rejects nonnumeric and nonfinite coordinates while loading', () {
    final directory = _directory();
    final nonnumeric = _spatialIndex(directory);
    nonnumeric['coordinates'] = <Object?>[
      ...(nonnumeric['coordinates'] as List),
    ]..[0] = 'not-a-coordinate';

    final nonfinite = _spatialIndex(directory);
    nonfinite['coordinates'] = <Object?>[...(nonfinite['coordinates'] as List)]
      ..[0] = double.infinity;

    expect(
      () => TaiwanAdministrativeAreaIndex.fromJson(directory, nonnumeric),
      throwsFormatException,
    );
    expect(
      () => TaiwanAdministrativeAreaIndex.fromJson(directory, nonfinite),
      throwsFormatException,
    );
  });
}

TaiwanAdministrativeAreaDirectory _directory() =>
    TaiwanAdministrativeAreaDirectory.fromJson(<String, Object?>{
      'schema_version': 'taiwan-area-directory-v1',
      'coverage': 'TW',
      'target_coordinate_system': 'EPSG:4326',
      'source_version': _sourceVersion,
      'area_count': 5,
      'areas': <Map<String, Object?>>[
        _area('tw.00001', 'county', null, '測試縣', null),
        _area('tw.00001001', 'town', 'tw.00001', '測試縣', '測試鎮一'),
        _area('tw.00001002', 'town', 'tw.00001', '測試縣', '測試鎮二'),
        _area('tw.00001003', 'town', 'tw.00001', '測試縣', '測試鎮三'),
        _area('tw.00001004', 'town', 'tw.00001', '測試縣', '測試鎮四'),
      ],
    });

Map<String, Object?> _area(
  String id,
  String level,
  String? parentId,
  String countyName,
  String? townName,
) => <String, Object?>{
  'area_id': id,
  'level': level,
  'parent_area_id': parentId,
  'county_name': countyName,
  'town_name': townName,
};

Map<String, Object?> _spatialIndex(
  TaiwanAdministrativeAreaDirectory directory,
) {
  final coordinates = <double>[];
  final areas = <Map<String, Object?>>[];
  final geometries = <String, (String, _MultiPolygon)>{
    'tw.00001001': (
      'Polygon',
      <_Polygon>[
        <_Ring>[
          <List<double>>[
            <double>[0, 0],
            <double>[10, 0],
            <double>[10, 10],
            <double>[0, 10],
            <double>[0, 0],
          ],
        ],
      ],
    ),
    'tw.00001002': (
      'Polygon',
      <_Polygon>[
        <_Ring>[
          <List<double>>[
            <double>[10, 0],
            <double>[20, 0],
            <double>[20, 10],
            <double>[10, 10],
            <double>[10, 0],
          ],
        ],
      ],
    ),
    'tw.00001003': (
      'MultiPolygon',
      <_Polygon>[
        <_Ring>[
          <List<double>>[
            <double>[30, 0],
            <double>[40, 0],
            <double>[40, 10],
            <double>[30, 10],
            <double>[30, 0],
          ],
          <List<double>>[
            <double>[33, 3],
            <double>[37, 3],
            <double>[37, 7],
            <double>[33, 7],
            <double>[33, 3],
          ],
        ],
        <_Ring>[
          <List<double>>[
            <double>[42, 0],
            <double>[44, 0],
            <double>[44, 2],
            <double>[42, 2],
            <double>[42, 0],
          ],
        ],
      ],
    ),
    'tw.00001004': (
      'MultiPolygon',
      <_Polygon>[
        <_Ring>[
          <List<double>>[
            <double>[60, 0],
            <double>[62, 0],
            <double>[62, 2],
            <double>[60, 2],
            <double>[60, 0],
          ],
        ],
      ],
    ),
  };
  for (final entry in geometries.entries) {
    final area = directory.areaById(entry.key)!;
    final (geometryType, polygons) = entry.value;
    final coordinateOffset = coordinates.length ~/ 2;
    final ringOffsets = <int>[0];
    final polygonOffsets = <int>[0];
    for (final polygon in polygons) {
      for (final ring in polygon) {
        for (final point in ring) {
          coordinates.addAll(point);
        }
        ringOffsets.add(coordinates.length ~/ 2 - coordinateOffset);
      }
      polygonOffsets.add(ringOffsets.length - 1);
    }
    areas.add(<String, Object?>{
      'area_id': area.areaId,
      'level': area.level,
      'parent_area_id': area.parentAreaId,
      'county_name': area.countyName,
      'town_name': area.townName,
      'geometry_type': geometryType,
      'coordinate_offset': coordinateOffset,
      'ring_offsets': ringOffsets,
      'polygon_offsets': polygonOffsets,
      'bbox': switch (entry.key) {
        'tw.00001001' => <double>[0, 0, 10, 10],
        'tw.00001002' => <double>[10, 0, 20, 10],
        'tw.00001003' => <double>[30, 0, 44, 10],
        _ => <double>[60, 0, 62, 2],
      },
    });
  }
  return <String, Object?>{
    'schema_version': 'taiwan-area-index-v1',
    'coverage': 'TW',
    'target_coordinate_system': 'EPSG:4326',
    'source_version': directory.sourceVersion,
    'area_count': areas.length,
    'coordinate_encoding': 'flat-pairs-v1',
    'areas': areas,
    'coordinates': coordinates,
  };
}
