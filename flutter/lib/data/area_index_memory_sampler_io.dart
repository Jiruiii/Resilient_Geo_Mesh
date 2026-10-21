import 'dart:isolate';
import 'dart:io';
import 'dart:async';

class AreaIndexMemorySampler {
  final ReceivePort _samples = ReceivePort();
  final List<int> _values = <int>[];
  Isolate? _sampler;

  Future<void> start() async {
    _samples.listen((value) {
      if (value is int) _values.add(value);
    });
    _sampler = await Isolate.spawn(_sampleResidentMemory, _samples.sendPort);
  }

  int? get currentResidentBytes => ProcessInfo.currentRss;

  Future<int?> stop() async {
    _sampler?.kill(priority: Isolate.immediate);
    _samples.close();
    if (_values.isEmpty) return currentResidentBytes;
    return _values.reduce((left, right) => left > right ? left : right);
  }
}

void _sampleResidentMemory(SendPort sendPort) {
  Timer.periodic(const Duration(milliseconds: 5), (_) {
    sendPort.send(ProcessInfo.currentRss);
  });
}

AreaIndexMemorySampler createAreaIndexMemorySampler() =>
    AreaIndexMemorySampler();

String get platformName => 'native';
