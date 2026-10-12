import 'package:resilientgeo_flutter/data/map_models.dart';

MeshEvent rescue({String status = 'ACTIVE', String expiresAt = '2026-10-12T09:00:00Z'}) => MeshEvent.fromJson(<String, dynamic>{
  'namespace': 'crowd.rescue',
  'event_id': 'rescue:${'a' * 32}:00000000-0000-4000-8000-000000000001',
  'event_version': 1,
  'event_type': 'RESCUE_REQUEST',
  'severity': 'CRITICAL',
  'source': 'CROWD',
  'issued_at': '2026-10-12T03:00:00Z',
  'expires_at': expiresAt,
  'apply_state': 'UNVERIFIED',
  'geometry': <String, dynamic>{'type': 'Point', 'coordinates': <double>[121.5, 25.0]},
  'signing_key_id': 'device:${'a' * 32}',
  'attributes': <String, dynamic>{
    'request_type': 'TRAPPED_DEBRIS',
    'status': status,
    'subject': 'SELF',
    'people_count': 2,
    'triage': <String, String>{'immobile': 'YES', 'breathing_difficulty': 'NO', 'severe_bleeding': 'NO', 'conscious': 'YES'},
    'description': '',
    'location_source': 'CURRENT_LOCATION',
    'first_issued_at': '2026-10-12T03:00:00Z',
    'area_id': 'crowd',
    'theme': 'rescue',
  },
});
