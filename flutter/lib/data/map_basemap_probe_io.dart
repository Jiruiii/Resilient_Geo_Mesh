import 'dart:io';

Future<bool> probeEmapTile(Uri uri) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
  try {
    final request = await client.getUrl(uri);
    request.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    final response = await request.close().timeout(const Duration(seconds: 8));
    await response.drain<void>();
    return response.statusCode == HttpStatus.ok &&
        response.headers.contentType?.primaryType == 'image';
  } on Object {
    return false;
  } finally {
    client.close(force: true);
  }
}
