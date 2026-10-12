import 'crowd_report_signer_io.dart'
    if (dart.library.js_interop) 'crowd_report_signer_web.dart'
    as implementation;

import 'crowd_report_models.dart';

Future<Map<String, dynamic>> createSignedBrowserCrowdReport(
  CrowdReportDraft draft,
) => implementation.createSignedBrowserCrowdReport(draft);
