import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/services.dart';

import 'crowd_report_models.dart';

@JS('ResilientGeoCrowdSigner.sign')
external JSPromise<JSString> _signCrowdReport(JSString input);

Future<Map<String, dynamic>> createSignedBrowserCrowdReport(
  CrowdReportDraft draft,
) async {
  final error = draft.validate();
  if (error != null) throw FormatException(error);
  try {
    final raw =
        (await _signCrowdReport(
              jsonEncode(draft.toChannelArguments()).toJS,
            ).toDart)
            .toDart;
    final value = jsonDecode(raw);
    if (value is! Map) {
      throw const FormatException('Browser signer returned an invalid report');
    }
    return Map<String, dynamic>.from(value);
  } on Object catch (error) {
    throw PlatformException(code: 'signing_unavailable', message: '$error');
  }
}
