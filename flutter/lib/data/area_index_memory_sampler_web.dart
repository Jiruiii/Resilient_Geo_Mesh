import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:math' as math;

class AreaIndexMemorySampler {
  Timer? _timer;
  int? _peak;

  Future<void> start() async {
    _capture();
    _timer = Timer.periodic(
      const Duration(milliseconds: 10),
      (_) => _capture(),
    );
  }

  int? get currentResidentBytes => _usedHeapBytes();

  Future<int?> stop() async {
    _capture();
    _timer?.cancel();
    return _peak;
  }

  void _capture() {
    final value = _usedHeapBytes();
    if (value != null) _peak = math.max(_peak ?? value, value);
  }

  int? _usedHeapBytes() {
    try {
      final performance = globalContext['performance'];
      if (performance == null || !performance.isA<JSObject>()) return null;
      final memory = (performance as JSObject)['memory'];
      if (memory == null || !memory.isA<JSObject>()) return null;
      final used = (memory as JSObject)['usedJSHeapSize'];
      return used != null && used.isA<JSNumber>()
          ? (used as JSNumber).toDartDouble.toInt()
          : null;
    } on Object {
      return null;
    }
  }
}

AreaIndexMemorySampler createAreaIndexMemorySampler() =>
    AreaIndexMemorySampler();

String get platformName => 'web';
