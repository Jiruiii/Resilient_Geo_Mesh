import 'offline_address_pack_web_stub.dart'
    if (dart.library.html) 'offline_address_pack_web_web.dart'
    as implementation;

Future<String> loadWebAddressPackCatalog() =>
    implementation.loadWebAddressPackCatalog();

Future<String> loadWebInstalledAddressPacks() =>
    implementation.loadWebInstalledAddressPacks();

Future<String> downloadWebAddressPack(String countyCode) =>
    implementation.downloadWebAddressPack(countyCode);

Future<String> loadWebAddressPackProgress(String countyCode) =>
    implementation.loadWebAddressPackProgress(countyCode);

Future<String> searchWebAddressPacks(String query) =>
    implementation.searchWebAddressPacks(query);
