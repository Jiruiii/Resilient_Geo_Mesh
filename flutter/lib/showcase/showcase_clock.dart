import 'package:flutter/foundation.dart';

/// A compile-time Web-only clock for the published walkthrough.
abstract final class ShowcaseClock {
  static const bool enabled = kIsWeb && bool.fromEnvironment('SHOWCASE_MODE');
  static final DateTime scenarioTime = DateTime.utc(2026, 11, 4, 2);

  static DateTime now() => enabled ? scenarioTime : DateTime.now();
}
