import 'map_models.dart';

const attestationNamespace = 'official.verified';
const attestationEventType = 'ATTESTATION';

bool isCrowdEvent(MeshEvent event) =>
    event.namespace?.startsWith('crowd.') == true;

/// Only an officially signed `official.verified` ATTESTATION counts. Android
/// has already verified its signature against the bundled trust store; a
/// crowd event shaped like an attestation is never trusted here.
bool isAttestationEvent(MeshEvent event) =>
    event.namespace == attestationNamespace &&
    event.eventType == attestationEventType;

/// Maps official attestations onto the crowd reports they point at.
///
/// Pure display logic: Android's apply state for the report stays
/// UNVERIFIED. An attestation applies only when it is itself current, names
/// the report by namespace and event id, and carries the report's exact
/// payload hash, so a verdict about one version of a report is never shown on
/// a different one. Among several attestations for one report the highest
/// `event_version` wins, which lets the government revise a verdict.
class AttestationIndex {
  AttestationIndex._(this._byTarget);

  factory AttestationIndex.fromEvents(
    Iterable<MeshEvent> events, {
    DateTime? now,
  }) {
    final reference = (now ?? DateTime.now()).toUtc();
    final byTarget = <String, MeshEvent>{};
    for (final event in events) {
      if (!isAttestationEvent(event) || !event.isCurrentAt(reference)) {
        continue;
      }
      final attributes = event.attributes;
      final namespace = attributes?['target_namespace'];
      final eventId = attributes?['target_event_id'];
      if (namespace is! String || eventId is! String) continue;
      if (_verdict(event) == null) continue;
      final key = _key(namespace, eventId);
      final existing = byTarget[key];
      if (existing == null ||
          (event.eventVersion ?? 0) > (existing.eventVersion ?? 0)) {
        byTarget[key] = event;
      }
    }
    return AttestationIndex._(byTarget);
  }

  static final empty = AttestationIndex._(const <String, MeshEvent>{});

  final Map<String, MeshEvent> _byTarget;

  /// The attestation that applies to [report], if any.
  MeshEvent? attestationFor(MeshEvent report) {
    if (!isCrowdEvent(report)) return null;
    final namespace = report.namespace;
    final eventId = report.eventId;
    if (namespace == null || eventId == null) return null;
    final attestation = _byTarget[_key(namespace, eventId)];
    if (attestation == null) return null;
    final targetHash = attestation.attributes?['target_payload_hash'];
    if (targetHash is! String || targetHash != report.payloadHash) return null;
    return attestation;
  }

  /// True when an attestation targets this request id but a different
  /// version, e.g. the reporter updated it after the government confirmed it.
  bool confirmedOtherVersion(MeshEvent report) {
    final attestation = _byTarget[_key(report.namespace ?? '', report.eventId ?? '')];
    return attestation != null &&
        _verdict(attestation) == CrowdVerification.confirmed &&
        attestation.attributes?['target_payload_hash'] != report.payloadHash;
  }

  CrowdVerification verificationOf(MeshEvent report) => switch (attestationFor(
    report,
  )) {
    null => CrowdVerification.unverified,
    final attestation => _verdict(attestation) ?? CrowdVerification.unverified,
  };

  /// Events as the map should show them: attestations are pointers, not
  /// places, so they never get a marker of their own; refuted reports are
  /// hidden (their detail stays reachable from notifications); every crowd
  /// report carries its verification for colour and wording.
  List<MeshEvent> mapDisplayEvents(Iterable<MeshEvent> events) => events
      .where((event) => !isAttestationEvent(event))
      .map(withVerification)
      .where((event) => event.verification != CrowdVerification.refuted)
      .toList(growable: false);

  MeshEvent withVerification(MeshEvent event) =>
      isCrowdEvent(event)
          ? event.copyWithVerification(verificationOf(event))
          : event;

  static String _key(String namespace, String eventId) =>
      '$namespace\u0000$eventId';

  static CrowdVerification? _verdict(MeshEvent attestation) =>
      switch (attestation.attributes?['verdict']) {
        'CONFIRMED' => CrowdVerification.confirmed,
        'REFUTED' => CrowdVerification.refuted,
        _ => null,
      };
}

/// Wording shown for a crowd report. Never implies verification unless an
/// official attestation confirmed it.
String crowdVerificationLabel(CrowdVerification verification) =>
    switch (verification) {
      CrowdVerification.unverified => '未經查證，僅供參考',
      CrowdVerification.confirmed => '已查證（官方確認）',
      CrowdVerification.refuted => '查證為假（官方否定）',
    };
