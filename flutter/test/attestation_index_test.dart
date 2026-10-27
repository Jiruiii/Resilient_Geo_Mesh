import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/attestation_index.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/screens/notifications_screen.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';

final now = DateTime.utc(2026, 9, 24, 1);
const reportHash =
    'sha256:1111111111111111111111111111111111111111111111111111111111111111';

MeshEvent report({
  String eventId = 'report:abcd1234:0001',
  String payloadHash = reportHash,
  String applyState = 'UNVERIFIED',
  String expiresAt = '2026-09-24T06:00:00Z',
}) => MeshEvent(
  namespace: 'crowd.reports',
  eventId: eventId,
  eventVersion: 1,
  eventType: 'CROWD_REPORT',
  severity: 'MEDIUM',
  source: 'CROWD',
  issuedAt: '2026-09-24T00:00:00Z',
  expiresAt: expiresAt,
  applyState: applyState,
  geometry: const PointGeometry(
    GeoPoint(longitude: 121.590304, latitude: 25.083506),
  ),
  attributes: const <String, dynamic>{
    'category': 'ROAD_BLOCKAGE',
    'description': '成功路二段落石',
  },
  payloadHash: payloadHash,
  signingKeyId: 'device:0123456789abcdef0123456789abcdef',
);

MeshEvent attestation({
  String verdict = 'CONFIRMED',
  int version = 1,
  String namespace = 'official.verified',
  String targetHash = reportHash,
  String targetEventId = 'report:abcd1234:0001',
  String applyState = 'CURRENT',
  String expiresAt = '2026-09-24T06:00:00Z',
}) => MeshEvent(
  namespace: namespace,
  eventId: 'attest:$targetEventId',
  eventVersion: version,
  eventType: 'ATTESTATION',
  severity: 'MEDIUM',
  source: 'GOV_ATTEST',
  issuedAt: '2026-09-24T00:30:00Z',
  expiresAt: expiresAt,
  applyState: applyState,
  geometry: const PointGeometry(
    GeoPoint(longitude: 121.590304, latitude: 25.083506),
  ),
  attributes: <String, dynamic>{
    'target_namespace': 'crowd.reports',
    'target_event_id': targetEventId,
    'target_payload_hash': targetHash,
    'verdict': verdict,
  },
);

CrowdVerification verdictFor(List<MeshEvent> events) =>
    AttestationIndex.fromEvents(events, now: now).verificationOf(report());

void main() {
  test('a report with no attestation stays unverified', () {
    expect(verdictFor(<MeshEvent>[report()]), CrowdVerification.unverified);
  });

  test('a current official attestation confirms or refutes the report', () {
    expect(verdictFor(<MeshEvent>[attestation()]), CrowdVerification.confirmed);
    expect(
      verdictFor(<MeshEvent>[attestation(verdict: 'REFUTED')]),
      CrowdVerification.refuted,
    );
  });

  test('a mismatched payload hash is not applied', () {
    // The report may have been superseded by a different version.
    expect(
      verdictFor(<MeshEvent>[attestation(targetHash: 'sha256:${'2' * 64}')]),
      CrowdVerification.unverified,
    );
  });

  test('an expired attestation is not applied', () {
    expect(
      verdictFor(<MeshEvent>[
        attestation(applyState: 'EXPIRED', expiresAt: '2026-09-24T00:45:00Z'),
      ]),
      CrowdVerification.unverified,
    );
  });

  test('the highest event_version wins so verdicts can be revised', () {
    expect(
      verdictFor(<MeshEvent>[
        attestation(version: 2, verdict: 'REFUTED'),
        attestation(version: 1),
      ]),
      CrowdVerification.refuted,
    );
    expect(
      verdictFor(<MeshEvent>[
        attestation(version: 1, verdict: 'REFUTED'),
        attestation(version: 3),
      ]),
      CrowdVerification.confirmed,
    );
  });

  test('only official.verified attestations count', () {
    expect(
      verdictFor(<MeshEvent>[
        attestation(namespace: 'crowd.reports', applyState: 'UNVERIFIED'),
      ]),
      CrowdVerification.unverified,
    );
    expect(
      verdictFor(<MeshEvent>[attestation(namespace: 'official.tdx')]),
      CrowdVerification.unverified,
    );
  });

  test('map display drops attestations and refuted reports', () {
    final confirmedOther = report(eventId: 'report:abcd1234:0002');
    final index = AttestationIndex.fromEvents(<MeshEvent>[
      attestation(verdict: 'REFUTED'),
      attestation(targetEventId: 'report:abcd1234:0002'),
    ], now: now);
    final shown = index.mapDisplayEvents(<MeshEvent>[
      report(),
      confirmedOther,
      attestation(verdict: 'REFUTED'),
    ]);
    expect(shown.map((event) => event.eventId), <String>[
      'report:abcd1234:0002',
    ]);
    expect(shown.single.verification, CrowdVerification.confirmed);
  });

  test('unverified crowd reports are drawn; expired ones are not', () {
    expect(report().isCurrentAt(now), isFalse);
    expect(report().isShownAt(now), isTrue);
    expect(
      report(
        applyState: 'EXPIRED',
        expiresAt: '2026-09-24T00:30:00Z',
      ).isShownAt(now),
      isFalse,
    );
  });

  test('crowd colours differ from every official severity colour', () {
    final unverified = eventColor(report(expiresAt: '2099-01-01T00:00:00Z'));
    final confirmed = eventColor(
      report(
        expiresAt: '2099-01-01T00:00:00Z',
      ).copyWithVerification(CrowdVerification.confirmed),
    );
    expect(unverified, unverifiedEventColor);
    expect(confirmed, confirmedCrowdEventColor);
    expect(unverified, isNot(confirmed));
    expect(eventName(report()), '民眾回報：道路阻斷');
  });

  testWidgets('details sheet says a crowd report is unverified', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.event(
            event: report(),
            corroboration: '3 人回報',
            onClose: () {},
          ),
        ),
      ),
    );
    expect(find.text('未經查證，僅供參考'), findsOneWidget);
    expect(find.text('回報類別：道路阻斷'), findsOneWidget);
    expect(find.text('描述：成功路二段落石'), findsOneWidget);
    expect(find.text('附近回報：3 人回報'), findsOneWidget);
  });

  testWidgets('details sheet shows confirmed and refuted verdicts', (
    tester,
  ) async {
    for (final (verification, label) in <(CrowdVerification, String)>[
      (CrowdVerification.confirmed, '已查證（官方確認）'),
      (CrowdVerification.refuted, '查證為假（官方否定）'),
    ]) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FeatureDetailsSheet.event(
              event: report().copyWithVerification(verification),
              onClose: () {},
            ),
          ),
        ),
      );
      expect(find.text(label), findsOneWidget);
    }
  });

  testWidgets('map station details show category, content and effective time', (
    tester,
  ) async {
    final station = MeshEvent(
      namespace: 'official.announcement',
      eventId: 'announcement:station',
      eventVersion: 1,
      eventType: 'GOVERNMENT_ANNOUNCEMENT',
      severity: 'MEDIUM',
      source: 'GOVERNMENT',
      issuedAt: '2026-10-12T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      applyState: 'CURRENT',
      geometry: const PointGeometry(
        GeoPoint(longitude: 121.590304, latitude: 25.083506),
      ),
      attributes: const <String, dynamic>{
        'title': '三重物資站',
        'category': 'SUPPLY_STATION',
        'content': '提供飲水與乾糧',
        'has_map_location': true,
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FeatureDetailsSheet.event(event: station, onClose: () {}),
        ),
      ),
    );

    expect(find.text('公告類別：物資站'), findsOneWidget);
    expect(find.text('公告內容：提供飲水與乾糧'), findsOneWidget);
    expect(find.text('位置／範圍：點位（25.083506, 121.590304）'), findsOneWidget);
  });

  testWidgets('notifications label verified reports and hide attestations', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        // NotificationsScreen reads the wall clock, so use far-future expiry.
        home: NotificationsScreen(
          events: <MeshEvent>[report(expiresAt: '2099-01-01T00:00:00Z')],
          attestationSource: <MeshEvent>[
            attestation(expiresAt: '2099-01-01T00:00:00Z'),
          ],
          onEventRead: (_) {},
        ),
      ),
    );
    // Notification categories start collapsed.
    await tester.tap(find.text('一般通知'));
    await tester.pump();
    expect(find.textContaining('狀態：已查證（官方確認）'), findsOneWidget);
    expect(find.textContaining('ATTESTATION'), findsNothing);
  });
}
