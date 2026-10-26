import 'dart:js_interop';

@JS('fetch')
external JSPromise<_FetchResponse> _fetch(JSString url, _FetchInit init);

extension type _FetchInit._(JSObject _) implements JSObject {
  external factory _FetchInit({JSString cache, JSString mode});
}

extension type _FetchResponse._(JSObject _) implements JSObject {
  external bool get ok;
}

/// `no-store` keeps a cached tile from reporting NLSC as reachable offline.
Future<bool> probeEmapTile(Uri uri) async {
  try {
    final response = await _fetch(
      uri.toString().toJS,
      _FetchInit(cache: 'no-store'.toJS, mode: 'cors'.toJS),
    ).toDart.timeout(const Duration(seconds: 8));
    return response.ok;
  } on Object {
    return false;
  }
}
