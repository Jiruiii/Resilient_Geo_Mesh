import 'dart:convert';
import 'dart:js_interop';

import 'rescue_web.dart';

@JS('rescueCapabilities')
external JSPromise<JSString> _capabilities();

@JS('rescueSubmit')
external JSPromise<JSString> _submit(JSString argsJson);

@JS('rescueRevise')
external JSPromise<JSString> _revise(JSString eventId, JSString action, JSString argsJson);

@JS('rescueOwnSessions')
external JSPromise<JSString> _own();

@JS('rescueFlush')
external JSPromise<JSString> _flush();

@JS('rescueNearby')
external JSPromise<JSString> _nearby(JSString bboxJson);

/// Every rescue_outbox.js export resolves to `{ ok, value | error }` and
/// never rejects, so no JS exception has to cross into Dart.
Future<Object?> webRescueCall(String operation, List<Object?> arguments) async {
  JSPromise<JSString> promise;
  try {
    promise = switch (operation) {
      'capabilities' => _capabilities(),
      'submit' => _submit(jsonEncode(arguments[0]).toJS),
      'revise' => _revise(
        (arguments[0] as String).toJS,
        (arguments[1] as String).toJS,
        (arguments[2] == null ? '' : jsonEncode(arguments[2])).toJS,
      ),
      'own' => _own(),
      'flush' => _flush(),
      'nearby' => _nearby(jsonEncode(arguments[0]).toJS),
      _ => throw ArgumentError.value(operation, 'operation'),
    };
  } on Object {
    throw const WebRescueError('rescue_web_unavailable');
  }
  final envelope = jsonDecode((await promise.toDart).toDart);
  if (envelope is! Map || envelope['ok'] is! bool) throw const WebRescueError('rescue_web_unavailable');
  if (envelope['ok'] != true) throw WebRescueError('${envelope['error']}');
  return envelope['value'];
}
