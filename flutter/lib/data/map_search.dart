import 'dart:math' as math;
import 'dart:typed_data';

import 'map_models.dart';
import 'map_administrative.dart';
import 'map_search_asset.dart';

class MapSearchResult {
  const MapSearchResult({
    required this.feature,
    required this.title,
    required this.typeLabel,
    required this.coordinate,
    this.region,
    this.address,
    this.resultId,
    this.searchKind,
  });

  final StaticFeature? feature;
  final String title;
  final String typeLabel;
  final GeoPoint? coordinate;
  final String? region;
  final String? address;
  final String? resultId;
  final String? searchKind;

  String? get id => feature?.id ?? resultId;

  /// Includes a locally inferred administrative context for road results.
  /// It is a display label, not an authoritative street address.
  String get displayTitle {
    final isRoad = searchKind == 'road' || feature?.kind == 'road';
    final context = region?.trim();
    if (!isRoad || context == null || context.isEmpty) return title;
    if (title.startsWith(context)) return title;
    return '$context・$title';
  }
}

class MapSearchQuery {
  const MapSearchQuery({
    required this.input,
    required this.results,
    this.coordinate,
  });

  final String input;
  final List<MapSearchResult> results;
  final GeoPoint? coordinate;

  bool get isCoordinate => coordinate != null;
}

/// Synchronous index over bundled map features. It has no network dependency.
class MapSearchIndex {
  MapSearchIndex(
    List<StaticFeature> features, {
    Iterable<TaiwanSearchEntry> roadEntries = const <TaiwanSearchEntry>[],
    Iterable<TaiwanSearchEntry> addressEntries = const <TaiwanSearchEntry>[],
    Iterable<MapAdministrativeArea> administrativeAreas =
        const <MapAdministrativeArea>[],
    bool indexedRoadSearch = true,
  }) : _features = List<StaticFeature>.unmodifiable(
         features.any((feature) => feature.kind == 'medical-directory')
             ? features.where((feature) => feature.kind != 'medical')
             : features,
       ),
       _roadSource = roadEntries,
       _addressSource = addressEntries,
       _indexedRoadSearch = indexedRoadSearch,
       _roadEntries = List<TaiwanSearchEntry>.unmodifiable(roadEntries),
       _addressEntries = List<TaiwanSearchEntry>.unmodifiable(addressEntries),
       _administrativeAreas = List<MapAdministrativeArea>.unmodifiable(
         administrativeAreas,
       );

  static const int maxResults = 8;

  final List<StaticFeature> _features;
  final List<TaiwanSearchEntry> _roadEntries;
  final List<TaiwanSearchEntry> _addressEntries;
  final Iterable<TaiwanSearchEntry> _roadSource;
  final Iterable<TaiwanSearchEntry> _addressSource;
  final bool _indexedRoadSearch;
  final Map<GeoPoint, String?> _contextCache = {};
  late final _RoadSearchLookup _roadLookup =
      _roadLookups[_roadSource] ??= _RoadSearchLookup(_roadEntries);
  late final _RoadSearchLookup _addressLookup =
      _addressLookups[_addressSource] ??= _RoadSearchLookup(
        _addressEntries,
        addressMode: true,
      );
  final List<MapAdministrativeArea> _administrativeAreas;

  /// Called by the background worker before accepting queries.
  void prepare() {
    if (_indexedRoadSearch) _roadLookup;
    _addressLookup;
    for (final feature in _features) {
      _featureText(feature);
    }
  }

  late final MapAdministrativeIndex _administrativeLabelIndex =
      MapAdministrativeIndex(
        counties: _administrativeAreas
            .where((area) => area.level == MapAdministrativeLevel.county)
            .toList(growable: false),
        subdivisions: _administrativeAreas
            .where((area) => area.level == MapAdministrativeLevel.subdivision)
            .toList(growable: false),
        villages: _administrativeAreas
            .where((area) => area.level == MapAdministrativeLevel.village)
            .toList(growable: false),
      );
  late final List<String> _contextLabels = [
    for (final area in _administrativeAreas)
      _normalizeText(
        area.parent != null && !area.displayName.startsWith(area.parent!)
            ? '${area.parent}${area.displayName}'
            : area.displayName,
      ),
  ];

  MapSearchQuery search(String text) {
    final input = text.trim();
    final normalized = _normalizeText(input);
    if (normalized.isEmpty) {
      return MapSearchQuery(input: input, results: const <MapSearchResult>[]);
    }

    if (_looksLikeCoordinateQuery(input)) {
      final coordinate = parseTaiwanCoordinate(input);
      if (coordinate == null) {
        return MapSearchQuery(input: input, results: const <MapSearchResult>[]);
      }
      final result = MapSearchResult(
        feature: null,
        title: input,
        typeLabel: '經緯度',
        coordinate: coordinate,
        resultId: 'coordinate:${coordinate.latitude},${coordinate.longitude}',
      );
      return MapSearchQuery(
        input: input,
        coordinate: coordinate,
        results: <MapSearchResult>[result],
      );
    }

    final requestedArea = _requestedAdministrativeAreaFor(normalized);
    final matches = <_RankedResult>[];
    final contextAffectsRanking = _contextLabels.any(
      (label) => label.length >= 2 && normalized.contains(label),
    );
    void collect(_RankedResult match) {
      if (matches.length == maxResults &&
          _compareRankedResults(match, matches.last) >= 0) {
        return;
      }
      matches.add(match);
      matches.sort(_compareRankedResults);
      if (matches.length > maxResults) matches.removeLast();
    }

    for (var index = 0; index < _features.length; index += 1) {
      final feature = _features[index];
      final score = _featureMatchScore(feature, normalized);
      if (score == null) continue;
      final coordinate = _focusCoordinate(feature.geometry);
      if (coordinate == null && feature.kind != 'medical-directory') continue;
      collect(
        _RankedResult(
          score: score,
          sourceIndex: index,
          result: MapSearchResult(
            feature: feature,
            title: _titleFor(feature),
            typeLabel:
                feature.kind == 'medical-directory' &&
                        feature.details['geometry_status'] != 'located'
                    ? '醫療院所（尚未定位）'
                    : _typeLabelFor(feature.kind),
            coordinate: coordinate,
            region: _regionFor(feature),
            address: _addressFor(feature),
          ),
        ),
      );
    }

    final roadCandidates =
        _indexedRoadSearch
            ? _roadLookup.candidates(normalized)
            : Iterable<int>.generate(_roadEntries.length);
    for (final index in roadCandidates) {
      final entry = _roadEntries[index];
      final text =
          _indexedRoadSearch ? _roadLookup.texts[index] : _entryText(entry);
      final baseScore = _entryMatchScore(text, normalized);
      if (baseScore == null) continue;
      final nameMatches = baseScore <= 3;
      final region =
          entry.region ??
          (nameMatches && contextAffectsRanking
              ? _administrativeContextFor(entry.coordinate)
              : null);
      final score = _prioritizedEntryScore(
        nameMatches,
        normalized,
        baseScore,
        region,
      );
      final sourceIndex = _features.length + index;
      final proximity =
          requestedArea != null && nameMatches
              ? _distanceSquared(entry.coordinate, requestedArea.point)
              : null;
      if (matches.length == maxResults) {
        final last = matches.last;
        var order = score.compareTo(last.score);
        if (order == 0 && proximity != null && last.proximity != null) {
          order = proximity.compareTo(last.proximity!);
        }
        if (order == 0) order = sourceIndex.compareTo(last.sourceIndex);
        if (order >= 0) continue;
      }
      collect(
        _RankedResult(
          score: score,
          sourceIndex: sourceIndex,
          inferRegion:
              entry.region == null && nameMatches && !contextAffectsRanking,
          proximity: proximity,
          result: MapSearchResult(
            feature: null,
            title: entry.name,
            typeLabel: _typeLabelFor(entry.kind),
            coordinate: entry.coordinate,
            region: region,
            resultId: entry.id,
            searchKind: entry.kind,
          ),
        ),
      );
    }

    if (_looksLikeAddressQuery(input)) {
      final addressQuery = _normalizeAddressQuery(input);
      for (final index in _addressLookup.candidates(addressQuery)) {
        final entry = _addressEntries[index];
        final text = _addressEntryText(entry);
        final score = _addressMatchScore(text, addressQuery);
        if (score == null) continue;
        collect(
          _RankedResult(
            score: score,
            sourceIndex: _features.length + _roadEntries.length + index,
            result: MapSearchResult(
              feature: null,
              title: entry.name,
              typeLabel: '門牌位置',
              coordinate: entry.coordinate,
              region: entry.region,
              address: entry.address ?? entry.name,
              resultId: entry.id,
              searchKind: 'address',
            ),
          ),
        );
      }
    }

    for (var index = 0; index < _administrativeAreas.length; index += 1) {
      final area = _administrativeAreas[index];
      final score = _administrativeMatchScore(area, normalized);
      if (score == null) continue;
      collect(
        _RankedResult(
          score: score,
          sourceIndex: _features.length + _roadEntries.length + index,
          result: MapSearchResult(
            feature: null,
            title: area.displayName,
            typeLabel: _administrativeTypeLabel(area.level),
            coordinate: area.point,
            region: area.parent,
            resultId: area.key,
            searchKind: area.level.name,
          ),
        ),
      );
    }

    return MapSearchQuery(
      input: input,
      results: matches
          .take(maxResults)
          .map((match) {
            final result = match.result;
            if (!match.inferRegion) return result;
            return MapSearchResult(
              feature: result.feature,
              title: result.title,
              typeLabel: result.typeLabel,
              coordinate: result.coordinate,
              region:
                  result.coordinate == null
                      ? result.region
                      : _administrativeContextFor(result.coordinate!),
              address: result.address,
              resultId: result.resultId,
              searchKind: result.searchKind,
            );
          })
          .toList(growable: false),
    );
  }

  List<MapSearchResult> query(String text) => search(text).results;

  String? _administrativeContextFor(GeoPoint point) {
    if (_administrativeAreas.isEmpty) return null;
    if (_contextCache.containsKey(point)) return _contextCache[point];
    return _contextCache[point] = _administrativeLabelIndex.contextLabelFor(
      point,
    );
  }

  MapAdministrativeArea? _requestedAdministrativeAreaFor(String query) {
    MapAdministrativeArea? bestMatch;
    var bestScore = -1;
    for (final area in _administrativeAreas) {
      final name = _normalizeText(area.name);
      if (name.length < 2 || !query.contains(name)) continue;

      final parent = _normalizeText(area.parent);
      final parentMatches = parent.isNotEmpty && query.contains(parent);
      final levelScore = switch (area.level) {
        MapAdministrativeLevel.county => 1,
        MapAdministrativeLevel.subdivision => 2,
        MapAdministrativeLevel.village => 3,
      };
      final score =
          (parentMatches ? 10000 : 0) + (levelScore * 100) + name.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = area;
      }
    }
    return bestMatch;
  }
}

int? _featureMatchScore(StaticFeature feature, String query) {
  final text = _featureText(feature);
  return _matchScore(
    name: text.name,
    aliases: text.aliases,
    region: text.region,
    address: text.address,
    details: text.details,
    kind: text.kind,
    id: text.id,
    query: query,
  );
}

int? _entryMatchScore(_SearchText text, String query) {
  final sourceRegion = text.region;
  final score = _matchScore(
    name: text.name,
    aliases: text.aliases,
    region: sourceRegion,
    address: '',
    details: '',
    kind: text.kind,
    id: text.id,
    query: query,
  );
  if (score == null) return null;

  // A source region alone may match an administrative part of a longer
  // address, but it must not make every road in that region a result.
  if (score == 4 && sourceRegion != query) {
    return null;
  }
  return score;
}

int _prioritizedEntryScore(
  bool nameMatches,
  String query,
  int baseScore,
  String? displayRegion,
) {
  final normalizedRegion = _normalizeText(displayRegion);
  // If the user supplied the local context, prefer same-name roads in that
  // context over same-name roads elsewhere in the bundled index. The name
  // match was already checked before this context was derived.
  if (normalizedRegion.length >= 2 &&
      query.contains(normalizedRegion) &&
      nameMatches &&
      baseScore > 1) {
    return 1;
  }
  return baseScore;
}

int? _administrativeMatchScore(MapAdministrativeArea area, String query) =>
    _matchScore(
      name: _normalizeText(area.displayName),
      aliases: <String>[area.name].map(_normalizeText),
      region: _normalizeText(area.parent),
      address: '',
      details: '',
      kind: _normalizeText(area.level.name),
      id: _normalizeText(area.key),
      query: query,
    );

int? _matchScore({
  required String name,
  required Iterable<String> aliases,
  required String region,
  required String address,
  required String details,
  required String kind,
  required String id,
  required String query,
}) {
  if (name == query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.contains(query)) return 2;
  if (name.length >= 2 && query.contains(name)) return 2;
  if (aliases.any((value) => value == query || value.contains(query))) {
    return 3;
  }
  if (aliases.any((value) => value.length >= 2 && query.contains(value))) {
    return 3;
  }
  if (region.contains(query)) return 4;
  if (region.length >= 2 && query.contains(region)) return 4;
  if (address.contains(query) || details.contains(query)) return 5;
  if (kind.contains(query)) return 6;
  if (id.contains(query)) return 7;
  return null;
}

final _whitespace = RegExp(r'\s+');
final _entryTexts = Expando<_SearchText>();
final _addressEntryTexts = Expando<_SearchText>();
final _featureTexts = Expando<_SearchText>();
final _roadLookups = Expando<_RoadSearchLookup>();
final _addressLookups = Expando<_RoadSearchLookup>();

/// Compact postings narrow substring searches without changing final ranking.
/// Reverse containment (a road name inside an address) uses full field keys.
/// The worker shares this immutable lookup when facilities/areas are updated.
class _RoadSearchLookup {
  _RoadSearchLookup(List<TaiwanSearchEntry> entries, {bool addressMode = false})
    : count = entries.length,
      _addressMode = addressMode {
    final grams = <String, List<int>>{};
    final reverse = <String, List<int>>{};
    if (addressMode) {
      texts = const <_SearchText>[];
      for (var index = 0; index < entries.length; index++) {
        final entry = entries[index];
        final fields = <String>[
          entry.searchKey ??
              _normalizeAddressQuery(entry.address ?? entry.name),
          ...entry.aliases.map(_normalizeAddressQuery),
        ];
        final seen = <String>{};
        for (final field in fields) {
          for (var start = 0; start + 1 < field.length; start += 3) {
            seen.add(field.substring(start, start + 2));
          }
        }
        for (final gram in seen) {
          (grams[gram] ??= <int>[]).add(index);
        }
      }
      postings = grams.map(
        (key, ids) => MapEntry(key, Uint32List.fromList(ids)),
      );
      reverseFields = const <String, Uint32List>{};
    } else {
      texts = entries.map(_entryText).toList(growable: false);
      for (var index = 0; index < entries.length; index++) {
        final text = texts[index];
        final fields = <String>[
          text.name,
          ...text.aliases,
          text.region,
          text.kind,
          text.id,
        ];
        final seen = <String>{};
        for (final field in fields) {
          for (var i = 0; i < field.length; i++) {
            seen.add(field.substring(i, i + 1));
            if (i + 1 < field.length) seen.add(field.substring(i, i + 2));
          }
        }
        for (final gram in seen) {
          (grams[gram] ??= <int>[]).add(index);
        }
        for (final field in {text.name, ...text.aliases, text.region}) {
          if (field.length < 2) continue;
          if (field.length > maxReverseLength) maxReverseLength = field.length;
          (reverse[field] ??= <int>[]).add(index);
        }
      }
      postings = grams.map(
        (key, ids) => MapEntry(key, Uint32List.fromList(ids)),
      );
      reverseFields = reverse.map(
        (key, ids) => MapEntry(key, Uint32List.fromList(ids)),
      );
    }
  }

  final int count;
  final bool _addressMode;
  late final List<_SearchText> texts;
  int maxReverseLength = 0;
  late final Map<String, Uint32List> postings;
  late final Map<String, Uint32List> reverseFields;

  Iterable<int> candidates(String query) {
    if (_addressMode) {
      if (query.length < 2) return const <int>[];
      final grams = <String>{};
      for (var start = 0; start + 1 < query.length; start += 3) {
        grams.add(query.substring(start, start + 2));
      }
      Uint32List? smallest;
      final available = <Uint32List>[];
      for (final gram in grams) {
        final posting = postings[gram];
        if (posting == null) return const <int>[];
        available.add(posting);
        if (smallest == null || posting.length < smallest.length) {
          smallest = posting;
        }
      }
      if (smallest == null) return const <int>[];
      return <int>[
        for (final candidate in smallest)
          if (available.every(
            (posting) =>
                identical(posting, smallest) ||
                _containsSorted(posting, candidate),
          ))
            candidate,
      ];
    }
    // Preserve one-character and UTF-16 matching semantics of the old scan.
    if (query.length < 2) return postings[query] ?? const <int>[];
    Uint32List? smallest;
    for (var i = 0; i + 1 < query.length; i++) {
      final posting = postings[query.substring(i, i + 2)];
      if (posting == null) {
        smallest = null;
        break;
      }
      if (smallest == null || posting.length < smallest.length) {
        smallest = posting;
      }
    }
    final candidates = <int>{...?smallest};
    for (var start = 0; start + 1 < query.length; start++) {
      final endLimit = math.min(query.length, start + maxReverseLength);
      for (var end = start + 2; end <= endLimit; end++) {
        final matches = reverseFields[query.substring(start, end)];
        if (matches != null) candidates.addAll(matches);
      }
    }
    return candidates.toList()..sort();
  }
}

class _SearchText {
  const _SearchText(
    this.name,
    this.aliases,
    this.region,
    this.address,
    this.details,
    this.kind,
    this.id,
  );
  final String name, region, address, details, kind, id;
  final List<String> aliases;
}

_SearchText _entryText(TaiwanSearchEntry entry) =>
    _entryTexts[entry] ??= _SearchText(
      _normalizeText(entry.name),
      entry.aliases.map(_normalizeText).toList(growable: false),
      _normalizeText(entry.region),
      '',
      '',
      _normalizeText(entry.kind),
      _normalizeText(entry.id),
    );

_SearchText _addressEntryText(TaiwanSearchEntry entry) =>
    _addressEntryTexts[entry] ??= _SearchText(
      entry.searchKey ?? _normalizeAddressQuery(entry.address ?? entry.name),
      entry.aliases.map(_normalizeAddressQuery).toList(growable: false),
      _normalizeAddressQuery(entry.region),
      _normalizeAddressQuery(entry.address ?? entry.name),
      '',
      'address',
      _normalizeAddressQuery(entry.id),
    );

bool _containsSorted(Uint32List values, int target) {
  var low = 0;
  var high = values.length;
  while (low < high) {
    final middle = low + ((high - low) >> 1);
    final value = values[middle];
    if (value == target) return true;
    if (value < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return false;
}

_SearchText _featureText(StaticFeature feature) =>
    _featureTexts[feature] ??= _SearchText(
      _searchText(feature.details['name']),
      _stringValues(feature.details['aliases']),
      _searchText(_regionFor(feature)),
      _searchText(_addressFor(feature)),
      _searchText(feature.details),
      _searchText(feature.kind),
      _searchText(feature.id),
    );

String _normalizeText(Object? value) {
  if (value == null) return '';
  return value.toString().toLowerCase().replaceAll(_whitespace, ' ').trim();
}

String _normalizeAddressQuery(Object? value) {
  if (value == null) return '';
  final normalized = StringBuffer();
  for (final rune in value.toString().runes) {
    if (rune == 0x3000 || rune == 0x20 || (rune >= 0x09 && rune <= 0x0d)) {
      continue;
    }
    if (rune >= 0xff10 && rune <= 0xff19) {
      normalized.writeCharCode(rune - 0xfee0);
    } else if (rune == 0xff0c || rune == 0x3001) {
      continue;
    } else {
      normalized.writeCharCode(rune);
    }
  }
  return normalized.toString().replaceAll('台', '臺').toLowerCase();
}

bool _looksLikeAddressQuery(String value) => RegExp(
  r'(?:[0-9]+)(?:巷|弄|號|樓|室|之)|[巷弄號樓室]',
).hasMatch(_normalizeAddressQuery(value));

int? _addressMatchScore(_SearchText text, String query) {
  if (query.isEmpty) return null;
  if (text.name == query) return 0;
  if (text.name.startsWith(query)) return 1;
  if (text.name.contains(query)) return 2;
  if (text.aliases.any((alias) => alias == query || alias.contains(query))) {
    return 3;
  }
  return null;
}

String _searchText(Object? value) {
  if (value is Iterable) return value.map(_searchText).join(' ');
  if (value is Map) return value.values.map(_searchText).join(' ');
  return _normalizeText(value);
}

List<String> _stringValues(Object? value) {
  if (value is! Iterable) return const <String>[];
  return value.map(_normalizeText).where((value) => value.isNotEmpty).toList();
}

String _titleFor(StaticFeature feature) {
  final name = feature.details['name'];
  if (name is String && name.trim().isNotEmpty) return name.trim();
  return feature.id ?? _typeLabelFor(feature.kind);
}

String _typeLabelFor(String? kind) => switch (kind) {
  'medical' => '醫療院所',
  'medical-directory' => '醫療院所',
  'shelter' => '避難所',
  'road' => '道路',
  'address' => '門牌位置',
  _ => kind ?? '其他',
};

String _administrativeTypeLabel(MapAdministrativeLevel level) =>
    switch (level) {
      MapAdministrativeLevel.county => '縣市',
      MapAdministrativeLevel.subdivision => '行政區',
      MapAdministrativeLevel.village => '里',
    };

String? _regionFor(StaticFeature feature) {
  for (final key in <String>[
    'administrative_area',
    'region',
    'county',
    'city',
    'district',
  ]) {
    final value = feature.details[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

String? _addressFor(StaticFeature feature) {
  final value = feature.details['address'];
  return value is String && value.trim().isNotEmpty ? value.trim() : null;
}

bool _looksLikeCoordinateQuery(String text) {
  if (text.contains(',')) return true;
  final parts = text.split(RegExp(r'\s+'));
  return parts.length == 2 &&
      parts.every((part) => double.tryParse(part) != null);
}

GeoPoint? _focusCoordinate(MapGeometry? geometry) {
  final points = switch (geometry) {
    PointGeometry(:final point) => <GeoPoint>[point],
    LineStringGeometry(:final points) => points,
    PolygonGeometry(:final rings) => rings.expand((ring) => ring).toList(),
    _ => const <GeoPoint>[],
  };
  if (points.isEmpty) return null;

  var minLongitude = points.first.longitude;
  var maxLongitude = points.first.longitude;
  var minLatitude = points.first.latitude;
  var maxLatitude = points.first.latitude;
  for (final point in points.skip(1)) {
    minLongitude =
        point.longitude < minLongitude ? point.longitude : minLongitude;
    maxLongitude =
        point.longitude > maxLongitude ? point.longitude : maxLongitude;
    minLatitude = point.latitude < minLatitude ? point.latitude : minLatitude;
    maxLatitude = point.latitude > maxLatitude ? point.latitude : maxLatitude;
  }
  return GeoPoint(
    longitude: (minLongitude + maxLongitude) / 2,
    latitude: (minLatitude + maxLatitude) / 2,
  );
}

class _RankedResult {
  const _RankedResult({
    required this.score,
    required this.sourceIndex,
    required this.result,
    this.proximity,
    this.inferRegion = false,
  });

  final int score;
  final int sourceIndex;
  final MapSearchResult result;
  final double? proximity;
  final bool inferRegion;
}

int _compareRankedResults(_RankedResult left, _RankedResult right) {
  final scoreOrder = left.score.compareTo(right.score);
  if (scoreOrder != 0) return scoreOrder;
  if (left.proximity != null && right.proximity != null) {
    final order = left.proximity!.compareTo(right.proximity!);
    if (order != 0) return order;
  }
  final sourceOrder = left.sourceIndex.compareTo(right.sourceIndex);
  if (sourceOrder != 0) return sourceOrder;
  return (left.result.id ?? '').compareTo(right.result.id ?? '');
}

double _distanceSquared(GeoPoint left, GeoPoint right) {
  final latitudeRadians =
      ((left.latitude + right.latitude) / 2) * math.pi / 180;
  final longitudeDelta =
      (left.longitude - right.longitude) * math.cos(latitudeRadians);
  final latitudeDelta = left.latitude - right.latitude;
  return (longitudeDelta * longitudeDelta) + (latitudeDelta * latitudeDelta);
}
