import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';

RescueTriage _triage({
  TriageAnswer immobile = TriageAnswer.no,
  TriageAnswer breathing = TriageAnswer.no,
  TriageAnswer bleeding = TriageAnswer.no,
  TriageAnswer conscious = TriageAnswer.yes,
}) => RescueTriage(
  immobile: immobile,
  breathingDifficulty: breathing,
  severeBleeding: bleeding,
  conscious: conscious,
);

Map<String, dynamic> _fixture() => jsonDecode(
  File('../fixtures/rescue-requests-v0.json').readAsStringSync(),
) as Map<String, dynamic>;

MeshEvent _fixtureEvent(String name) {
  final cases = (_fixture()['event_cases'] as List).cast<Map<String, dynamic>>();
  final event = Map<String, dynamic>.from(cases.firstWhere((entry) => entry['name'] == name)['event'] as Map);
  return MeshEvent.fromJson(<String, dynamic>{...event, 'apply_state': 'UNVERIFIED'});
}

void main() {
  test('urgency table matches the contract and ignores people count', () {
    const others = RescueSubject.others;
    expect(deriveRescueUrgency(RescueRequestType.trappedDebris, _triage(), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(breathing: TriageAnswer.yes), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(bleeding: TriageAnswer.yes), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.otherRescue, _triage(conscious: TriageAnswer.no), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.otherRescue, _triage(conscious: TriageAnswer.no), RescueSubject.self), RescueUrgency.medium);
    expect(deriveRescueUrgency(RescueRequestType.trapped, _triage(), others), RescueUrgency.high);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(immobile: TriageAnswer.yes), others), RescueUrgency.high);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(), others), RescueUrgency.medium);
    expect(rescueUrgencyReason(RescueRequestType.trappedDebris, _triage(), others), '受困於瓦礫或倒塌建物下');
    expect(rescueUrgencyReason(RescueRequestType.firstAidNeeded, _triage(bleeding: TriageAnswer.yes), others), '大量出血');
  });

  test('draft validation and channel arguments', () {
    final empty = RescueDraft.initial();
    expect(empty.validate(), '請選擇求救位置');
    final draft = empty.copyWith(
      type: RescueRequestType.trappedDebris,
      subject: RescueSubject.self,
      peopleCount: 2,
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
      description: '  一樓樓梯間  ',
    );
    expect(draft.validate(), isNull);
    expect(draft.copyWith(peopleCount: 0).validate(), '人數需介於 1 到 50');
    expect(draft.copyWith(description: '字' * 161).validate(), '描述不可超過 160 字');
    expect(draft.copyWith(location: const GeoPoint(longitude: 139.7, latitude: 35.7)).validate(), '求救位置不在支援範圍內');
    expect(draft.toArguments(), <String, Object?>{
      'request_type': 'TRAPPED_DEBRIS',
      'subject': 'SELF',
      'people_count': 2,
      'triage': <String, String>{
        'immobile': 'UNKNOWN',
        'breathing_difficulty': 'UNKNOWN',
        'severe_bleeding': 'UNKNOWN',
        'conscious': 'YES',
      },
      'description': '一樓樓梯間',
      'location': <String, Object?>{'lon': 121.5, 'lat': 25.0, 'source': 'CURRENT_LOCATION'},
    });
  });

  test('fixture events parse into a view with lifecycle helpers', () {
    final view = RescueRequestView.fromEvent(_fixtureEvent('valid_v1'))!;
    expect(view.type, RescueRequestType.trappedDebris);
    expect(view.status, RescueStatus.active);
    expect(view.urgency, RescueUrgency.critical);
    expect(view.peopleCount, 2);
    expect(view.isActiveAt(DateTime.parse('2026-10-12T04:00:00Z')), isTrue);
    expect(view.isActiveAt(DateTime.parse('2026-10-12T09:00:00Z')), isFalse);
    expect(view.canExtendAt(DateTime.parse('2026-10-12T04:00:00Z')), isTrue);
    final resolved = RescueRequestView.fromEvent(_fixtureEvent('valid_v4_resolved'))!;
    expect(resolved.status, RescueStatus.resolved);
    expect(resolved.isActiveAt(DateTime.parse('2026-10-12T10:00:00Z')), isFalse);
    final report = MeshEvent.fromJson(const <String, dynamic>{'namespace': 'crowd.reports', 'event_type': 'CROWD_REPORT'});
    expect(RescueRequestView.fromEvent(report), isNull);
  });

  test('sessions from Android and Web describe delivery truthfully', () {
    final request = _fixture()['event_cases'][0]['event'] as Map<String, dynamic>;
    final android = RescueSession.fromMessage(<String, dynamic>{
      'request': <String, dynamic>{...request, 'apply_state': 'UNVERIFIED'},
      'delivery_state': 'PENDING',
      'server_state': 'NOT_UPLOADED',
    });
    expect(android.meshPending, isTrue);
    expect(android.server, RescueDelivery.waitingUpload);
    expect(android.deliveryText(), '已存於本機，等待附近裝置轉傳；伺服器：等待上傳，尚未送出');

    final web = RescueSession.fromMessage(<String, dynamic>{
      'request': <String, dynamic>{...request, 'apply_state': 'UNVERIFIED'},
      'delivery_state': 'REJECTED',
      'reason': 'rescue_active_exists',
    });
    expect(web.meshPending, isFalse);
    expect(web.server, RescueDelivery.rejected);
    expect(web.deliveryText(), '未送出：此裝置已有進行中的求救');
  });
}
