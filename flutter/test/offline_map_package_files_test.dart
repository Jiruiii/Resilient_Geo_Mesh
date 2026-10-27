import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/offline_map_manifest.dart';

void main() {
  test(
    'bundled Taiwan PMTiles exist and match manifest SHA-256 values',
    () async {
      for (final package in OfflineMapPackageCatalog.all) {
        final file = File(package.assetPath);
        expect(file.existsSync(), isTrue, reason: package.assetPath);
        final digest = await sha256.bind(file.openRead()).first;
        expect(digest.toString(), package.sha256, reason: package.id);
      }
    },
    // Hashing about 290 MB of PMTiles outlasts the default timeout under load.
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
