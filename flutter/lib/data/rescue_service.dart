import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'map_bridge.dart';
import 'map_models.dart';
import 'rescue_request_models.dart';
import 'rescue_web.dart';

enum RescueFailureCode {
  unsupported,
  invalidInput,
  conflict,
  rateLimited,
  signingUnavailable,
  storageUnavailable,
  serverUnavailable,
  unknown,
}

final class RescueFailure implements Exception {
  const RescueFailure({required this.code, required this.message, this.retryAfterSeconds});

  final RescueFailureCode code;

  /// A contract code or platform message; never shown verbatim when a
  /// friendlier sentence exists, and never contains the description.
  final String message;
  final int? retryAfterSeconds;

  String userMessage() => switch (code) {
    RescueFailureCode.unsupported => '此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲',
    RescueFailureCode.invalidInput => '求救資料無效，未送出',
    RescueFailureCode.conflict => switch (message) {
      'rescue_active_exists' => '此裝置已有進行中的求救，請先更新或結束它',
      'rescue_revision_expired' => '這筆求救已過期，請重新建立',
      'rescue_extend_not_later' => '已達 72 小時上限，無法再延長，請重新建立',
      'rescue_revision_terminal' || 'rescue_terminal' => '這筆求救已結束',
      _ => '求救狀態已變更，請重新整理',
    },
    RescueFailureCode.rateLimited => '請稍候 ${retryAfterSeconds ?? 30} 秒再更新',
    RescueFailureCode.signingUnavailable => '裝置安全簽署不可用，求救未送出',
    RescueFailureCode.storageUnavailable => '無法儲存求救，未送出',
    RescueFailureCode.serverUnavailable => '伺服器尚未開放求救接收',
    RescueFailureCode.unknown => '求救未送出，請稍後再試',
  };

  @override
  String toString() => 'RescueFailure($code): $message';
}

final class RescueCapabilities {
  const RescueCapabilities({
    required this.canSign,
    required this.canVerify,
    required this.hasStorage,
    required this.supportsMesh,
  });

  final bool canSign;
  final bool canVerify;
  final bool hasStorage;
  final bool supportsMesh;
}

final class RescueBounds {
  const RescueBounds({required this.minLon, required this.minLat, required this.maxLon, required this.maxLat});

  /// The server accepts at most 0.05 degrees per side.
  factory RescueBounds.around(GeoPoint center, {double halfSpan = 0.024}) => RescueBounds(
    minLon: center.longitude - halfSpan,
    minLat: center.latitude - halfSpan,
    maxLon: center.longitude + halfSpan,
    maxLat: center.latitude + halfSpan,
  );

  final double minLon;
  final double minLat;
  final double maxLon;
  final double maxLat;

  List<double> toList() => <double>[minLon, minLat, maxLon, maxLat];
}

abstract class RescueService {
  Future<RescueCapabilities> capabilities();
  Future<RescueSession> submit(RescueDraft draft);
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft});
  Future<List<RescueSession>> ownSessions();
  Future<List<RescueSession>> flush();

  /// Web: verified ACTIVE requests from the server, merged into the map.
  /// Android: asks the native side to download and ingest them through Room,
  /// so they arrive on the normal event stream; returns an empty list.
  Future<List<MeshEvent>> nearby(RescueBounds bounds);

  static RescueService forPlatform({required MapBridge bridge, bool? isWeb}) =>
      (isWeb ?? kIsWeb) ? WebRescueService() : AndroidRescueService(bridge);
}

final class AndroidRescueService implements RescueService {
  AndroidRescueService(this._bridge);

  final MapBridge _bridge;

  @override
  Future<RescueCapabilities> capabilities() async => const RescueCapabilities(
    canSign: true,
    canVerify: true,
    hasStorage: true,
    supportsMesh: true,
  );

  @override
  Future<RescueSession> submit(RescueDraft draft) =>
      _guard(() async => RescueSession.fromMessage(await _bridge.submitRescueRequest(draft.toArguments())));

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) => _guard(
    () async => RescueSession.fromMessage(
      await _bridge.reviseRescueRequest(eventId, action.wireValue, draft?.toArguments()),
    ),
  );

  @override
  Future<List<RescueSession>> ownSessions() => _guard(
    () async => (await _bridge.getOwnRescueRequests()).map(RescueSession.fromMessage).toList(growable: false),
  );

  @override
  Future<List<RescueSession>> flush() => ownSessions();

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) async {
    await _guard(() => _bridge.syncRescueNearby(bounds.toList()));
    return const <MeshEvent>[];
  }

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on MissingPluginException {
      throw const RescueFailure(code: RescueFailureCode.unsupported, message: 'native rescue bridge unavailable');
    } on PlatformException catch (error) {
      final details = error.details;
      final retry = details is Map ? details['retry_after_seconds'] : null;
      throw RescueFailure(
        code: switch (error.code) {
          'invalid_input' => RescueFailureCode.invalidInput,
          'conflict' => RescueFailureCode.conflict,
          'rate_limited' => RescueFailureCode.rateLimited,
          'signing_unavailable' => RescueFailureCode.signingUnavailable,
          'storage_unavailable' => RescueFailureCode.storageUnavailable,
          'server_unavailable' => RescueFailureCode.serverUnavailable,
          _ => RescueFailureCode.unknown,
        },
        message: error.message ?? error.code,
        retryAfterSeconds: retry is int ? retry : null,
      );
    } on FormatException catch (error) {
      throw RescueFailure(code: RescueFailureCode.invalidInput, message: error.message);
    }
  }
}

final class WebRescueService implements RescueService {
  @override
  Future<RescueCapabilities> capabilities() async {
    try {
      final map = await webRescueCall('capabilities') as Map<String, dynamic>;
      return RescueCapabilities(
        canSign: map['signing'] == true,
        canVerify: map['verifying'] == true,
        hasStorage: map['storage'] == true,
        supportsMesh: false,
      );
    } on WebRescueError {
      // Script missing or broken: report the real limitation, never assume support.
      return const RescueCapabilities(canSign: false, canVerify: false, hasStorage: false, supportsMesh: false);
    }
  }

  @override
  Future<RescueSession> submit(RescueDraft draft) => _guard(
    () async => RescueSession.fromMessage(
      await webRescueCall('submit', <Object?>[draft.toArguments()]) as Map<String, dynamic>,
    ),
  );

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) => _guard(
    () async => RescueSession.fromMessage(
      await webRescueCall('revise', <Object?>[eventId, action.wireValue, draft?.toArguments()]) as Map<String, dynamic>,
    ),
  );

  @override
  Future<List<RescueSession>> ownSessions() => _sessions('own');

  @override
  Future<List<RescueSession>> flush() => _sessions('flush');

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) => _guard(() async {
    final map = await webRescueCall('nearby', <Object?>[bounds.toList()]) as Map<String, dynamic>;
    final events = map['events'];
    if (events is! List) return const <MeshEvent>[];
    return events.whereType<Map>().map((event) => MeshEvent.fromJson(Map<String, dynamic>.from(event))).toList(growable: false);
  });

  Future<List<RescueSession>> _sessions(String operation) => _guard(() async {
    final list = await webRescueCall(operation) as List<dynamic>;
    return list.whereType<Map>().map((entry) => RescueSession.fromMessage(Map<String, dynamic>.from(entry))).toList(growable: false);
  });

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on WebRescueError catch (error) {
      final code = error.code;
      if (code.startsWith('rate_limited:')) {
        throw RescueFailure(
          code: RescueFailureCode.rateLimited,
          message: code,
          retryAfterSeconds: int.tryParse(code.substring('rate_limited:'.length)),
        );
      }
      throw RescueFailure(
        code: switch (code) {
          'signing_unsupported' || 'rescue_web_unavailable' => RescueFailureCode.unsupported,
          'storage_unavailable' => RescueFailureCode.storageUnavailable,
          'server_unavailable' => RescueFailureCode.serverUnavailable,
          final value when value.startsWith('rescue_field_invalid') || value == 'rescue_geometry_invalid' =>
            RescueFailureCode.invalidInput,
          'rescue_active_exists' || 'rescue_not_found' || 'rescue_revision_expired' || 'rescue_extend_not_later' ||
          'rescue_revision_terminal' || 'rescue_revision_wrong_device' => RescueFailureCode.conflict,
          _ => RescueFailureCode.unknown,
        },
        message: code,
      );
    }
  }
}
