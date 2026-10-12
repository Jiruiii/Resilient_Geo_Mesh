import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';
import 'package:resilientgeo_flutter/widgets/rescue_marker.dart';

import 'support/rescue_events.dart';

void main() {
  final view = RescueRequestView.fromEvent(rescue())!;

  test('semantic label states type, urgency, verification, status and people without colour', () {
    expect(
      rescueSemanticLabel(view, CrowdVerification.unverified),
      '求救點：受困於瓦礫或倒塌建物下，急迫程度危急，未經查證，進行中，2 人',
    );
    expect(rescueSemanticLabel(view, CrowdVerification.confirmed), contains('官方已確認'));
  });

  testWidgets('the marker carries an urgency badge and an unverified badge as text', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: SizedBox(
          width: 34,
          height: 34,
          child: RescueMarker(view: view, verification: CrowdVerification.unverified, compact: false, onTap: () => taps++),
        ),
      ),
    ));
    expect(find.text('危'), findsOneWidget);
    expect(find.text('?'), findsOneWidget);
    expect(find.bySemanticsLabel('求救點：受困於瓦礫或倒塌建物下，急迫程度危急，未經查證，進行中，2 人'), findsOneWidget);
    await tester.tap(find.byType(RescueMarker));
    expect(taps, 1);
  });

  test('event markers for rescue requests use the rescue widget and count as urgent rescue', () {
    final markers = MapLayers.buildMarkers(
      features: const <StaticFeature>[],
      events: <MeshEvent>[rescue()],
      showShelters: false,
      showMedical: false,
      showEvents: true,
      onStaticFeatureSelected: (_) {},
      onEventSelected: (_) {},
      now: DateTime.parse('2026-10-12T04:00:00Z'),
    );
    final marker = markers.single;
    expect(marker.child, isA<RescueMarker>());
    expect(marker.rescueCount, 1);
    expect(marker.hasUrgentRescue, isTrue);
    final cluster = MapMarkerCluster(members: <MapMarkerData>[marker, marker], point: marker.point);
    expect(cluster.rescueCount, 2);
    expect(cluster.hasUrgentRescue, isTrue);
    expect(clusterSemanticLabel(cluster), contains('求救點2，其中2個高或危急'));
  });

  test('ended rescue requests produce no marker', () {
    final markers = MapLayers.buildMarkers(
      features: const <StaticFeature>[],
      events: <MeshEvent>[rescue(status: 'RESOLVED')],
      showShelters: false,
      showMedical: false,
      showEvents: true,
      onStaticFeatureSelected: (_) {},
      onEventSelected: (_) {},
      now: DateTime.parse('2026-10-12T04:00:00Z'),
    );
    expect(markers, isEmpty);
  });
}
