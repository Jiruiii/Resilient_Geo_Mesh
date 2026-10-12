import 'package:flutter/services.dart';

import 'government_session_store.dart';

class _AndroidGovernmentSessionStore implements GovernmentSessionStore {
  static const _channel = MethodChannel(
    'com.resilientgeo.mesh/government-auth',
  );

  @override
  Future<String?> read() => _channel.invokeMethod<String>('readSessionToken');

  @override
  Future<void> write(String token) =>
      _channel.invokeMethod<void>('writeSessionToken', {'token': token});

  @override
  Future<void> clear() => _channel.invokeMethod<void>('clearSessionToken');
}

GovernmentSessionStore createGovernmentSessionStore() =>
    _AndroidGovernmentSessionStore();
