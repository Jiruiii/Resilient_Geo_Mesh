import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/debug/mesh_drill_app.dart';

void main() {
  test('explains the disabled load buttons only while a drill sync is running', () {
    final hint = drillRunningHint(running: true);
    expect(hint, contains('停止演練同步'));
    expect(hint, contains('無法載入'));
    expect(drillRunningHint(running: false), isNull);
  });
}
