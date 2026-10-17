import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/rescue_request_models.dart';
import '../data/rescue_service.dart';
import '../widgets/rescue_request_sheet.dart';

/// Rescue flow state shared by Android and Web. Nothing here is persisted:
/// the active request is restored from the platform's own store (Room or the
/// browser's IndexedDB) through [RescueService.ownSessions].
class RescueFlowController extends ChangeNotifier {
  RescueFlowController({required RescueService service, DateTime Function()? clock})
    : _service = service,
      _clock = clock ?? DateTime.now;

  static const reminderWindow = Duration(minutes: 30);
  static const refreshInterval = Duration(seconds: 60);

  final RescueService _service;
  final DateTime Function() _clock;
  Timer? _refreshTimer;
  bool _disposed = false;

  RescueCapabilities? capabilities;
  List<RescueSession> sessions = const <RescueSession>[];
  RescueDraft? draft;
  RescueSheetStep? step;
  String? editingEventId;
  bool busy = false;
  String? errorMessage;
  String? _notice;

  DateTime get now => _clock().toUtc();

  RescueSession? get activeSession {
    final active = sessions.where((session) => session.request.isActiveAt(now)).toList()
      ..sort((a, b) => (b.request.event.eventVersion ?? 0).compareTo(a.request.event.eventVersion ?? 0));
    return active.isEmpty ? null : active.first;
  }

  bool get showsSirenShortcut => activeSession?.request.type == RescueRequestType.trappedDebris;

  bool get expiryReminderDue {
    final active = activeSession;
    if (active == null || !active.request.canExtendAt(now)) return false;
    return active.request.expiresAt.difference(now) <= reminderWindow;
  }

  /// The latest own request that ran out while still ACTIVE, within a day.
  /// An expired request cannot be extended; it can only be filed again.
  RescueSession? get expiredSession {
    if (activeSession != null) return null;
    final expired = sessions.where((session) {
      final request = session.request;
      return request.status == RescueStatus.active &&
          !request.expiresAt.isAfter(now) &&
          now.difference(request.expiresAt) < const Duration(hours: 24);
    }).toList()
      ..sort((a, b) => b.request.expiresAt.compareTo(a.request.expiresAt));
    return expired.isEmpty ? null : expired.first;
  }

  Future<void> load() async {
    try {
      capabilities = await _service.capabilities();
      sessions = await _service.ownSessions();
    } on RescueFailure catch (failure) {
      errorMessage = failure.userMessage();
    }
    _refreshTimer ??= Timer.periodic(refreshInterval, (_) => unawaited(refresh()));
    _notify();
  }

  Future<void> refresh() async {
    try {
      sessions = await _service.flush();
    } on RescueFailure {
      // Keep the last known sessions; delivery text already says what is pending.
    }
    _notify();
  }

  void startNew() {
    draft = RescueDraft.initial();
    editingEventId = null;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void startRecreate() {
    final expired = expiredSession;
    if (expired == null) return;
    draft = RescueDraft.fromView(expired.request);
    editingEventId = null;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void startUpdate() {
    final active = activeSession;
    if (active == null) return;
    draft = RescueDraft.fromView(active.request);
    editingEventId = active.request.eventId;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void closeSheet() {
    if (busy) return;
    draft = null;
    step = null;
    editingEventId = null;
    errorMessage = null;
    _notify();
  }

  void updateDraft(RescueDraft next) {
    draft = next;
    _notify();
  }

  void showConfirmation() {
    final error = draft?.validate();
    if (error != null) {
      errorMessage = error;
      _notify();
      return;
    }
    errorMessage = null;
    step = RescueSheetStep.confirm;
    _notify();
  }

  void backToEdit() {
    step = RescueSheetStep.edit;
    _notify();
  }

  Future<void> submit() async {
    final current = draft;
    if (current == null || busy) return;
    final eventId = editingEventId;
    await _run(() async {
      final session = eventId == null
          ? await _service.submit(current)
          : await _service.revise(eventId, RescueAction.update, draft: current);
      _replace(session);
      draft = null;
      step = null;
      editingEventId = null;
      _notice = eventId == null ? '求救已建立：未經查證' : '求救已更新：未經查證';
    });
  }

  Future<void> extend() => _revise(RescueAction.extend, '求救已延長');
  Future<void> resolve() => _revise(RescueAction.resolve, '已標記為安全／已獲救');
  Future<void> cancelRequest() => _revise(RescueAction.cancel, '求救已取消');

  String? consumeNotice() {
    final value = _notice;
    _notice = null;
    return value;
  }

  Future<void> _revise(RescueAction action, String notice) async {
    final active = activeSession;
    if (active == null || busy) return;
    await _run(() async {
      _replace(await _service.revise(active.request.eventId, action));
      _notice = notice;
    });
  }

  Future<void> _run(Future<void> Function() work) async {
    busy = true;
    errorMessage = null;
    _notify();
    try {
      await work();
    } on RescueFailure catch (failure) {
      errorMessage = failure.userMessage();
      _notice = step == null ? failure.userMessage() : null;
    } finally {
      busy = false;
      _notify();
    }
  }

  void _replace(RescueSession session) {
    sessions = <RescueSession>[
      for (final existing in sessions)
        if (existing.request.eventId != session.request.eventId) existing,
      session,
    ];
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _refreshTimer?.cancel();
    super.dispose();
  }
}
