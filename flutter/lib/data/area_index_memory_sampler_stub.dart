class AreaIndexMemorySampler {
  Future<void> start() async {}

  int? get currentResidentBytes => null;

  Future<int?> stop() async => null;
}

AreaIndexMemorySampler createAreaIndexMemorySampler() =>
    AreaIndexMemorySampler();

String get platformName => 'unavailable';
