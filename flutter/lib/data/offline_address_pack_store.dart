import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'map_search_asset.dart';
import 'offline_address_pack_web.dart';

class AddressPackCounty {
  const AddressPackCounty({
    required this.code,
    required this.name,
    required this.coverageStatus,
    required this.locatedCount,
    required this.sourceCount,
    this.manifestUrl,
  });

  final String code;
  final String name;
  final String coverageStatus;
  final int? locatedCount;
  final int? sourceCount;
  final String? manifestUrl;

  bool get available => coverageStatus != 'unavailable' && manifestUrl != null;
  bool get partial => coverageStatus == 'partial';

  static AddressPackCounty fromJson(Map<String, dynamic> json) {
    final code = json['county_code'];
    final name = json['county_name'];
    final status = json['coverage_status'];
    final manifest = json['manifest_url'];
    if (code is! String ||
        !RegExp(r'^\d{5}$').hasMatch(code) ||
        name is! String ||
        status is! String ||
        !{'complete', 'partial', 'unavailable'}.contains(status) ||
        (manifest != null && manifest is! String)) {
      throw const FormatException('門牌目錄縣市資料格式無效');
    }
    return AddressPackCounty(
      code: code,
      name: name,
      coverageStatus: status,
      locatedCount: _optionalInt(json['located_count']),
      sourceCount: _optionalInt(json['source_count']),
      manifestUrl: manifest as String?,
    );
  }
}

class AddressPackCatalog {
  const AddressPackCatalog({required this.counties, required this.attribution});

  final List<AddressPackCounty> counties;
  final String attribution;

  factory AddressPackCatalog.fromJson(Object? value) {
    if (value is! Map) throw const FormatException('門牌目錄不是 JSON 物件');
    final json = Map<String, dynamic>.from(value);
    final source = json['counties'];
    if (json['schema_version'] != 'address-pack-catalog-v1' ||
        source is! List ||
        source.length != 22) {
      throw const FormatException('門牌目錄版本或縣市數量不符');
    }
    final counties = source
        .map((entry) {
          if (entry is! Map) {
            throw const FormatException('門牌目錄縣市列格式無效');
          }
          return AddressPackCounty.fromJson(Map<String, dynamic>.from(entry));
        })
        .toList(growable: false);
    if (counties.map((county) => county.code).toSet().length != 22) {
      throw const FormatException('門牌目錄縣市代碼重複');
    }
    return AddressPackCatalog(
      counties: counties,
      attribution:
          json['attribution'] is String ? json['attribution'] as String : '',
    );
  }
}

class AddressPackDownloadResult {
  const AddressPackDownloadResult({
    required this.status,
    required this.records,
    this.message,
  });

  final String status;
  final List<TaiwanSearchEntry> records;
  final String? message;

  bool get ready => status == 'ready';
}

/// Retrieves signed county address packages and keeps their verified copy offline.
class OfflineAddressPackStore {
  OfflineAddressPackStore({MethodChannel? channel})
    : _channel = channel ?? _defaultChannel;

  static const MethodChannel _defaultChannel = MethodChannel(
    'com.resilientgeo.mesh/offline_map_assets',
  );
  final MethodChannel _channel;
  final Set<String> installedCountyCodes = <String>{};

  Future<AddressPackCatalog> loadCatalog() async {
    final raw =
        kIsWeb
            ? await loadWebAddressPackCatalog()
            : await _channel.invokeMethod<String>('getAddressPackCatalog');
    return AddressPackCatalog.fromJson(jsonDecode(raw ?? ''));
  }

  Future<List<TaiwanSearchEntry>> loadInstalledPacks() async {
    final raw =
        kIsWeb
            ? await loadWebInstalledAddressPacks()
            : await _channel.invokeMethod<String>('getInstalledAddressPacks');
    if (raw == null || raw.isEmpty) return const <TaiwanSearchEntry>[];
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      throw const FormatException('已安裝門牌資料格式無效');
    }
    final counties = decoded['counties'];
    installedCountyCodes
      ..clear()
      ..addAll(
        counties is List ? counties.whereType<String>() : const <String>[],
      );
    return const <TaiwanSearchEntry>[];
  }

  Future<AddressPackDownloadResult> downloadCounty(
    AddressPackCounty county, {
    bool allowMobileData = false,
  }) async {
    final raw =
        kIsWeb
            ? await downloadWebAddressPack(county.code)
            : await _channel.invokeMethod<String>(
              'downloadAddressPack',
              <String, Object?>{
                'countyCode': county.code,
                'allowMobileData': allowMobileData,
              },
            );
    if (raw == null || raw.isEmpty) {
      throw const FormatException('門牌資料下載沒有回應');
    }
    final decoded = jsonDecode(raw);
    if (decoded is! Map) throw const FormatException('門牌資料回應格式無效');
    final response = Map<String, dynamic>.from(decoded);
    final status = response['status'] as String? ?? 'ready';
    if (status != 'ready') {
      return AddressPackDownloadResult(
        status: status,
        records: const <TaiwanSearchEntry>[],
        message: response['message'] as String?,
      );
    }
    installedCountyCodes.add(county.code);
    return AddressPackDownloadResult(
      status: status,
      records: const <TaiwanSearchEntry>[],
    );
  }

  Future<List<TaiwanSearchEntry>> search(String query) async {
    if (!_looksLikeAddressQuery(query)) return const <TaiwanSearchEntry>[];
    final raw =
        kIsWeb
            ? await searchWebAddressPacks(query)
            : await _channel.invokeMethod<String>(
              'searchAddressPacks',
              <String, Object?>{'query': query},
            );
    if (raw == null || raw.isEmpty) return const <TaiwanSearchEntry>[];
    final decoded = jsonDecode(raw);
    if (decoded is! Map || decoded['results'] is! List) {
      throw const FormatException('門牌搜尋回應格式無效');
    }
    return _parseEntries(decoded['results'] as List);
  }

  Future<Map<String, dynamic>> progress(String countyCode) async {
    final raw =
        kIsWeb
            ? await loadWebAddressPackProgress(countyCode)
            : jsonEncode(
              await _channel.invokeMapMethod<String, Object?>(
                'getAddressPackProgress',
              ),
            );
    final decoded = jsonDecode(raw);
    if (decoded is! Map) return const <String, dynamic>{};
    return Map<String, dynamic>.from(decoded);
  }

  static List<TaiwanSearchEntry> _parseEntries(List records) => records
      .map((record) {
        if (record is! Map) {
          throw const FormatException('門牌資料記錄格式無效');
        }
        final json = Map<String, dynamic>.from(record);
        json.putIfAbsent('address', () => json['name']);
        return TaiwanSearchEntry.fromJson(json);
      })
      .toList(growable: false);
}

int? _optionalInt(Object? value) => value is num ? value.toInt() : null;

bool _looksLikeAddressQuery(String value) {
  final normalized = String.fromCharCodes(
    value.runes.map((rune) {
      if (rune >= 0xff10 && rune <= 0xff19) return rune - 0xfee0;
      if (rune == 0x53f0) return 0x81fa;
      return rune;
    }),
  );
  return RegExp(r'(?:[0-9]+)(?:巷|弄|號|樓|室)|[巷弄號樓室]').hasMatch(normalized);
}
