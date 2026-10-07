import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_event_focus.dart';

void main() {
  group('MapEventFocusGate', () {
    test('ignores the first nonempty feed snapshot but focuses later updates', () {
      final gate = MapEventFocusGate(hasInitialSnapshot: false);

      expect(gate.shouldFocusSnapshot(const <String>['startup-event']), isFalse);
      expect(gate.shouldFocusSnapshot(const <String>['later-event']), isTrue);
    });

    test('focuses new events when the initial map already has a baseline', () {
      final gate = MapEventFocusGate(hasInitialSnapshot: true);

      expect(gate.shouldFocusSnapshot(const <String>['later-event']), isTrue);
    });

    test('does not consume the initial snapshot while the feed is empty', () {
      final gate = MapEventFocusGate(hasInitialSnapshot: false);

      expect(gate.shouldFocusSnapshot(const <String>[]), isFalse);
      expect(gate.shouldFocusSnapshot(const <String>['startup-event']), isFalse);
      expect(gate.shouldFocusSnapshot(const <String>['later-event']), isTrue);
    });
  });
}
