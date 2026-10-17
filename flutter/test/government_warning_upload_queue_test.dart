import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/government_api.dart';
import 'package:resilientgeo_flutter/data/government_http_response.dart';
import 'package:resilientgeo_flutter/data/government_session_store.dart';
import 'package:resilientgeo_flutter/data/government_warning_upload_queue.dart';

class _MemorySessionStore implements GovernmentSessionStore {
  String? token = 'session-token';

  @override
  Future<String?> read() async => token;

  @override
  Future<void> write(String value) async => token = value;

  @override
  Future<void> clear() async => token = null;
}

void main() {
  test(
    'device endpoints preserve authenticated request and response contracts',
    () async {
      final calls =
          <
            ({
              String method,
              Uri uri,
              Map<String, String> headers,
              String? body,
            })
          >[];
      final api = GovernmentApiClient(
        baseUri: () async => Uri.parse('https://example.test/api/v1/'),
        sessionStore: _MemorySessionStore(),
        httpSender: ({
          required method,
          required uri,
          required headers,
          body,
        }) async {
          calls.add((method: method, uri: uri, headers: headers, body: body));
          final response = switch ((method, uri.path)) {
            ('POST', '/api/v1/government/devices') => <String, Object?>{
              'device_id': 'gov-device:1',
              'status': 'PENDING_CERTIFICATE',
            },
            ('GET', '/api/v1/government/devices/current') => <String, Object?>{
              'device_id': 'gov-device:1',
              'status': 'ACTIVE',
              'certificate': <String, Object?>{'certificate_id': 'gov-cert:1'},
            },
            ('POST', '/api/v1/government/devices/current/renew') =>
              <String, Object?>{
                'device_id': 'gov-device:1',
                'status': 'PENDING_CERTIFICATE',
              },
            ('GET', '/api/v1/government/devices') => <String, Object?>{
              'devices': <Object?>[
                <String, Object?>{'device_id': 'gov-device:1'},
              ],
            },
            ('DELETE', '/api/v1/government/devices/gov-device%3A1') =>
              <String, Object?>{
                'device_id': 'gov-device:1',
                'status': 'REVOKED',
              },
            ('POST', '/api/v1/government/warnings') => <String, Object?>{
              'event_id': 'announcement:device:1',
              'payload_hash': 'sha256:warning',
              'publication_status': 'QUEUED',
            },
            _ => <String, Object?>{},
          };
          return GovernmentHttpResponse(
            statusCode: 200,
            body: jsonEncode(response),
          );
        },
      );

      await api.enrollGovernmentDevice(
        signingKeyId: 'device:key',
        signerPublicKey: 'public-key',
      );
      await api.currentGovernmentDevice();
      await api.renewGovernmentDevice();
      await api.listGovernmentDevices();
      await api.revokeGovernmentDevice('gov-device:1');
      await api.uploadGovernmentWarning(<String, dynamic>{
        'event_id': 'announcement:device:1',
        'payload_hash': 'sha256:warning',
      });

      expect(calls.map((call) => '${call.method} ${call.uri.path}'), <String>[
        'POST /api/v1/government/devices',
        'GET /api/v1/government/devices/current',
        'POST /api/v1/government/devices/current/renew',
        'GET /api/v1/government/devices',
        'DELETE /api/v1/government/devices/gov-device%3A1',
        'POST /api/v1/government/warnings',
      ]);
      expect(calls.first.headers['Authorization'], 'Bearer session-token');
      expect(jsonDecode(calls.first.body!), <String, Object?>{
        'signing_key_id': 'device:key',
        'signer_public_key': 'public-key',
      });
      expect(jsonDecode(calls.last.body!)['event_id'], 'announcement:device:1');
    },
  );

  test(
    'failed upload retries the identical signed event and expiry is skipped',
    () async {
      final now = DateTime.utc(2026, 10, 12, 12);
      final event = <String, dynamic>{
        'event_id': 'announcement:device:stable-id',
        'payload_hash': 'sha256:stable-hash',
        'expires_at': now.add(const Duration(hours: 1)).toIso8601String(),
        'signature': 'original-signature',
      };
      final expired = <String, dynamic>{
        ...event,
        'event_id': 'announcement:device:expired',
        'expires_at':
            now.subtract(const Duration(seconds: 1)).toIso8601String(),
      };
      final rows = <Map<String, dynamic>>[
        <String, dynamic>{
          'event_id': event['event_id'],
          'payload_hash': event['payload_hash'],
          'event_json': jsonEncode(event),
          'upload_status': 'PENDING',
        },
        <String, dynamic>{
          'event_id': expired['event_id'],
          'payload_hash': expired['payload_hash'],
          'event_json': jsonEncode(expired),
          'upload_status': 'PENDING',
        },
      ];
      final attempted = <Map<String, dynamic>>[];
      final acknowledged = <String>[];
      var failures = 1;
      final queue = GovernmentWarningUploadQueue(
        pending: () async => rows,
        upload: (value) async {
          attempted.add(Map<String, dynamic>.from(value));
          if (failures-- > 0) {
            throw const GovernmentApiException('request_failed', 503);
          }
          return <String, dynamic>{
            'event_id': value['event_id'],
            'payload_hash': value['payload_hash'],
            'publication_status': 'QUEUED',
          };
        },
        acknowledge: (eventId, _) async {
          acknowledged.add(eventId);
          rows.removeWhere((row) => row['event_id'] == eventId);
          return true;
        },
        now: () => now,
      );

      final first = await queue.flush();
      final second = await queue.flush();

      expect(first.uploaded, 0);
      expect(first.expired, 1);
      expect(second.uploaded, 1);
      expect(second.expired, 1);
      expect(attempted, hasLength(2));
      expect(attempted[0], event);
      expect(attempted[1], event);
      expect(acknowledged, <String>['announcement:device:stable-id']);
    },
  );
}
