import 'government_session_store_io.dart'
    if (dart.library.js_interop) 'government_session_store_web.dart'
    as implementation;

abstract interface class GovernmentSessionStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

GovernmentSessionStore createGovernmentSessionStore() =>
    implementation.createGovernmentSessionStore();
