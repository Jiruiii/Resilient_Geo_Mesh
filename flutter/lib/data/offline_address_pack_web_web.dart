import 'dart:js_interop';

@JS('loadNLSCAddressCatalog')
external JSPromise<JSString> _loadNLSCAddressCatalog();

@JS('loadInstalledNLSCAddressPacks')
external JSPromise<JSString> _loadInstalledNLSCAddressPacks();

@JS('downloadNLSCAddressPack')
external JSPromise<JSString> _downloadNLSCAddressPack(JSString countyCode);

@JS('getNLSCAddressPackProgress')
external JSString _getNLSCAddressPackProgress(JSString countyCode);

@JS('searchNLSCAddressPacks')
external JSPromise<JSString> _searchNLSCAddressPacks(JSString query);

Future<String> loadWebAddressPackCatalog() async =>
    (await _loadNLSCAddressCatalog().toDart).toDart;

Future<String> loadWebInstalledAddressPacks() async =>
    (await _loadInstalledNLSCAddressPacks().toDart).toDart;

Future<String> downloadWebAddressPack(String countyCode) async =>
    (await _downloadNLSCAddressPack(countyCode.toJS).toDart).toDart;

Future<String> loadWebAddressPackProgress(String countyCode) async =>
    _getNLSCAddressPackProgress(countyCode.toJS).toDart;

Future<String> searchWebAddressPacks(String query) async =>
    (await _searchNLSCAddressPacks(query.toJS).toDart).toDart;
