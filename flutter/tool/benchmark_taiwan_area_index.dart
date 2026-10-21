import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:resilientgeo_flutter/data/area_index_memory_sampler.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_directory.dart';
import 'package:resilientgeo_flutter/data/taiwan_administrative_area_index.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final memory = createAreaIndexMemorySampler();
  await memory.start();
  final baselineBytes = memory.currentResidentBytes;

  final directoryStopwatch = Stopwatch()..start();
  final directory = await TaiwanAdministrativeAreaDirectory.load();
  directoryStopwatch.stop();

  final indexStopwatch = Stopwatch()..start();
  final index = await TaiwanAdministrativeAreaIndex.load(directory);
  indexStopwatch.stop();
  await Future<void>.delayed(const Duration(milliseconds: 100));
  final peakBytes = await memory.stop();

  const cases = <({String name, GeoPoint point})>[
    (name: 'north', point: GeoPoint(longitude: 121.517, latitude: 25.0478)),
    (name: 'central', point: GeoPoint(longitude: 120.6736, latitude: 24.1477)),
    (name: 'south', point: GeoPoint(longitude: 120.3014, latitude: 22.6273)),
    (name: 'east', point: GeoPoint(longitude: 121.6063, latitude: 23.9872)),
    (name: 'offshore', point: GeoPoint(longitude: 119.5663, latitude: 23.5657)),
    (name: 'no_match', point: GeoPoint(longitude: 130, latitude: 0)),
  ];
  final lookups = <String, Object?>{};
  for (final testCase in cases) {
    index.resolvePoint(testCase.point);
    const iterations = 200;
    final stopwatch = Stopwatch()..start();
    List<TaiwanAdministrativeArea> matches = const <TaiwanAdministrativeArea>[];
    for (var iteration = 0; iteration < iterations; iteration += 1) {
      matches = index.resolvePoint(testCase.point);
    }
    stopwatch.stop();
    lookups[testCase.name] = <String, Object?>{
      'area_ids': matches.map((area) => area.areaId).toList(growable: false),
      'iterations': iterations,
      'average_microseconds': stopwatch.elapsedMicroseconds / iterations,
    };
  }

  debugPrint(
    'AREA_INDEX_BENCHMARK ${jsonEncode(<String, Object?>{'platform': areaIndexBenchmarkPlatform, 'source_version': directory.sourceVersion, 'directory_load_ms': directoryStopwatch.elapsedMilliseconds, 'spatial_index_load_ms': indexStopwatch.elapsedMilliseconds, 'baseline_resident_bytes': baselineBytes, 'peak_resident_bytes': peakBytes, 'peak_additional_bytes': baselineBytes == null || peakBytes == null ? null : peakBytes - baselineBytes, 'lookups': lookups})}',
  );
  runApp(const SizedBox.shrink());
}
