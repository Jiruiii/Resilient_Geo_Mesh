import 'dart:convert';
import 'dart:js_interop';

import 'government_http_response.dart';

@JS('ResilientGeoHttp.request')
external JSPromise<JSString> _requestGovernmentHttp(
  JSString method,
  JSString url,
  JSString headers,
  JSString body,
);

Future<GovernmentHttpResponse> sendGovernmentHttp({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  String? body,
}) async {
  final raw =
      (await _requestGovernmentHttp(
            method.toJS,
            uri.toString().toJS,
            jsonEncode(headers).toJS,
            (body ?? '').toJS,
          ).toDart)
          .toDart;
  final value = jsonDecode(raw);
  if (value is! Map || value['status'] is! int || value['body'] is! String) {
    throw const FormatException(
      'Government API returned an invalid HTTP response',
    );
  }
  return GovernmentHttpResponse(
    statusCode: value['status'] as int,
    body: value['body'] as String,
  );
}
