import 'dart:convert';
import 'dart:io';

import 'government_http_response.dart';

Future<GovernmentHttpResponse> sendGovernmentHttp({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  String? body,
}) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
  try {
    final request = await client.openUrl(method, uri);
    headers.forEach(request.headers.set);
    if (body != null) request.add(utf8.encode(body));
    final response = await request.close().timeout(const Duration(seconds: 20));
    final responseBody = await response.transform(utf8.decoder).join();
    return GovernmentHttpResponse(
      statusCode: response.statusCode,
      body: responseBody,
    );
  } finally {
    client.close(force: true);
  }
}
