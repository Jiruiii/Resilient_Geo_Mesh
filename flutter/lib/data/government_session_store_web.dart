import 'government_session_store.dart';

class _WebGovernmentSessionStore implements GovernmentSessionStore {
  @override
  Future<String?> read() async => null;

  @override
  Future<void> write(String token) async {}

  @override
  Future<void> clear() async {}
}

GovernmentSessionStore createGovernmentSessionStore() =>
    _WebGovernmentSessionStore();
