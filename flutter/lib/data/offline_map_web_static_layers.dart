import 'offline_map_web_static_layers_stub.dart'
    if (dart.library.html) 'offline_map_web_static_layers_web.dart'
    as implementation;

Future<String> loadWebNLSCStaticLayers() =>
    implementation.loadWebNLSCStaticLayers();
