import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

abstract interface class GovernmentAccountCache {
  Future<Map<String, dynamic>?> read();
  Future<void> write(Map<String, dynamic> user);
  Future<void> clear();
}

class SharedPreferencesGovernmentAccountCache
    implements GovernmentAccountCache {
  static const _storageKey = 'government.cached_account.v1';

  @override
  Future<Map<String, dynamic>?> read() async {
    final preferences = await SharedPreferences.getInstance();
    final value = preferences.getString(_storageKey);
    if (value == null) return null;
    try {
      final decoded = jsonDecode(value);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(Map<String, dynamic> user) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_storageKey, jsonEncode(user));
  }

  @override
  Future<void> clear() async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.remove(_storageKey);
  }
}
