import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_marker_projection.dart';

void main() {
  test('coalesces camera projections to the latest value in one frame', () {
    final gate = MapCameraProjectionFrameGate<int>();
    final scheduled = <void Function()>[];
    final applied = <int>[];

    void scheduleFrame(void Function() callback) => scheduled.add(callback);

    gate.enqueue(1, scheduleFrame, applied.add);
    gate.enqueue(2, scheduleFrame, applied.add);

    expect(scheduled, hasLength(1));
    expect(applied, isEmpty);

    scheduled.single();

    expect(applied, <int>[2]);
  });

  test('a newer camera projection invalidates older async results', () {
    final gate = MapMarkerProjectionGate();

    final firstRequest = gate.request();
    final latestRequest = gate.request();

    expect(gate.isCurrent(firstRequest), isFalse);
    expect(gate.isCurrent(latestRequest), isTrue);
  });

  test('caches marker layout until it is invalidated', () {
    final cache = MapMarkerLayoutCache<List<int>>();
    var buildCount = 0;

    final first = cache.getOrBuild(() {
      buildCount += 1;
      return <int>[buildCount];
    });
    final second = cache.getOrBuild(() {
      buildCount += 1;
      return <int>[buildCount];
    });

    expect(buildCount, 1);
    expect(identical(first, second), isTrue);

    cache.invalidate();
    final third = cache.getOrBuild(() {
      buildCount += 1;
      return <int>[buildCount];
    });

    expect(buildCount, 2);
    expect(third, <int>[2]);
  });

  test('keeps overview layouts separate when camera zoom changes', () {
    final cache = MapMarkerZoomLayoutCache<List<String>>();
    var buildCount = 0;

    List<String> layoutAt(double zoom) => cache.getOrBuild(zoom, () {
      buildCount += 1;
      return <String>['zoom-${zoom.toStringAsFixed(2)}'];
    });

    final zeroPercent = layoutAt(6);
    final homeView = layoutAt(7.26);
    final zeroPercentAgain = layoutAt(6);

    expect(zeroPercent, <String>['zoom-6.00']);
    expect(homeView, <String>['zoom-7.26']);
    expect(identical(zeroPercent, zeroPercentAgain), isTrue);
    expect(buildCount, 2);
  });

  testWidgets('camera translations reuse the positioned marker subtree', (
    tester,
  ) async {
    final overlay = MapMarkerOverlayNotifier<String>();
    var hostBuilds = 0;
    var markerLayerBuilds = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, _) {
            hostBuilds += 1;
            return ValueListenableBuilder<MapMarkerOverlayFrame<String>>(
              valueListenable: overlay,
              builder:
                  (context, frame, child) => Transform.translate(
                    offset: frame.translation,
                    child: child,
                  ),
              child: RepaintBoundary(
                child: ValueListenableBuilder<MapMarkerOverlayFrame<String>>(
                  valueListenable: overlay.layout,
                  builder: (context, frame, _) {
                    markerLayerBuilds += 1;
                    if (frame.markers.isEmpty) {
                      return const SizedBox.shrink();
                    }
                    final marker = frame.markers.single;
                    final markerKey = ValueKey<String>(marker);
                    final point = frame.positions[markerKey] ?? Offset.zero;
                    return Stack(
                      fit: StackFit.expand,
                      clipBehavior: Clip.hardEdge,
                      children: <Widget>[
                        Positioned(
                          key: markerKey,
                          left: point.dx,
                          top: point.dy,
                          child: Text(marker),
                        ),
                      ],
                    );
                  },
                ),
              ),
            );
          },
        ),
      ),
    );

    overlay.replace(
      markers: const <String>['marker'],
      positions: <Key, Offset>{const ValueKey<String>('marker'): Offset.zero},
    );
    await tester.pump();
    overlay.translate(const Offset(24, 32));
    await tester.pump();

    expect(hostBuilds, 1);
    expect(markerLayerBuilds, 2);
    expect(find.text('marker'), findsOneWidget);
    expect(tester.getTopLeft(find.text('marker')), const Offset(24, 32));
    overlay.dispose();
  });

  test('translation preserves the cached marker layout and positions', () {
    final overlay = MapMarkerOverlayNotifier<String>();
    const markers = <String>['stable'];
    const markerKey = ValueKey<String>('stable');

    overlay.replace(
      markers: markers,
      positions: <Key, Offset>{markerKey: Offset.zero},
    );
    final stableLayout = overlay.layout.value;
    overlay.translate(const Offset(10, 20));

    expect(identical(overlay.layout.value, stableLayout), isTrue);
    expect(identical(overlay.value.markers, stableLayout.markers), isTrue);
    expect(identical(overlay.value.positions, stableLayout.positions), isTrue);
    expect(overlay.value.translation, const Offset(10, 20));
    overlay.dispose();
  });
}
