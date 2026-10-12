import 'package:flutter/foundation.dart';
import 'dart:convert';
import 'package:flutter/services.dart';

import 'bridge_failure.dart';
import 'crowd_report_signer.dart';
import 'crowd_report_upload_queue.dart';
import 'crowd_report_models.dart';
import 'evacuation_models.dart';
import 'government_api.dart';
import 'map_models.dart';
import 'sync_status.dart';

/// Typed, read-only access to Android-owned map state.
class MapBridge {
  MapBridge({
    MethodChannel? methodChannel,
    EventChannel? eventChannel,
    GovernmentApiClient? governmentApi,
    CrowdReportUploadQueue? uploadQueue,
  }) : _methodChannel = methodChannel ?? const MethodChannel(methodChannelName),
       _eventChannel = eventChannel ?? const EventChannel(eventChannelName),
       _governmentApi = governmentApi ?? GovernmentApiClient(),
       _uploadQueue = uploadQueue ?? CrowdReportUploadQueue();

  static const methodChannelName = 'com.resilientgeo.mesh/map';
  static const eventChannelName = 'com.resilientgeo.mesh/events';

  final MethodChannel _methodChannel;
  final EventChannel _eventChannel;
  final GovernmentApiClient _governmentApi;
  final CrowdReportUploadQueue _uploadQueue;

  Future<Map<String, dynamic>> getGovernmentSyncStatus() =>
      _invokeRequiredMap('getGovernmentSyncStatus');

  Future<Map<String, dynamic>> configureGovernmentSync({
    required String url,
    required bool enabled,
    String area = 'all',
  }) => _invokeRequiredMap('configureGovernmentSync', {
    'url': url,
    'enabled': enabled,
    'area': area,
  });

  Future<Map<String, dynamic>> syncGovernmentNow() =>
      _invokeRequiredMap('syncGovernmentNow');

  Future<Map<String, dynamic>> getGovernmentDevicePublicKey() =>
      _invokeRequiredMap('getGovernmentDevicePublicKey');

  Future<Map<String, dynamic>> storeGovernmentDeviceCertificate(
    Map<String, dynamic> certificate,
  ) => _invokeRequiredMap('storeGovernmentDeviceCertificate', <String, dynamic>{
    'certificate_json': jsonEncode(certificate),
  });

  Future<Map<String, dynamic>> getGovernmentDeviceAuthorization() =>
      _invokeRequiredMap('getGovernmentDeviceAuthorization');

  Future<Map<String, dynamic>> createGovernmentWarning(
    Map<String, Object?> input,
  ) => _invokeRequiredMap('createGovernmentWarning', input);

  Future<List<Map<String, dynamic>>> listPendingGovernmentWarningUploads() =>
      _invokeRequiredMapList('listPendingGovernmentWarningUploads');

  Future<List<Map<String, dynamic>>> listGovernmentWarningStatuses() =>
      _invokeRequiredMapList('listGovernmentWarningStatuses');

  Future<bool> markGovernmentWarningUploaded({
    required String eventId,
    required String payloadHash,
  }) async {
    final response = await _invokeRequiredMap('markGovernmentWarningUploaded', {
      'event_id': eventId,
      'payload_hash': payloadHash,
    });
    if (response['uploaded'] is! bool) {
      throw const FormatException(
        'markGovernmentWarningUploaded response is missing boolean uploaded',
      );
    }
    return response['uploaded'] as bool;
  }

  Future<bool> markGovernmentWarningExpired({
    required String eventId,
    required String payloadHash,
  }) async {
    final response = await _invokeRequiredMap('markGovernmentWarningExpired', {
      'event_id': eventId,
      'payload_hash': payloadHash,
    });
    if (response['expired'] is! bool) {
      throw const FormatException(
        'markGovernmentWarningExpired response is missing boolean expired',
      );
    }
    return response['expired'] as bool;
  }

  Future<List<Map<String, dynamic>>> _invokeRequiredMapList(
    String method,
  ) async {
    final response = await _methodChannel.invokeMethod<Object?>(method);
    if (response is! List) {
      throw FormatException('$method response must be a list');
    }
    return response
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  Future<MapInitialState> getInitialState() async {
    final response = await _invokeRequiredMap('getInitialState');
    return MapInitialState.fromJson(response);
  }

  Future<SyncStatus> getSyncStatus() async {
    try {
      return SyncStatus.fromMessage(await _invokeRequiredMap('getSyncStatus'));
    } catch (error) {
      if (error is GovernmentApiException) rethrow;
      throw _normalizeFeatureError(error);
    }
  }

  Future<SyncStatus> setSyncTransport(String transport) async =>
      SyncStatus.fromMessage(
        await _invokeRequiredMap('setSyncTransport', {'transport': transport}),
      );

  /// Verified nationwide static layers. Android verifies them in the
  /// background, so the first call after install can take several seconds;
  /// it never returns unverified data.
  Future<List<StaticFeature>> getStaticFeatures() async {
    final response = await _invokeRequiredMap('getStaticFeatures');
    if (response['static_features'] is! List) {
      throw const FormatException(
        'getStaticFeatures response is missing static_features',
      );
    }
    return staticFeaturesFromMessage(response['static_features']);
  }

  Future<FixtureLoadSummary> loadBundledFixture() async {
    final response = await _invokeRequiredMap('loadBundledFixture');
    return FixtureLoadSummary.fromJson(response);
  }

  Future<bool> setEmergencyMode({required bool enabled}) async {
    final response = await _invokeRequiredMap(
      'setEmergencyMode',
      <String, dynamic>{'enabled': enabled},
    );
    final responseEnabled = response['enabled'];
    if (responseEnabled is! bool) {
      throw const FormatException(
        'setEmergencyMode response is missing boolean enabled',
      );
    }
    return responseEnabled;
  }

  Future<CrowdReportSubmission> submitCrowdReport(
    CrowdReportDraft draft,
  ) async {
    if (kIsWeb) {
      final event = await createSignedBrowserCrowdReport(draft);
      final response = await _governmentApi.uploadCrowdReport(event);
      if (response['event_id'] != event['event_id'] ||
          response['verification_status'] != 'UNVERIFIED') {
        throw const FormatException(
          'Crowd report upload response did not preserve the unverified state',
        );
      }
      return CrowdReportSubmission(
        eventId: event['event_id'] as String,
        applyState: 'UNVERIFIED',
        deliveryState: 'UPLOADED',
        event: event,
      );
    }
    try {
      final response = await _invokeRequiredMap(
        'submitCrowdReport',
        draft.toChannelArguments(),
      );
      final submission = CrowdReportSubmission.fromMessage(response);
      final event = submission.event;
      if (event == null) return submission;
      try {
        await _governmentApi.uploadCrowdReport(event);
        return CrowdReportSubmission(
          eventId: submission.eventId,
          applyState: submission.applyState,
          deliveryState: 'UPLOADED',
          event: event,
        );
      } on GovernmentApiException catch (error) {
        if (error.statusCode > 0 && error.statusCode < 500) rethrow;
      } on Object {
        // The local and mesh copy is already durable; queue the signed event for a later online retry.
      }
      await _uploadQueue.enqueue(event);
      return submission;
    } catch (error) {
      throw _normalizeFeatureError(error);
    }
  }

  Future<int> syncPendingCrowdReports() => _uploadQueue.flush(_governmentApi);

  Future<EvacuationRouteResult> calculateEvacuationRoute({
    required GeoPoint origin,
    required ShelterRouteCandidate destination,
    String mode = 'walk',
    DisasterType? disasterType,
  }) async {
    if (mode != 'walk') {
      throw const FormatException(
        'calculateEvacuationRoute supports walk only',
      );
    }
    try {
      final response = await _invokeRequiredMap(
        'calculateEvacuationRoute',
        <String, Object?>{
          'origin': <String, Object?>{
            'lon': origin.longitude,
            'lat': origin.latitude,
          },
          'destination': destination.toChannelArguments(),
          'mode': mode,
          if (disasterType != null) 'disaster_type': disasterType.wireValue,
        },
      );
      return EvacuationRouteResult.fromMessage(response);
    } catch (error) {
      throw _normalizeFeatureError(error);
    }
  }

  Stream<List<MeshEvent>> get events => _eventChannel
      .receiveBroadcastStream()
      .map<List<MeshEvent>>(eventsFromMessage);

  Future<Map<String, dynamic>> _invokeRequiredMap(
    String method, [
    Map<String, dynamic>? arguments,
  ]) async {
    final response = await _methodChannel.invokeMethod<Object?>(
      method,
      arguments,
    );
    return requireMapFromMessage(response, '$method response');
  }

  Object _normalizeFeatureError(Object error) {
    if (error is FormatException || error is BridgeFailure) return error;
    if (error is MissingPluginException) {
      return const BridgeFailure(
        code: BridgeFailureCode.unavailable,
        message: 'Native map feature is unavailable on this host',
      );
    }
    if (error is PlatformException) {
      final code = switch (error.code) {
        'invalid_input' => BridgeFailureCode.invalidInput,
        'signing_unavailable' => BridgeFailureCode.signingUnavailable,
        'government_device_not_authorized' =>
          BridgeFailureCode.signingUnavailable,
        'storage_unavailable' => BridgeFailureCode.storageUnavailable,
        'graph_unavailable' => BridgeFailureCode.graphUnavailable,
        'route_engine_error' => BridgeFailureCode.routeEngineError,
        'map_bridge_error' => BridgeFailureCode.unknown,
        _ => BridgeFailureCode.unknown,
      };
      return BridgeFailure(code: code, message: error.message ?? error.code);
    }
    return BridgeFailure(code: BridgeFailureCode.unknown, message: '$error');
  }
}
