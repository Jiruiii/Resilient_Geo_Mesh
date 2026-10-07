import 'dart:js_interop';

@JS('loadNLSCStaticLayers')
external JSPromise<JSString> _loadNLSCStaticLayers();

Future<String> loadWebNLSCStaticLayers() async =>
    (await _loadNLSCStaticLayers().toDart).toDart;
