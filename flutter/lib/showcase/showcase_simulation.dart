import 'dart:async';

import 'package:geolocator/geolocator.dart';

import '../data/crowd_report_models.dart';
import '../data/evacuation_models.dart';
import '../data/location_controller.dart';
import '../data/map_bridge.dart';
import '../data/map_models.dart';
import '../data/rescue_request_models.dart';
import '../data/rescue_service.dart';
import 'showcase_clock.dart';
import 'showcase_route_data.dart';

bool isShowcaseRoadClosureActive({
  required List<MeshEvent> events,
  required String eventId,
  required DateTime at,
}) => events.any(
  (event) =>
      event.eventId == eventId &&
      event.eventType == 'ROAD_CLOSED' &&
      event.isShownAt(at),
);

final class ShowcaseLocationGateway implements LocationGateway {
  const ShowcaseLocationGateway(this.origin);

  final GeoPoint origin;

  @override
  Future<bool> isServiceEnabled() async => true;
  @override
  Future<LocationPermission> checkPermission() async =>
      LocationPermission.always;
  @override
  Future<LocationPermission> requestPermission() async =>
      LocationPermission.always;
  @override
  Future<GeoPoint?> getCurrentLocation() async => origin;
  @override
  Stream<GeoPoint> get locationUpdates => const Stream<GeoPoint>.empty();
}

/// All mutations stay in the hosting widget's memory; no inherited bridge
/// method that invokes a channel or HTTP endpoint is used by the walkthrough.
final class ShowcaseMapBridge extends MapBridge {
  ShowcaseMapBridge({
    required this.onReport,
    required this.routes,
    required this.roadAlertActive,
  });

  final void Function(MeshEvent) onReport;
  final ShowcaseRouteCatalog routes;
  final bool Function() roadAlertActive;
  int _nextReport = 0;

  @override
  Future<EvacuationRouteResult> calculateEvacuationRoute({
    required GeoPoint origin,
    required ShelterRouteCandidate destination,
    String mode = 'walk',
    DisasterType? disasterType,
  }) async {
    final route = routes.routes[destination.id];
    if (route == null) {
      return EvacuationRouteResult(
        status: EvacuationRouteStatus.noRoute,
        polyline: const <GeoPoint>[],
        distanceM: null,
        durationS: null,
        graphVersion: routes.graphVersion,
        eventSnapshotAt: ShowcaseClock.scenarioTime.toIso8601String(),
        warnings: const <RouteWarning>[
          RouteWarning(
            code: 'SHOWCASE_COVERAGE',
            eventId: null,
            message: '固定道路資料未涵蓋這個地點，暫無可顯示路線',
          ),
        ],
        blockedEventIds: const <String>[],
      );
    }

    final isDetourActive = roadAlertActive() && route.detourPolyline != null;
    final polyline = isDetourActive ? route.detourPolyline! : route.polyline;
    final distanceM = isDetourActive ? route.detourDistanceM! : route.distanceM;
    return EvacuationRouteResult(
      status: EvacuationRouteStatus.ok,
      polyline: polyline,
      distanceM: distanceM,
      durationS: distanceM / 1.2,
      graphVersion: routes.graphVersion,
      eventSnapshotAt: ShowcaseClock.scenarioTime.toIso8601String(),
      warnings:
          isDetourActive
              ? <RouteWarning>[
                RouteWarning(
                  code: 'ROAD_CLOSED_DETOUR',
                  eventId: routes.blockedEventId,
                  message: '前方道路封閉，已自動繞行',
                ),
              ]
              : const <RouteWarning>[],
      blockedEventIds:
          isDetourActive ? <String>[routes.blockedEventId] : const <String>[],
    );
  }

  @override
  Future<CrowdReportSubmission> submitCrowdReport(
    CrowdReportDraft draft,
  ) async {
    final validation = draft.validate();
    if (validation != null) throw FormatException(validation);
    final eventId = 'report:showcase:${++_nextReport}';
    final event = MeshEvent(
      namespace: 'crowd.report',
      eventId: eventId,
      eventVersion: 1,
      eventType: 'CROWD_REPORT',
      severity: 'MEDIUM',
      source: 'SHOWCASE',
      issuedAt: ShowcaseClock.scenarioTime.toIso8601String(),
      expiresAt:
          ShowcaseClock.scenarioTime
              .add(const Duration(hours: 6))
              .toIso8601String(),
      applyState: 'UNVERIFIED',
      geometry: PointGeometry(draft.location!),
      attributes: <String, dynamic>{
        'category': draft.category.wireValue,
        'description': draft.description.trim(),
        'source_description': '【展示】${draft.category.label}',
        'is_demo': true,
      },
    );
    onReport(event);
    return CrowdReportSubmission(
      eventId: eventId,
      applyState: 'UNVERIFIED',
      deliveryState: 'DEMO_ONLY',
    );
  }
}

final class ShowcaseRescueService implements RescueService {
  final Map<String, RescueSession> _sessions = <String, RescueSession>{};
  int _nextRequest = 0;

  @override
  Future<RescueCapabilities> capabilities() async => const RescueCapabilities(
    canSign: true,
    canVerify: false,
    hasStorage: true,
    supportsMesh: false,
  );

  @override
  Future<RescueSession> submit(RescueDraft draft) async {
    final error = draft.validate();
    if (error != null) throw FormatException(error);
    final id = 'rescue:showcase:${++_nextRequest}';
    final session = _session(id, 1, draft, 'ACTIVE');
    _sessions[id] = session;
    return session;
  }

  @override
  Future<RescueSession> revise(
    String eventId,
    RescueAction action, {
    RescueDraft? draft,
  }) async {
    final current = _sessions[eventId];
    if (current == null) {
      throw const RescueFailure(
        code: RescueFailureCode.conflict,
        message: 'missing showcase request',
      );
    }
    final request = current.request;
    final nextDraft = draft ?? RescueDraft.fromView(request);
    final status = switch (action) {
      RescueAction.resolve => 'RESOLVED',
      RescueAction.cancel => 'CANCELLED',
      _ => 'ACTIVE',
    };
    final expiresAt =
        action == RescueAction.extend
            ? request.expiresAt.add(const Duration(hours: 6))
            : request.expiresAt;
    final session = _session(
      eventId,
      (request.event.eventVersion ?? 1) + 1,
      nextDraft,
      status,
      firstIssuedAt: request.firstIssuedAt,
      expiresAt: expiresAt,
    );
    _sessions[eventId] = session;
    return session;
  }

  RescueSession _session(
    String id,
    int version,
    RescueDraft draft,
    String status, {
    DateTime? firstIssuedAt,
    DateTime? expiresAt,
  }) {
    final now = ShowcaseClock.scenarioTime;
    final first = firstIssuedAt ?? now;
    final event = MeshEvent(
      namespace: rescueNamespace,
      eventId: id,
      eventVersion: version,
      eventType: rescueEventType,
      severity: draft.urgency.wireValue,
      source: 'SHOWCASE',
      issuedAt: now.toIso8601String(),
      expiresAt:
          (expiresAt ?? now.add(const Duration(hours: 6))).toIso8601String(),
      applyState: 'UNVERIFIED',
      geometry: PointGeometry(draft.location!),
      attributes: <String, dynamic>{
        ...draft.toArguments(),
        'status': status,
        'first_issued_at': first.toIso8601String(),
        'is_demo': true,
      },
    );
    final view = RescueRequestView.fromEvent(event);
    if (view == null) {
      throw const FormatException('Invalid showcase rescue request');
    }
    return RescueSession(
      request: view,
      meshPending: false,
      server: RescueDelivery.rejected,
      reason: '僅在此展示頁模擬，未送出',
    );
  }

  @override
  Future<List<RescueSession>> ownSessions() async => _sessions.values.toList();
  @override
  Future<List<RescueSession>> flush() => ownSessions();
  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) async =>
      const <MeshEvent>[];
}
