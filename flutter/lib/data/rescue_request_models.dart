import 'crowd_report_models.dart';
import 'map_models.dart';

const rescueNamespace = 'crowd.rescue';
const rescueEventType = 'RESCUE_REQUEST';
const rescueDescriptionMaxCodePoints = 160;
const rescuePeopleMax = 50;

/// Same bounds the contract enforces (pipeline/lib/crowd-common.mjs).
const _taiwanBounds = <double>[116.5, 20.5, 122.5, 26.8];

enum RescueRequestType { firstAidNeeded, immobile, trapped, trappedDebris, otherRescue }

extension RescueRequestTypeWire on RescueRequestType {
  String get wireValue => switch (this) {
    RescueRequestType.firstAidNeeded => 'FIRST_AID_NEEDED',
    RescueRequestType.immobile => 'IMMOBILE',
    RescueRequestType.trapped => 'TRAPPED',
    RescueRequestType.trappedDebris => 'TRAPPED_DEBRIS',
    RescueRequestType.otherRescue => 'OTHER_RESCUE',
  };

  String get label => switch (this) {
    RescueRequestType.firstAidNeeded => '需要醫療或急救協助',
    RescueRequestType.immobile => '無法移動',
    RescueRequestType.trapped => '受困',
    RescueRequestType.trappedDebris => '受困於瓦礫或倒塌建物下',
    RescueRequestType.otherRescue => '其他救援需求',
  };
}

RescueRequestType? rescueRequestTypeFromWire(Object? value) {
  for (final type in RescueRequestType.values) {
    if (type.wireValue == value) return type;
  }
  return null;
}

enum RescueSubject { self, others }

extension RescueSubjectWire on RescueSubject {
  String get wireValue => this == RescueSubject.self ? 'SELF' : 'OTHERS';
  String get label => this == RescueSubject.self ? '我自己' : '現場其他人';
}

enum TriageAnswer { yes, no, unknown }

extension TriageAnswerWire on TriageAnswer {
  String get wireValue => switch (this) {
    TriageAnswer.yes => 'YES',
    TriageAnswer.no => 'NO',
    TriageAnswer.unknown => 'UNKNOWN',
  };

  String get label => switch (this) {
    TriageAnswer.yes => '是',
    TriageAnswer.no => '否',
    TriageAnswer.unknown => '不確定',
  };
}

TriageAnswer? _answerFromWire(Object? value) {
  for (final answer in TriageAnswer.values) {
    if (answer.wireValue == value) return answer;
  }
  return null;
}

final class RescueTriage {
  const RescueTriage({
    this.immobile = TriageAnswer.unknown,
    this.breathingDifficulty = TriageAnswer.unknown,
    this.severeBleeding = TriageAnswer.unknown,
    this.conscious = TriageAnswer.unknown,
  });

  final TriageAnswer immobile;
  final TriageAnswer breathingDifficulty;
  final TriageAnswer severeBleeding;
  final TriageAnswer conscious;

  RescueTriage copyWith({
    TriageAnswer? immobile,
    TriageAnswer? breathingDifficulty,
    TriageAnswer? severeBleeding,
    TriageAnswer? conscious,
  }) => RescueTriage(
    immobile: immobile ?? this.immobile,
    breathingDifficulty: breathingDifficulty ?? this.breathingDifficulty,
    severeBleeding: severeBleeding ?? this.severeBleeding,
    conscious: conscious ?? this.conscious,
  );

  /// SELF requests are always recorded as conscious, as in the contract.
  TriageAnswer effectiveConscious(RescueSubject subject) =>
      subject == RescueSubject.self ? TriageAnswer.yes : conscious;

  Map<String, String> toWire(RescueSubject subject) => <String, String>{
    'immobile': immobile.wireValue,
    'breathing_difficulty': breathingDifficulty.wireValue,
    'severe_bleeding': severeBleeding.wireValue,
    'conscious': effectiveConscious(subject).wireValue,
  };

  static RescueTriage? fromWire(Object? value) {
    if (value is! Map) return null;
    final immobile = _answerFromWire(value['immobile']);
    final breathing = _answerFromWire(value['breathing_difficulty']);
    final bleeding = _answerFromWire(value['severe_bleeding']);
    final conscious = _answerFromWire(value['conscious']);
    if (immobile == null || breathing == null || bleeding == null || conscious == null) return null;
    return RescueTriage(
      immobile: immobile,
      breathingDifficulty: breathing,
      severeBleeding: bleeding,
      conscious: conscious,
    );
  }
}

enum RescueUrgency { critical, high, medium }

extension RescueUrgencyWire on RescueUrgency {
  String get wireValue => switch (this) {
    RescueUrgency.critical => 'CRITICAL',
    RescueUrgency.high => 'HIGH',
    RescueUrgency.medium => 'MEDIUM',
  };

  String get label => switch (this) {
    RescueUrgency.critical => '危急',
    RescueUrgency.high => '高',
    RescueUrgency.medium => '中',
  };

  String get badge => switch (this) {
    RescueUrgency.critical => '危',
    RescueUrgency.high => '高',
    RescueUrgency.medium => '中',
  };
}

RescueUrgency? rescueUrgencyFromWire(Object? value) {
  for (final urgency in RescueUrgency.values) {
    if (urgency.wireValue == value) return urgency;
  }
  return null;
}

/// Display copy of the contract's derivation; Android and the browser
/// recompute and verify it, so this only drives the form preview.
RescueUrgency deriveRescueUrgency(RescueRequestType type, RescueTriage triage, RescueSubject subject) {
  if (type == RescueRequestType.trappedDebris) return RescueUrgency.critical;
  if (triage.breathingDifficulty == TriageAnswer.yes ||
      triage.severeBleeding == TriageAnswer.yes ||
      triage.effectiveConscious(subject) == TriageAnswer.no) {
    return RescueUrgency.critical;
  }
  if (type == RescueRequestType.trapped || type == RescueRequestType.immobile || triage.immobile == TriageAnswer.yes) {
    return RescueUrgency.high;
  }
  return RescueUrgency.medium;
}

String rescueUrgencyReason(RescueRequestType type, RescueTriage triage, RescueSubject subject) {
  if (type == RescueRequestType.trappedDebris) return type.label;
  if (triage.breathingDifficulty == TriageAnswer.yes) return '呼吸困難';
  if (triage.severeBleeding == TriageAnswer.yes) return '大量出血';
  if (triage.effectiveConscious(subject) == TriageAnswer.no) return '失去意識';
  if (type == RescueRequestType.trapped) return '受困';
  if (type == RescueRequestType.immobile || triage.immobile == TriageAnswer.yes) return '無法移動';
  return '需要協助';
}

enum RescueStatus { active, resolved, cancelled }

extension RescueStatusWire on RescueStatus {
  String get wireValue => switch (this) {
    RescueStatus.active => 'ACTIVE',
    RescueStatus.resolved => 'RESOLVED',
    RescueStatus.cancelled => 'CANCELLED',
  };

  String get label => switch (this) {
    RescueStatus.active => '進行中',
    RescueStatus.resolved => '已安全／已獲救',
    RescueStatus.cancelled => '已取消',
  };
}

RescueStatus? rescueStatusFromWire(Object? value) {
  for (final status in RescueStatus.values) {
    if (status.wireValue == value) return status;
  }
  return null;
}

enum RescueAction { update, extend, resolve, cancel }

extension RescueActionWire on RescueAction {
  String get wireValue => switch (this) {
    RescueAction.update => 'UPDATE',
    RescueAction.extend => 'EXTEND',
    RescueAction.resolve => 'RESOLVE',
    RescueAction.cancel => 'CANCEL',
  };
}

const Object _unchanged = Object();

final class RescueDraft {
  const RescueDraft({
    required this.type,
    required this.subject,
    required this.peopleCount,
    required this.triage,
    required this.location,
    required this.locationSource,
    this.locationHint,
    required this.description,
  });

  factory RescueDraft.initial() => const RescueDraft(
    type: RescueRequestType.trappedDebris,
    subject: RescueSubject.self,
    peopleCount: 1,
    triage: RescueTriage(),
    location: null,
    locationSource: null,
    description: '',
  );

  factory RescueDraft.fromView(RescueRequestView view) {
    final geometry = view.event.geometry;
    return RescueDraft(
      type: view.type,
      subject: view.subject,
      peopleCount: view.peopleCount,
      triage: view.triage,
      location: geometry is PointGeometry ? geometry.point : null,
      locationSource: view.event.attributes?['location_source'] == 'MAP_PICK'
          ? CrowdReportLocationSource.mapPick
          : CrowdReportLocationSource.currentLocation,
      locationHint: null,
      description: view.description,
    );
  }

  final RescueRequestType type;
  final RescueSubject subject;
  final int peopleCount;
  final RescueTriage triage;
  final GeoPoint? location;
  final CrowdReportLocationSource? locationSource;
  final CrowdReportLocationHint? locationHint;
  final String description;

  RescueUrgency get urgency => deriveRescueUrgency(type, triage, subject);
  String get urgencyReason => rescueUrgencyReason(type, triage, subject);

  RescueDraft copyWith({
    RescueRequestType? type,
    RescueSubject? subject,
    int? peopleCount,
    RescueTriage? triage,
    Object? location = _unchanged,
    Object? locationSource = _unchanged,
    Object? locationHint = _unchanged,
    String? description,
  }) => RescueDraft(
    type: type ?? this.type,
    subject: subject ?? this.subject,
    peopleCount: peopleCount ?? this.peopleCount,
    triage: triage ?? this.triage,
    location: identical(location, _unchanged) ? this.location : location as GeoPoint?,
    locationSource: identical(locationSource, _unchanged)
        ? this.locationSource
        : locationSource as CrowdReportLocationSource?,
    locationHint: identical(locationHint, _unchanged)
        ? this.locationHint
        : locationHint as CrowdReportLocationHint?,
    description: description ?? this.description,
  );

  String? validate() {
    final point = location;
    if (point == null || locationSource == null) return '請選擇求救位置';
    if (!point.longitude.isFinite ||
        !point.latitude.isFinite ||
        point.longitude < _taiwanBounds[0] ||
        point.longitude > _taiwanBounds[2] ||
        point.latitude < _taiwanBounds[1] ||
        point.latitude > _taiwanBounds[3]) {
      return '求救位置不在支援範圍內';
    }
    if (peopleCount < 1 || peopleCount > rescuePeopleMax) return '人數需介於 1 到 50';
    if (description.trim().runes.length > rescueDescriptionMaxCodePoints) return '描述不可超過 160 字';
    return null;
  }

  Map<String, Object?> toArguments() {
    final error = validate();
    if (error != null) throw FormatException(error);
    final point = location!;
    return <String, Object?>{
      'request_type': type.wireValue,
      'subject': subject.wireValue,
      'people_count': peopleCount,
      'triage': triage.toWire(subject),
      'description': description.trim(),
      'location': <String, Object?>{
        'lon': point.longitude,
        'lat': point.latitude,
        'source': locationSource!.wireValue,
      },
      if (locationHint != null) 'location_hint': locationHint!.toChannelArguments(),
    };
  }
}

bool isRescueEvent(MeshEvent event) =>
    event.namespace == rescueNamespace && event.eventType == rescueEventType;

final class RescueRequestView {
  const RescueRequestView._({
    required this.event,
    required this.type,
    required this.status,
    required this.subject,
    required this.peopleCount,
    required this.triage,
    required this.description,
    required this.urgency,
    required this.firstIssuedAt,
    required this.expiresAt,
  });

  final MeshEvent event;
  final RescueRequestType type;
  final RescueStatus status;
  final RescueSubject subject;
  final int peopleCount;
  final RescueTriage triage;
  final String description;
  final RescueUrgency urgency;
  final DateTime firstIssuedAt;
  final DateTime expiresAt;

  String get eventId => event.eventId ?? '';

  static RescueRequestView? fromEvent(MeshEvent event) {
    if (!isRescueEvent(event)) return null;
    final attributes = event.attributes ?? const <String, dynamic>{};
    final type = rescueRequestTypeFromWire(attributes['request_type']);
    final status = rescueStatusFromWire(attributes['status']);
    final subject = switch (attributes['subject']) {
      'SELF' => RescueSubject.self,
      'OTHERS' => RescueSubject.others,
      _ => null,
    };
    final people = attributes['people_count'];
    final triage = RescueTriage.fromWire(attributes['triage']);
    final urgency = rescueUrgencyFromWire(event.severity);
    final first = DateTime.tryParse('${attributes['first_issued_at']}')?.toUtc();
    final expires = DateTime.tryParse(event.expiresAt ?? '')?.toUtc();
    if (type == null || status == null || subject == null || people is! int ||
        triage == null || urgency == null || first == null || expires == null) {
      return null;
    }
    final description = attributes['description'];
    return RescueRequestView._(
      event: event,
      type: type,
      status: status,
      subject: subject,
      peopleCount: people,
      triage: triage,
      description: description is String ? description : '',
      urgency: urgency,
      firstIssuedAt: first,
      expiresAt: expires,
    );
  }

  bool isActiveAt(DateTime now) => status == RescueStatus.active && expiresAt.isAfter(now.toUtc());

  /// Extension is allowed while active and before the 72 hour cap.
  bool canExtendAt(DateTime now) =>
      isActiveAt(now) && expiresAt.isBefore(firstIssuedAt.add(const Duration(hours: 72)));
}

enum RescueDelivery { meshPending, waitingUpload, uploading, accepted, rejected }

extension RescueDeliveryLabel on RescueDelivery {
  String get label => switch (this) {
    RescueDelivery.meshPending => '已存於本機，等待附近裝置轉傳',
    RescueDelivery.waitingUpload => '等待上傳，尚未送出',
    RescueDelivery.uploading => '上傳中',
    RescueDelivery.accepted => '伺服器已接收，仍未經查證',
    RescueDelivery.rejected => '未送出',
  };
}

const _reasonLabels = <String, String>{
  'rescue_active_exists': '此裝置已有進行中的求救',
  'network_unavailable': '目前無法連線',
  'server_unavailable': '伺服器尚未開放求救接收',
  'rate_limited': '送出太頻繁，稍後自動重試',
};

final class RescueSession {
  const RescueSession({
    required this.request,
    required this.meshPending,
    required this.server,
    this.reason,
  });

  final RescueRequestView request;

  /// Android only: stored in Room and waiting for nearby devices to relay it.
  final bool meshPending;
  final RescueDelivery server;
  final String? reason;

  factory RescueSession.fromMessage(Map<String, dynamic> message) {
    final raw = message['request'];
    if (raw is! Map) throw const FormatException('rescue session is missing request');
    final view = RescueRequestView.fromEvent(MeshEvent.fromJson(Map<String, dynamic>.from(raw)));
    if (view == null) throw const FormatException('rescue session request is not a rescue event');
    final delivery = message['delivery_state'];
    final meshPending = delivery == 'PENDING';
    final serverWire = meshPending ? message['server_state'] : delivery;
    final server = switch (serverWire) {
      'ACCEPTED' => RescueDelivery.accepted,
      'REJECTED' => RescueDelivery.rejected,
      'UPLOADING' => RescueDelivery.uploading,
      'WAITING_UPLOAD' || 'NOT_UPLOADED' => RescueDelivery.waitingUpload,
      _ => throw const FormatException('rescue session has an unknown delivery state'),
    };
    final reason = message['reason'] ?? message['server_reason'];
    return RescueSession(
      request: view,
      meshPending: meshPending,
      server: server,
      reason: reason is String ? reason : null,
    );
  }

  String deliveryText() {
    final reasonText = reason == null ? null : (_reasonLabels[reason] ?? reason);
    final serverText = server == RescueDelivery.rejected
        ? '未送出：${reasonText ?? '伺服器拒絕'}'
        : server.label;
    return meshPending ? '${RescueDelivery.meshPending.label}；伺服器：$serverText' : serverText;
  }
}
