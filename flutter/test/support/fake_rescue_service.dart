import 'dart:async';

import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';

/// A rescue session built from fields, for widget and controller tests.
RescueSession fakeSession({
  String status = 'ACTIVE',
  String type = 'TRAPPED_DEBRIS',
  String issuedAt = '2026-10-12T03:00:00Z',
  String expiresAt = '2026-10-12T09:00:00Z',
  int version = 1,
  bool meshPending = true,
  RescueDelivery server = RescueDelivery.waitingUpload,
}) {
  final event = MeshEvent.fromJson(<String, dynamic>{
    'namespace': 'crowd.rescue',
    'event_id': 'rescue:${'a' * 32}:00000000-0000-4000-8000-000000000001',
    'event_version': version,
    'event_type': 'RESCUE_REQUEST',
    'severity': type == 'TRAPPED_DEBRIS' ? 'CRITICAL' : 'HIGH',
    'source': 'CROWD',
    'issued_at': issuedAt,
    'expires_at': expiresAt,
    'apply_state': 'UNVERIFIED',
    'geometry': <String, dynamic>{'type': 'Point', 'coordinates': <double>[121.5, 25.0]},
    'signing_key_id': 'device:${'a' * 32}',
    'attributes': <String, dynamic>{
      'request_type': type,
      'status': status,
      'subject': 'SELF',
      'people_count': 1,
      'triage': <String, String>{'immobile': 'YES', 'breathing_difficulty': 'NO', 'severe_bleeding': 'NO', 'conscious': 'YES'},
      'description': '',
      'location_source': 'CURRENT_LOCATION',
      'first_issued_at': '2026-10-12T03:00:00Z',
      'area_id': 'crowd',
      'theme': 'rescue',
    },
  });
  return RescueSession(request: RescueRequestView.fromEvent(event)!, meshPending: meshPending, server: server);
}

class FakeRescueService implements RescueService {
  RescueCapabilities capabilitiesResult = const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: true);
  List<RescueSession> initialSessions = const <RescueSession>[];
  RescueSession? submitResult;
  RescueFailure? submitError;
  Completer<RescueSession>? pendingSubmit;
  final Map<RescueAction, RescueSession> revisionResults = <RescueAction, RescueSession>{};
  List<MeshEvent> nearbyResult = const <MeshEvent>[];
  int submitCalls = 0;
  int flushCalls = 0;
  final List<(String, RescueAction)> revisions = <(String, RescueAction)>[];
  final List<RescueBounds> nearbyCalls = <RescueBounds>[];

  @override
  Future<RescueCapabilities> capabilities() async => capabilitiesResult;

  @override
  Future<List<RescueSession>> ownSessions() async => initialSessions;

  @override
  Future<List<RescueSession>> flush() async {
    flushCalls += 1;
    return initialSessions;
  }

  @override
  Future<RescueSession> submit(RescueDraft draft) {
    submitCalls += 1;
    if (submitError != null) return Future<RescueSession>.error(submitError!);
    if (pendingSubmit != null) return pendingSubmit!.future;
    return Future<RescueSession>.value(submitResult ?? fakeSession());
  }

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) async {
    revisions.add((eventId, action));
    return revisionResults[action] ?? fakeSession(version: 2, status: switch (action) {
      RescueAction.resolve => 'RESOLVED',
      RescueAction.cancel => 'CANCELLED',
      _ => 'ACTIVE',
    });
  }

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) async {
    nearbyCalls.add(bounds);
    return nearbyResult;
  }
}
