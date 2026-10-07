import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/offline_address_pack_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'catalog lists all 22 counties and keeps unsupported counties explicit',
    () {
      final counties = List<Map<String, dynamic>>.generate(22, (index) {
        final code = (10000 + index).toString();
        return <String, dynamic>{
          'county_code': code,
          'county_name': '縣市$index',
          'coverage_status': 'unavailable',
          'source_count': null,
          'located_count': null,
          'manifest_url': null,
        };
      });
      counties[0] = <String, dynamic>{
        'county_code': '63000',
        'county_name': '臺北市',
        'coverage_status': 'partial',
        'source_count': 100,
        'located_count': 99,
        'manifest_url': '/address-packs/manifest-63000.json',
      };
      final catalog = AddressPackCatalog.fromJson(<String, dynamic>{
        'schema_version': 'address-pack-catalog-v1',
        'attribution': '政府資料開放授權',
        'counties': counties,
      });

      expect(catalog.counties, hasLength(22));
      expect(catalog.counties.first.available, isTrue);
      expect(catalog.counties.first.partial, isTrue);
      expect(catalog.counties.last.available, isFalse);
    },
  );

  test('download stores the county locally and address search returns compact matches', () async {
    const channel = MethodChannel('test-address-pack-store');
    final record = <String, dynamic>{
      'id': 'address:63000:42',
      'kind': 'address',
      'name': '臺北市松山區三民里三民路95巷1號',
      'address': '臺北市松山區三民里三民路95巷1號',
      'aliases': <String>['臺北市松山區三民路95巷1號'],
      'search_key': '臺北市松山區三民里三民路95巷1號',
      'region': '臺北市松山區',
      'coordinate': <double>[121.5638, 25.0594],
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'downloadAddressPack') {
            return jsonEncode(<String, dynamic>{
              'status': 'ready',
              'county_code': '63000',
            });
          }
          expect(call.method, 'searchAddressPacks');
          return jsonEncode(<String, dynamic>{
            'results': <Map<String, dynamic>>[record],
          });
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );

    final store = OfflineAddressPackStore(channel: channel);
    const county = AddressPackCounty(
      code: '63000',
      name: '臺北市',
      coverageStatus: 'partial',
      locatedCount: 99,
      sourceCount: 100,
      manifestUrl: '/address-packs/manifest-63000.json',
    );
    final result = await store.downloadCounty(county);

    expect(result.ready, isTrue);
    expect(store.installedCountyCodes, contains('63000'));
    expect(result.records, isEmpty);
    final matches = await store.search('臺北市松山區三民里三民路95巷1號');
    expect(matches.single.searchKey, '臺北市松山區三民里三民路95巷1號');
    expect(matches.single.coordinate.longitude, 121.5638);
  });
}
