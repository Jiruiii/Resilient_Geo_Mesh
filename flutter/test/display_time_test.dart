import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/display_time.dart';

void main() {
  test('formats an ISO update time without leading zeros in date parts', () {
    expect(formatUpdateTime('2026-09-25T18:20:00Z'), '2026-9-25 18:20:00');
  });

  test('shows no data for a missing update time', () {
    expect(formatUpdateTime(null), '無資料');
    expect(formatUpdateTime(''), '無資料');
  });

  test('keeps an unparseable update time visible for diagnosis', () {
    expect(formatUpdateTime('not-a-time'), 'not-a-time');
  });

  test('formats verified static data timestamps in Taiwan time', () {
    expect(
      formatStaticDataUpdateTime('2026-09-03T02:00:32Z'),
      '2026/09/3 10:00:32',
    );
    expect(
      formatStaticDataUpdateTime('2026-09-03T04:00:32+02:00'),
      '2026/09/3 10:00:32',
    );
  });

  test('shows no data for an absent or invalid static timestamp', () {
    expect(formatStaticDataUpdateTime(null), '無資料');
    expect(formatStaticDataUpdateTime('not-a-time'), '無資料');
  });
}
