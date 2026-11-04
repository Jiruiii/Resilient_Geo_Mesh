import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/evacuation_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/showcase/showcase_clock.dart';
import 'package:resilientgeo_flutter/showcase/showcase_scenario.dart';
import 'package:resilientgeo_flutter/showcase/showcase_simulation.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'showcase route and report stay in memory at the scenario clock',
    () async {
      final scenario = await ShowcaseScenario.load();
      final added = <MeshEvent>[];
      var currentEvents = scenario.events;
      final bridge = ShowcaseMapBridge(
        onReport: added.add,
        routes: scenario.routes,
        roadAlertActive:
            () => isShowcaseRoadClosureActive(
              events: currentEvents,
              eventId: scenario.routes.blockedEventId,
              at: ShowcaseClock.scenarioTime,
            ),
      );
      final shelter = scenario.features.features.firstWhere(
        (feature) => feature.id == 'shelter:5558',
      );
      final destination =
          RouteDestination.fromFeature(
            shelter,
            name: shelter.details['name'] as String,
          )!;

      final route = await bridge.calculateEvacuationRoute(
        origin: scenario.origin,
        destination: destination.candidate,
      );
      expect(route.status, EvacuationRouteStatus.ok);
      expect(route.polyline, hasLength(greaterThan(3)));
      expect(route.distanceM, closeTo(333.8, 0.1));
      expect(
        route.polyline.any(
          (point) =>
              point.longitude == 121.5934582 && point.latitude == 25.0806452,
        ),
        isTrue,
      );
      expect(route.warnings, isEmpty);

      final closure = scenario.delayedEvents.single;
      expect(closure.eventId, scenario.routes.blockedEventId);
      expect(meshEventIdentity(closure), isNot(scenario.routes.blockedEventId));
      currentEvents = <MeshEvent>[...currentEvents, closure];
      expect(
        isShowcaseRoadClosureActive(
          events: currentEvents,
          eventId: scenario.routes.blockedEventId,
          at: ShowcaseClock.scenarioTime,
        ),
        isTrue,
      );
      final detour = await bridge.calculateEvacuationRoute(
        origin: scenario.origin,
        destination: destination.candidate,
      );
      expect(detour.status, EvacuationRouteStatus.ok);
      expect(detour.distanceM, closeTo(447.2, 0.1));
      expect(detour.distanceM, greaterThan(route.distanceM!));
      expect(detour.blockedEventIds, <String>['showcase:route-road-closed']);
      expect(detour.warnings.single.message, contains('自動繞行'));
      expect(
        detour.polyline.any(
          (point) =>
              point.longitude == 121.5934582 && point.latitude == 25.0806452,
        ),
        isFalse,
      );

      final report = await bridge.submitCrowdReport(
        CrowdReportDraft(
          category: CrowdReportCategory.flood,
          location: scenario.origin,
          locationSource: CrowdReportLocationSource.currentLocation,
          description: '展示回報',
        ),
      );
      expect(report.deliveryState, 'DEMO_ONLY');
      expect(added, hasLength(1));
      expect(added.single.isShownAt(ShowcaseClock.scenarioTime), isTrue);
      expect(added.single.attributes?['is_demo'], isTrue);
    },
  );

  test('showcase rescue can be revised without a platform service', () async {
    final scenario = await ShowcaseScenario.load();
    final service = ShowcaseRescueService();
    final draft = RescueDraft.initial().copyWith(
      location: scenario.origin,
      locationSource: CrowdReportLocationSource.currentLocation,
    );
    final submitted = await service.submit(draft);
    expect(submitted.request.isActiveAt(ShowcaseClock.scenarioTime), isTrue);
    expect(submitted.deliveryText(), contains('未送出'));
    expect(await service.ownSessions(), hasLength(1));

    final resolved = await service.revise(
      submitted.request.eventId,
      RescueAction.resolve,
    );
    expect(resolved.request.status, RescueStatus.resolved);
    expect(
      resolved.request.event.isShownAt(ShowcaseClock.scenarioTime),
      isFalse,
    );
  });
}
