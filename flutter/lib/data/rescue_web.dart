import 'rescue_web_stub.dart'
    if (dart.library.js_interop) 'rescue_web_web.dart'
    as implementation;

/// Error thrown by the browser rescue script; [code] is a contract code.
final class WebRescueError implements Exception {
  const WebRescueError(this.code);

  final String code;

  @override
  String toString() => 'WebRescueError($code)';
}

/// Calls one function of flutter/web/rescue_outbox.js and decodes its JSON.
/// [operation] is capabilities | submit | revise | own | flush | nearby.
Future<Object?> webRescueCall(String operation, [List<Object?> arguments = const <Object?>[]]) =>
    implementation.webRescueCall(operation, arguments);
