import 'map_models.dart';

const double taiwanSearchMinLongitude = 118.0;
const double taiwanSearchMaxLongitude = 122.2;
const double taiwanSearchMinLatitude = 21.8;
const double taiwanSearchMaxLatitude = 26.5;

/// One locally bundled searchable road or place entry.
class TaiwanSearchEntry {
  const TaiwanSearchEntry({
    required this.id,
    required this.name,
    required this.aliases,
    required this.kind,
    required this.region,
    required this.coordinate,
    this.address,
    this.searchKey,
  });

  final String id;
  final String name;
  final List<String> aliases;
  final String kind;
  final String? region;
  final GeoPoint coordinate;
  final String? address;
  final String? searchKey;

  factory TaiwanSearchEntry.fromJson(Map<String, dynamic> json) {
    final id = _requiredString(json, 'id');
    final name = _requiredString(json, 'name');
    final kind = _requiredString(json, 'kind');
    final aliasesValue = json['aliases'];
    if (aliasesValue is! List) {
      throw const FormatException('search entry aliases must be an array');
    }
    final aliases = <String>[];
    for (final alias in aliasesValue) {
      if (alias is! String || alias.trim().isEmpty) {
        throw const FormatException('search entry aliases must be strings');
      }
      aliases.add(alias.trim());
    }

    final coordinate = _coordinateFromJson(json['coordinate']);
    if (coordinate == null) {
      throw const FormatException(
        'search entry coordinate must be [longitude, latitude] in Taiwan',
      );
    }
    final regionValue = json['region'];
    if (regionValue != null && regionValue is! String) {
      throw const FormatException('search entry region must be a string');
    }
    final region =
        regionValue is String && regionValue.trim().isNotEmpty
            ? regionValue.trim()
            : null;
    final addressValue = json['address'];
    if (addressValue != null && addressValue is! String) {
      throw const FormatException('search entry address must be a string');
    }
    final searchKeyValue = json['search_key'];
    if (searchKeyValue != null && searchKeyValue is! String) {
      throw const FormatException('search_key must be a string');
    }

    return TaiwanSearchEntry(
      id: id,
      name: name,
      aliases: List<String>.unmodifiable(aliases),
      kind: kind,
      region: region,
      coordinate: coordinate,
      address:
          addressValue is String && addressValue.trim().isNotEmpty
              ? addressValue.trim()
              : null,
      searchKey:
          searchKeyValue is String && searchKeyValue.trim().isNotEmpty
              ? searchKeyValue.trim()
              : null,
    );
  }
}

/// Versioned metadata and entries for the offline Taiwan search index.
class TaiwanSearchAsset {
  const TaiwanSearchAsset({
    required this.schemaVersion,
    required this.datasetId,
    required this.snapshotAt,
    required this.sourceUrl,
    required this.sourceSha256,
    required this.attribution,
    required this.entries,
  });

  final String schemaVersion;
  final String datasetId;
  final String snapshotAt;
  final String sourceUrl;
  final String sourceSha256;
  final String attribution;
  final List<TaiwanSearchEntry> entries;

  factory TaiwanSearchAsset.fromJson(Map<String, dynamic> json) {
    final entriesValue = json['entries'];
    if (entriesValue is! List) {
      throw const FormatException(
        'Taiwan search asset entries must be an array',
      );
    }

    final sourceSha256 = _requiredString(json, 'source_sha256');
    if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(sourceSha256)) {
      throw const FormatException(
        'source_sha256 must be a 64-character hex digest',
      );
    }

    final entries = <TaiwanSearchEntry>[];
    for (final entry in entriesValue) {
      if (entry is! Map) {
        throw const FormatException(
          'Taiwan search asset entry must be an object',
        );
      }
      entries.add(TaiwanSearchEntry.fromJson(Map<String, dynamic>.from(entry)));
    }

    return TaiwanSearchAsset(
      schemaVersion: _requiredString(json, 'schema_version'),
      datasetId: _requiredString(json, 'dataset_id'),
      snapshotAt: _requiredString(json, 'snapshot_at'),
      sourceUrl: _requiredString(json, 'source_url'),
      sourceSha256: sourceSha256,
      attribution: _requiredString(json, 'attribution'),
      entries: List<TaiwanSearchEntry>.unmodifiable(entries),
    );
  }
}

/// Parses latitude-first user input such as `25.011549, 121.545053`.
GeoPoint? parseTaiwanCoordinate(String text) {
  final parts = text.trim().split(RegExp(r'[\s,]+'));
  if (parts.length != 2) return null;
  final latitude = double.tryParse(parts[0]);
  final longitude = double.tryParse(parts[1]);
  if (latitude == null || longitude == null) return null;
  if (!latitude.isFinite || !longitude.isFinite) return null;
  if (longitude < taiwanSearchMinLongitude ||
      longitude > taiwanSearchMaxLongitude ||
      latitude < taiwanSearchMinLatitude ||
      latitude > taiwanSearchMaxLatitude) {
    return null;
  }
  return GeoPoint(longitude: longitude, latitude: latitude);
}

String _requiredString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('$key must be a non-empty string');
  }
  return value.trim();
}

GeoPoint? _coordinateFromJson(Object? value) {
  if (value is! List || value.length != 2) return null;
  final longitude = _finiteDouble(value[0]);
  final latitude = _finiteDouble(value[1]);
  if (longitude == null || latitude == null) return null;
  if (longitude < taiwanSearchMinLongitude ||
      longitude > taiwanSearchMaxLongitude ||
      latitude < taiwanSearchMinLatitude ||
      latitude > taiwanSearchMaxLatitude) {
    return null;
  }
  return GeoPoint(longitude: longitude, latitude: latitude);
}

double? _finiteDouble(Object? value) {
  final number = value is num ? value.toDouble() : double.tryParse('$value');
  return number != null && number.isFinite ? number : null;
}
