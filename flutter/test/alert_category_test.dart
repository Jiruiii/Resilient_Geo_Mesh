import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/alert_category.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';

void main() {
  test('uses normalized NCDR category metadata', () {
    const event = MeshEvent(
      namespace: 'official.ncdr',
      eventId: 'ncdr:warning:wind',
      eventVersion: 1,
      eventType: 'NCDR_HAZARD',
      severity: 'MEDIUM',
      source: 'NCDR',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-22T00:00:00Z',
      applyState: 'CURRENT',
      geometry: null,
      attributes: <String, dynamic>{
        'ncdr_category_code': 'strong_wind',
        'ncdr_category_label': '強風',
      },
    );

    expect(alertCategoryLabelFor(event), '強風');
  });

  test('classifies CWA warning from source description', () {
    const event = MeshEvent(
      namespace: 'official.cwa',
      eventId: 'cwa:warning:wind',
      eventVersion: 1,
      eventType: 'WEATHER_WARNING',
      severity: 'UNKNOWN',
      source: 'CWA',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-22T00:00:00Z',
      applyState: 'CURRENT',
      geometry: null,
      attributes: <String, dynamic>{'source_description': '陸上強風'},
    );

    expect(alertCategoryLabelFor(event), '強風');
  });

  test('classifies CWA typhoon and earthquake warning kinds', () {
    const typhoon = MeshEvent(
      namespace: 'official.cwa',
      eventId: 'cwa:warning:typhoon',
      eventVersion: 1,
      eventType: 'TYPHOON_WARNING',
      severity: 'UNKNOWN',
      source: 'CWA',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-22T00:00:00Z',
      applyState: 'CURRENT',
      geometry: null,
      attributes: <String, dynamic>{},
    );
    const earthquake = MeshEvent(
      namespace: 'official.cwa',
      eventId: 'cwa:earthquake:report',
      eventVersion: 1,
      eventType: 'EARTHQUAKE_INTENSITY',
      severity: 'UNKNOWN',
      source: 'CWA',
      issuedAt: '2026-10-21T00:00:00Z',
      expiresAt: '2026-10-22T00:00:00Z',
      applyState: 'CURRENT',
      geometry: null,
      attributes: <String, dynamic>{},
    );

    expect(alertCategoryLabelFor(typhoon), '颱風');
    expect(alertCategoryLabelFor(earthquake), '地震');
  });

  test(
    'classifies all government announcements by category with a distinct prefix',
    () {
      const categories = <String, String>{
        'SAFETY': '政府公告・安全提醒',
        'WEATHER': '政府公告・天氣',
        'ROAD': '政府公告・道路',
        'SHELTER': '政府公告・避難收容',
        'SUPPLY_STATION': '政府公告・物資站',
        'OTHER': '政府公告・其他',
      };
      for (final entry in categories.entries) {
        final event = MeshEvent(
          namespace: 'official.announcement',
          eventId: 'announcement:${entry.key}',
          eventVersion: 1,
          eventType: 'GOVERNMENT_ANNOUNCEMENT',
          severity: 'MEDIUM',
          source: 'GOVERNMENT',
          issuedAt: '2026-10-21T00:00:00Z',
          expiresAt: '2026-10-22T00:00:00Z',
          applyState: 'CURRENT',
          geometry: null,
          attributes: <String, dynamic>{'category': entry.key},
        );
        expect(alertCategoryLabelFor(event), entry.value);
      }
    },
  );

  test(
    'keeps an uncategorized government announcement labeled as government',
    () {
      const event = MeshEvent(
        namespace: 'official.announcement',
        eventId: 'announcement:one',
        eventVersion: 1,
        eventType: 'GOVERNMENT_ANNOUNCEMENT',
        severity: 'UNKNOWN',
        source: 'GOVERNMENT',
        issuedAt: '2026-10-21T00:00:00Z',
        expiresAt: '2026-10-22T00:00:00Z',
        applyState: 'CURRENT',
        geometry: null,
        attributes: <String, dynamic>{},
      );

      expect(alertCategoryLabelFor(event), '政府公告・未分類');
    },
  );
}
