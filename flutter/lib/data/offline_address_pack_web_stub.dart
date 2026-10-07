Future<String> loadWebAddressPackCatalog() async => '';

Future<String> loadWebInstalledAddressPacks() async =>
    '{"counties":[],"records":[]}';

Future<String> downloadWebAddressPack(String countyCode) async => '';

Future<String> loadWebAddressPackProgress(String countyCode) async =>
    '{"state":"idle","loaded":0,"total":0}';

Future<String> searchWebAddressPacks(String query) async => '{"results":[]}';
