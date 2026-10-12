import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_announcement_time.dart';

void main() {
  test('formats UTC expiry as Taiwan wall-clock time with seconds', () {
    expect(
      GovernmentAnnouncementTime.formatTaiwan(
        DateTime.utc(2026, 11, 23, 11, 39, 4),
      ),
      '2026/11/23 19:39:04',
    );
  });

  test('converts a selected Taiwan wall-clock time to UTC ISO 8601', () {
    final expiry = GovernmentAnnouncementTime.toUtcFromTaiwanWallClock(
      DateTime.utc(2026, 11, 23, 19, 39, 4),
    );

    expect(expiry.toIso8601String(), '2026-11-23T11:39:04.000Z');
  });
}
