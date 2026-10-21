import 'dart:convert';

import 'package:flutter/services.dart';

class TaiwanAdministrativeArea {
  const TaiwanAdministrativeArea({
    required this.areaId,
    required this.level,
    required this.parentAreaId,
    required this.countyName,
    required this.townName,
  });

  final String areaId;
  final String level;
  final String? parentAreaId;
  final String countyName;
  final String? townName;

  bool get isCounty => level == 'county';
  bool get isTown => level == 'town';

  String get displayName => isCounty ? countyName : '$countyName $townName';
}

class TaiwanAdministrativeAreaDirectory {
  TaiwanAdministrativeAreaDirectory._({
    required this.sourceVersion,
    required List<TaiwanAdministrativeArea> areas,
  }) : areas = List<TaiwanAdministrativeArea>.unmodifiable(areas),
       _areasById = Map<String, TaiwanAdministrativeArea>.unmodifiable({
         for (final area in areas) area.areaId: area,
       });

  static const String assetPath =
      'assets/map/boundaries/taiwan-administrative-area-directory.json';
  static const String nationalAreaId = 'tw.national';
  static final RegExp _sourceVersionPattern = RegExp(r'^sha256:[0-9a-f]{64}$');
  static final RegExp _countyIdPattern = RegExp(r'^tw\.\d{5}$');
  static final RegExp _townIdPattern = RegExp(r'^tw\.\d{8}$');

  final String sourceVersion;
  final List<TaiwanAdministrativeArea> areas;
  final Map<String, TaiwanAdministrativeArea> _areasById;

  List<TaiwanAdministrativeArea> get counties =>
      List<TaiwanAdministrativeArea>.unmodifiable(
        areas.where((area) => area.isCounty),
      );

  List<TaiwanAdministrativeArea> get towns =>
      List<TaiwanAdministrativeArea>.unmodifiable(
        areas.where((area) => area.isTown),
      );

  static Future<TaiwanAdministrativeAreaDirectory> load({
    AssetBundle? bundle,
  }) async {
    final raw = await (bundle ?? rootBundle).loadString(assetPath);
    final directory = TaiwanAdministrativeAreaDirectory.fromJson(
      jsonDecode(raw),
    );
    if (directory.counties.length != 22 || directory.towns.length != 368) {
      throw const FormatException('Incomplete administrative area directory');
    }
    return directory;
  }

  factory TaiwanAdministrativeAreaDirectory.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('Invalid administrative area directory');
    }
    final json = Map<String, dynamic>.from(value);
    final version = json['source_version'];
    final rawAreas = json['areas'];
    if (json['schema_version'] != 'taiwan-area-directory-v1' ||
        json['coverage'] != 'TW' ||
        json['target_coordinate_system'] != 'EPSG:4326' ||
        version is! String ||
        !_sourceVersionPattern.hasMatch(version) ||
        json['area_count'] is! num ||
        rawAreas is! List ||
        (json['area_count'] as num).toInt() != rawAreas.length) {
      throw const FormatException('Invalid administrative area directory');
    }

    final areas = <TaiwanAdministrativeArea>[];
    final ids = <String>{};
    for (final rawArea in rawAreas) {
      if (rawArea is! Map) {
        throw const FormatException('Invalid administrative area entry');
      }
      final area = Map<String, dynamic>.from(rawArea);
      final areaId = area['area_id'];
      final level = area['level'];
      final parentAreaId = area['parent_area_id'];
      final countyName = area['county_name'];
      final townName = area['town_name'];
      final isCounty = level == 'county';
      final isTown = level == 'town';
      if (areaId is! String ||
          !(isCounty ? _countyIdPattern : _townIdPattern).hasMatch(areaId) ||
          (!isCounty && !isTown) ||
          !ids.add(areaId) ||
          countyName is! String ||
          countyName.trim().isEmpty ||
          (isCounty && (parentAreaId != null || townName != null)) ||
          (isTown &&
              (parentAreaId is! String ||
                  !_countyIdPattern.hasMatch(parentAreaId) ||
                  townName is! String ||
                  townName.trim().isEmpty))) {
        throw const FormatException('Invalid administrative area entry');
      }
      areas.add(
        TaiwanAdministrativeArea(
          areaId: areaId,
          level: level as String,
          parentAreaId: parentAreaId as String?,
          countyName: countyName,
          townName: townName as String?,
        ),
      );
    }

    final countyIds = <String>{
      for (final area in areas.where((area) => area.isCounty)) area.areaId,
    };
    if (areas.where((area) => area.isCounty).isEmpty ||
        areas.any(
          (area) => area.isTown && !countyIds.contains(area.parentAreaId),
        )) {
      throw const FormatException('Incomplete administrative area directory');
    }
    areas.sort((left, right) => left.areaId.compareTo(right.areaId));
    return TaiwanAdministrativeAreaDirectory._(
      sourceVersion: version,
      areas: areas,
    );
  }

  TaiwanAdministrativeArea? areaById(String areaId) => _areasById[areaId];

  List<TaiwanAdministrativeArea> childrenOf(String parentAreaId) =>
      List<TaiwanAdministrativeArea>.unmodifiable(
        areas.where((area) => area.parentAreaId == parentAreaId),
      );

  String? displayName(String areaId) => switch (areaId) {
    nationalAreaId => '全台灣',
    _ => _areasById[areaId]?.displayName,
  };

  String displayNames(Iterable<String> areaIds) {
    final ids = areaIds.toSet();
    if (ids.contains(nationalAreaId)) return '全台灣';
    final normalized = normalizeSelection(ids);
    final knownIds =
        normalized.toList()..sort(
          (left, right) => (displayName(left) ?? left).compareTo(
            displayName(right) ?? right,
          ),
        );
    final unknownIds =
        ids.where((id) => !_areasById.containsKey(id)).toList()..sort();
    return <String>[
      ...knownIds,
      ...unknownIds,
    ].map((id) => displayName(id) ?? id).join('、');
  }

  Set<String> normalizeSelection(Set<String> selectedIds) {
    if (selectedIds.contains(nationalAreaId)) {
      return const <String>{nationalAreaId};
    }
    final knownIds = selectedIds.where(_areasById.containsKey).toSet();
    final selectedCountyIds = <String>{
      for (final area in areas)
        if (area.isCounty && knownIds.contains(area.areaId)) area.areaId,
    };
    final normalized = <String>{
      for (final area in areas)
        if (knownIds.contains(area.areaId) &&
            !(area.isTown && selectedCountyIds.contains(area.parentAreaId)))
          area.areaId,
    };
    return Set<String>.unmodifiable(normalized);
  }
}
