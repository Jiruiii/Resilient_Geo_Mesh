import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/supply_status.dart';

MeshEvent supply({
  Object? quantity,
  String state = 'CURRENT',
  String? expires,
}) => MeshEvent.fromJson({
  'namespace': 'drill.exercise',
  'event_id': 'supply:one',
  'event_version': 1,
  'event_type': 'SUPPLY_STATUS',
  'apply_state': state,
  'expires_at':
      expires ??
      DateTime.now().add(const Duration(hours: 1)).toUtc().toIso8601String(),
  'attributes': {
    'exercise': true,
    'status': 'AVAILABLE',
    'quantity': quantity,
    'items': [],
  },
});
void main() {
  test(
    'unknown inventory and empty item list remain explicit, while zero is valid',
    () {
      expect(SupplyStatus(supply()).quantity, '未知');
      expect(SupplyStatus(supply(quantity: 0)).quantity, '0 份');
      expect(SupplyStatus(supply(quantity: -1)).quantity, '未知');
      expect(SupplyStatus(supply(quantity: '20')).quantity, '未知');
      expect(SupplyStatus(supply()).items, '物資種類未知');
      expect(SupplyStatus(supply()).drill, isTrue);
    },
  );
  test('expired or unverified supply never claims available stock', () {
    for (final event in [
      supply(quantity: 20, state: 'UNVERIFIED'),
      supply(quantity: 20, expires: '2020-01-01T00:00:00Z'),
    ]) {
      expect(SupplyStatus(event).quantity, '未知');
      expect(SupplyStatus(event).statusAt(), contains('狀態未知'));
    }
    expect(SupplyStatus(supply()).statusAt(), '供應中');
  });
  test('supply layer toggles independently from disaster incidents', () {
    final supplies = supply();
    final road = MeshEvent.fromJson({
      'event_type': 'ROAD_STATUS',
      'event_id': 'road:one',
    });
    final officialStation = MeshEvent.fromJson({
      'namespace': 'official.announcement',
      'source': 'GOVERNMENT',
      'event_type': 'GOVERNMENT_ANNOUNCEMENT',
      'event_id': 'announcement:supply',
      'attributes': {'category': 'SUPPLY_STATION'},
    });
    final citizenReport = MeshEvent.fromJson({
      'namespace': 'crowd.reports',
      'source': 'CITIZEN',
      'event_type': 'CROWD_REPORT',
      'event_id': 'report:one',
      'attributes': {'category': 'SUPPLY_STATION'},
    });
    final events = [supplies, road, officialStation, citizenReport];
    expect(filterMapEventLayers(events, incidents: false, supplies: true), [
      supplies,
      officialStation,
    ]);
    expect(filterMapEventLayers(events, incidents: true, supplies: false), [
      road,
      citizenReport,
    ]);
    expect(
      filterMapEventLayers(events, incidents: false, supplies: false),
      isEmpty,
    );
  });
}
