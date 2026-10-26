import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/route_event_snapshot.dart';

void main() {
  final now = DateTime.utc(2030);
  test(
    'snapshot is independent of event order and ignores unrelated official data',
    () {
      final road = event('road', 'ROAD_STATUS');
      final shelter = event('shelter', 'SHELTER_STATUS');
      final original = RouteEventSnapshot([road, shelter], now);
      final replay = RouteEventSnapshot([
        shelter,
        event('weather', 'HEAT_WARNING'),
        road,
      ], now);
      expect(original.fingerprint, replay.fingerprint);
      expect(original.changeReason(replay), isNull);
    },
  );

  test('expiry and removals are detected from the captured state', () {
    final road = event(
      'road',
      'ROAD_STATUS',
      expires: now.add(const Duration(seconds: 5)),
    );
    final original = RouteEventSnapshot([road], now);
    expect(
      RouteEventSnapshot.nextExpiry([road], now),
      now.add(const Duration(seconds: 5)),
    );
    expect(
      original.changeReason(
        RouteEventSnapshot([road], now.add(const Duration(seconds: 5))),
      ),
      '事件到期',
    );
    expect(original.changeReason(RouteEventSnapshot([], now)), '道路狀態更新');
  });

  test('all live crowd warnings affect routing regardless of event type', () {
    final original = RouteEventSnapshot([], now);
    final crowd = event('report', 'OTHER', namespace: 'crowd.test');
    expect(original.changeReason(RouteEventSnapshot([crowd], now)), '民眾警示更新');
  });

  group('supply destination', () {
    final key = supplyEventKey(supply(1));

    test('ignores supply points unless one is the destination', () {
      final plain = RouteEventSnapshot([], now);
      expect(plain.changeReason(RouteEventSnapshot([supply(1)], now)), isNull);
      expect(
        RouteEventSnapshot(
          [supply(1)],
          now,
          destinationSupplyKey: key,
        ).changeReason(
          RouteEventSnapshot(
            [supply(1), supply(1, id: 'supply:other', status: 'EXHAUSTED')],
            now,
            destinationSupplyKey: key,
          ),
        ),
        isNull,
      );
    });

    test('a new version or a withdrawal of the destination is a change', () {
      final original = RouteEventSnapshot(
        [supply(1)],
        now,
        destinationSupplyKey: key,
      );
      expect(
        original.changeReason(
          RouteEventSnapshot(
            [supply(2, status: 'EXHAUSTED')],
            now,
            destinationSupplyKey: key,
          ),
        ),
        '物資狀態更新',
      );
      expect(
        original.changeReason(
          RouteEventSnapshot([], now, destinationSupplyKey: key),
        ),
        '物資狀態更新',
      );
    });

    test('the destination expiry is watched and detected', () {
      final expiring = supply(1, expires: now.add(const Duration(seconds: 5)));
      expect(RouteEventSnapshot.nextExpiry([expiring], now), isNull);
      expect(
        RouteEventSnapshot.nextExpiry(
          [expiring],
          now,
          destinationSupplyKey: key,
        ),
        now.add(const Duration(seconds: 5)),
      );
      expect(
        RouteEventSnapshot(
          [expiring],
          now,
          destinationSupplyKey: key,
        ).changeReason(
          RouteEventSnapshot(
            [expiring],
            now.add(const Duration(seconds: 5)),
            destinationSupplyKey: key,
          ),
        ),
        '事件到期',
      );
    });
  });
}

MeshEvent supply(
  int version, {
  String id = 'supply:test',
  String status = 'AVAILABLE',
  DateTime? expires,
}) => MeshEvent(
  namespace: 'official.supply',
  eventId: id,
  eventVersion: version,
  eventType: 'SUPPLY_STATUS',
  severity: 'LOW',
  source: 'GOVERNMENT',
  issuedAt: null,
  expiresAt: (expires ?? DateTime.utc(2099)).toIso8601String(),
  applyState: 'CURRENT',
  geometry: const PointGeometry(GeoPoint(longitude: 121.59, latitude: 25.08)),
  attributes: <String, dynamic>{'status': status},
  payloadHash: 'sha256:$id:$version',
);

MeshEvent event(
  String id,
  String type, {
  String namespace = 'official',
  DateTime? expires,
}) => MeshEvent(
  namespace: namespace,
  eventId: id,
  eventVersion: 1,
  eventType: type,
  severity: 'HIGH',
  source: 'test',
  issuedAt: null,
  expiresAt: expires?.toIso8601String(),
  applyState: 'CURRENT',
  geometry: null,
  attributes: null,
);
