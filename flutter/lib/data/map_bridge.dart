import 'package:flutter/services.dart';

import 'bridge_failure.dart';
import 'crowd_report_models.dart';
import 'evacuation_models.dart';
import 'map_models.dart';
import 'sync_status.dart';

/// Typed, read-only access to Android-owned map state.
class MapBridge {
  MapBridge({MethodChannel? methodChannel, EventChannel? eventChannel})
    : _methodChannel = methodChannel ?? const MethodChannel(methodChannelName),
      _eventChannel = eventChannel ?? const EventChannel(eventChannelName);

  static const methodChannelName = 'com.resilientgeo.mesh/map';
  static const eventChannelName = 'com.resilientgeo.mesh/events';

  final MethodChannel _methodChannel;
  final EventChannel _eventChannel;

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

  Future<MapInitialState> getInitialState() async {
    final response = await _invokeRequiredMap('getInitialState');
    return MapInitialState.fromJson(response);
  }

  Future<SyncStatus> getSyncStatus() async {
    try {
      return SyncStatus.fromMessage(await _invokeRequiredMap('getSyncStatus'));
    } catch (error) {
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
    try {
      final response = await _invokeRequiredMap(
        'submitCrowdReport',
        draft.toChannelArguments(),
      );
      return CrowdReportSubmission.fromMessage(response);
    } catch (error) {
      throw _normalizeFeatureError(error);
    }
  }

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
