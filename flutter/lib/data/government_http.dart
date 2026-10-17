import 'government_http_response.dart';
import 'government_http_io.dart'
    if (dart.library.js_interop) 'government_http_web.dart'
    as implementation;

export 'government_http_response.dart';

Future<GovernmentHttpResponse> sendGovernmentHttp({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  String? body,
}) => implementation.sendGovernmentHttp(
  method: method,
  uri: uri,
  headers: headers,
  body: body,
);
