import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/data/government_http_response.dart';
import 'package:resilientgeo_flutter/data/government_session_store.dart';

class _MemorySessionStore implements GovernmentSessionStore {
  @override
  Future<String?> read() async => null;

  @override
  Future<void> write(String value) async {}

  @override
  Future<void> clear() async {}
}

void main() {
  for (final method in <String>['POST', 'PUT']) {
    test(
      '$method announcement refuses a workbench API without scope support',
      () async {
        final calls = <String>[];
        final api = GovernmentApiClient(
          baseUri: () async => Uri.parse('https://example.test/api/v1/'),
          sessionStore: _MemorySessionStore(),
          httpSender: ({
            required method,
            required uri,
            required headers,
            body,
          }) async {
            calls.add('$method ${uri.path}');
            if (uri.path == '/api/v1/healthz') {
              return const GovernmentHttpResponse(
                statusCode: 200,
                body: '{"status":"ok"}',
              );
            }
            return const GovernmentHttpResponse(
              statusCode: 202,
              body: '{"event_id":"announcement:test","event_version":1}',
            );
          },
        );

        final input = <String, Object?>{
          'title': '中壢物資站',
          'affected_area_ids': <String>['tw.68000020'],
        };
        Future<Map<String, dynamic>> send() =>
            method == 'POST'
                ? api.createAnnouncement(input)
                : api.reviseAnnouncement('announcement:test', input);

        await expectLater(
          send(),
          throwsA(
            isA<GovernmentApiException>().having(
              (error) => error.code,
              'code',
              'announcement_scope_unsupported',
            ),
          ),
        );
        expect(calls, <String>['GET /api/v1/healthz']);
      },
    );
  }

  test('scope-aware API allows an announcement mutation', () async {
    final calls = <String>[];
    final api = GovernmentApiClient(
      baseUri: () async => Uri.parse('https://example.test/api/v1/'),
      sessionStore: _MemorySessionStore(),
      httpSender: ({
        required method,
        required uri,
        required headers,
        body,
      }) async {
        calls.add('$method ${uri.path}');
        if (uri.path == '/api/v1/healthz') {
          return const GovernmentHttpResponse(
            statusCode: 200,
            body:
                '{"status":"ok","announcement_scope_schema":"affected_area_ids-v1"}',
          );
        }
        expect(jsonDecode(body!)['affected_area_ids'], <String>['tw.68000020']);
        return const GovernmentHttpResponse(
          statusCode: 202,
          body: '{"event_id":"announcement:test","event_version":1}',
        );
      },
    );

    final result = await api.createAnnouncement(<String, Object?>{
      'title': '中壢物資站',
      'affected_area_ids': <String>['tw.68000020'],
    });

    expect(result['event_id'], 'announcement:test');
    expect(calls, <String>[
      'GET /api/v1/healthz',
      'POST /api/v1/government/announcements',
    ]);
  });
}
