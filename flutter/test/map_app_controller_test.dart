import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/map_app_controller.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/offline_government_feed.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });

  test(
    'stream errors preserve data and retry reconnects to native events',
    () async {
      final bridge = _RecoverableBridge();
      final controller = MapAppController(bridge: bridge);
      addTearDown(controller.dispose);
      addTearDown(bridge.updates.close);
      await controller.load();
      bridge.updates.addError(StateError('database unavailable'));
      await pumpEventQueue();
      expect(controller.eventUpdateError, isA<StateError>());
      expect(controller.nativeBridgeAvailable, isTrue);
      await controller.retryEventUpdates();
      expect(controller.eventUpdateError, isNull);
      expect(bridge.subscriptions, 2);
      expect(controller.retryingEvents, isFalse);
      bridge.updates.add(const <MeshEvent>[]);
      await pumpEventQueue();
      expect(controller.eventUpdateError, isNull);
    },
  );

  test('expired alerts leave active app state at their expiry time', () async {
    final expiresAt = DateTime.now().toUtc().add(
      const Duration(milliseconds: 150),
    );
    final event = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.ncdr',
      'event_id': 'ncdr:expiring-test',
      'event_version': 1,
      'event_type': 'NCDR_HAZARD',
      'source': 'NCDR',
      'issued_at': DateTime.now().toUtc().toIso8601String(),
      'expires_at': expiresAt.toIso8601String(),
    });
    final controller = MapAppController(bridge: _InitialEventBridge(event));
    addTearDown(controller.dispose);

    await controller.load();
    expect(controller.events, contains(event));

    await Future<void>.delayed(const Duration(milliseconds: 250));

    expect(controller.events, isEmpty);
    expect(controller.persistedEvents, isEmpty);
  });

  test(
    'native bridge without verified layers fails closed instead of using preview JSON',
    () async {
      final controller = MapAppController(bridge: _EmptyVerifiedBridge());
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.nativeBridgeAvailable, isTrue);
      expect(controller.staticFeatures, isNotNull);
      expect(controller.staticFeatures!.features, isEmpty);
    },
  );

  test(
    'Web does not fall back to the old unverified static snapshot',
    () async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      var assetReads = 0;
      messenger.setMockMessageHandler('flutter/assets', (_) async {
        assetReads++;
        return null;
      });
      addTearDown(
        () => messenger.setMockMessageHandler('flutter/assets', null),
      );

      final controller = MapAppController(
        bridge: _UnavailableBridge(),
        isWeb: true,
        webStaticLayerLoader: () async => '',
        demoEventLoader: () async => <MeshEvent>[],
      );
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.staticFeatures, isNotNull);
      expect(controller.staticFeatures!.features, isEmpty);
      expect(controller.staticFeatureLoadError, isNotNull);
      expect(controller.loadError, isNull);
      expect(assetReads, 0);
    },
  );

  test('Web does not use the bundled NCDR preview as current alerts', () async {
    var demoLoads = 0;
    var feedLoads = 0;
    final event = MeshEvent.fromJson(<String, dynamic>{
      'namespace': 'official.live.ncdr',
      'event_id': 'ncdr:web-feed-test',
      'event_type': 'NCDR_HAZARD',
      'severity': 'HIGH',
      'source': 'NCDR',
      'issued_at': DateTime.now().toUtc().toIso8601String(),
      'expires_at':
          DateTime.now()
              .toUtc()
              .add(const Duration(hours: 1))
              .toIso8601String(),
    });
    final snapshots = <WebGovernmentFeedSnapshot>[
      WebGovernmentFeedSnapshot(revision: 1, events: <MeshEvent>[event]),
      const WebGovernmentFeedSnapshot(revision: 2, events: <MeshEvent>[]),
    ];
    final controller = MapAppController(
      bridge: _UnavailableBridge(),
      isWeb: true,
      webStaticLayerLoader: () async => '',
      webGovernmentFeedLoader: () async => snapshots[feedLoads++],
      demoEventLoader: () async {
        demoLoads++;
        return <MeshEvent>[event];
      },
    );
    addTearDown(controller.dispose);

    await controller.load();
    await pumpEventQueue();

    expect(demoLoads, 0);
    expect(feedLoads, 1);
    expect(controller.events, contains(event));
    expect(controller.initialState.events, contains(event));

    await controller.retryEventUpdates();

    expect(feedLoads, 2);
    expect(controller.events, isEmpty);
    expect(controller.initialState.events, isEmpty);
  });

  test(
    'host without the Android bridge keeps old static points out of the map',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      final controller = MapAppController(
        bridge: _UnavailableBridge(),
        demoEventLoader: () async => <MeshEvent>[],
      );
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.staticFeatures, isNotNull);
      expect(controller.staticFeatures!.features, isEmpty);
      expect(controller.staticFeatureLoadError, isNotNull);
      expect(controller.loadError, isNull);
    },
  );

  test(
    'verified static layers arrive after startup instead of blocking it',
    () async {
      final bridge = _SlowStaticLayerBridge();
      final controller = MapAppController(bridge: bridge);
      addTearDown(controller.dispose);

      await controller.load();

      // The map can render while Android is still verifying.
      expect(controller.isLoading, isFalse);
      expect(controller.staticFeaturesPending, isTrue);
      expect(controller.staticFeatures!.features, isEmpty);

      bridge.completer.complete(<StaticFeature>[
        StaticFeature.fromJson(<String, dynamic>{
          'id': 'shelter:5582',
          'kind': 'shelter',
          'name': '西湖國小',
          'geometry': <String, dynamic>{
            'type': 'Point',
            'coordinates': <double>[121.5657, 25.0838],
          },
        }),
      ]);
      await pumpEventQueue();

      expect(controller.staticFeaturesPending, isFalse);
      expect(controller.staticFeatures!.features.single.id, 'shelter:5582');
    },
  );

  test(
    'a failed static layer verification stays empty and never falls back to preview JSON',
    () async {
      final bridge = _SlowStaticLayerBridge();
      final controller = MapAppController(bridge: bridge);
      addTearDown(controller.dispose);

      await controller.load();
      bridge.completer.completeError(
        PlatformException(code: 'static_layer_invalid'),
      );
      await pumpEventQueue();

      expect(controller.nativeBridgeAvailable, isTrue);
      expect(controller.staticFeaturesPending, isFalse);
      expect(controller.staticFeatureLoadError, isA<PlatformException>());
      expect(controller.staticFeatures!.features, isEmpty);
    },
  );

  test(
    'loads the real NCDR demo snapshot when the native bridge is unavailable',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      final event = MeshEvent.fromJson(<String, dynamic>{
        'namespace': 'official.ncdr',
        'event_id': 'ncdr:demo',
        'event_version': 1,
        'event_type': 'NCDR_HAZARD',
        'source': 'NCDR',
        'issued_at': '2026-09-26T03:00:00Z',
        'expires_at': '2099-01-01T00:00:00Z',
      });
      final controller = MapAppController(
        bridge: _UnavailableBridge(),
        demoEventLoader: () async => <MeshEvent>[event],
      );
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.nativeBridgeAvailable, isFalse);
      expect(controller.events, contains(event));
      expect(controller.initialState.events, contains(event));
    },
  );

  for (final error in <Object>[
    PlatformException(code: 'map_bridge_error', message: 'verification failed'),
    const FormatException('invalid native state'),
    StateError('storage unavailable'),
  ]) {
    test('native failure $error does not load preview data', () async {
      // Exercise a preview-capable platform too: the error type, not just
      // platform detection, must prevent unverified asset fallback.
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      var demoLoads = 0;
      final controller = MapAppController(
        bridge: _FailingBridge(error),
        demoEventLoader: () async {
          demoLoads++;
          return <MeshEvent>[];
        },
      );
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.loadError, same(error));
      expect(controller.staticFeatures, isNull);
      expect(controller.events, isEmpty);
      expect(demoLoads, 0);
      expect(controller.isLoading, isFalse);
    });
  }

  test('missing Android bridge fails closed', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    var demoLoads = 0;
    final controller = MapAppController(
      bridge: _UnavailableBridge(),
      demoEventLoader: () async {
        demoLoads++;
        return <MeshEvent>[];
      },
    );
    addTearDown(controller.dispose);

    await controller.load();

    expect(controller.loadError, isA<MissingPluginException>());
    expect(controller.staticFeatures, isNull);
    expect(demoLoads, 0);
  });

  test('native state loads without reading preview assets', () async {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    var assetReads = 0;
    messenger.setMockMessageHandler('flutter/assets', (_) async {
      assetReads++;
      return null;
    });
    addTearDown(() => messenger.setMockMessageHandler('flutter/assets', null));
    final controller = MapAppController(bridge: _EmptyVerifiedBridge());
    addTearDown(controller.dispose);

    await controller.load();

    expect(controller.loadError, isNull);
    expect(controller.nativeBridgeAvailable, isTrue);
    expect(assetReads, 0);
  });

  test(
    'disposing during startup does not subscribe to native events',
    () async {
      final pending = Completer<MapInitialState>();
      final bridge = _PendingBridge(pending);
      final controller = MapAppController(bridge: bridge);
      final load = controller.load();
      controller.dispose();
      pending.complete(
        const MapInitialState(
          events: <MeshEvent>[],
          emergencyModeEnabled: false,
        ),
      );

      await load;

      expect(bridge.eventSubscriptions, 0);
    },
  );
}

class _EmptyVerifiedBridge extends MapBridge {
  @override
  Future<MapInitialState> getInitialState() async => const MapInitialState(
    events: <MeshEvent>[],
    emergencyModeEnabled: false,
    staticFeatures: <StaticFeature>[],
  );

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();
}

class _InitialEventBridge extends _EmptyVerifiedBridge {
  _InitialEventBridge(this.event);

  final MeshEvent event;

  @override
  Future<MapInitialState> getInitialState() async => MapInitialState(
    events: <MeshEvent>[event],
    emergencyModeEnabled: false,
    staticFeatures: const <StaticFeature>[],
  );
}

class _RecoverableBridge extends _EmptyVerifiedBridge {
  final updates = StreamController<List<MeshEvent>>.broadcast();
  int subscriptions = 0;

  @override
  Stream<List<MeshEvent>> get events {
    subscriptions++;
    return updates.stream;
  }
}

class _SlowStaticLayerBridge extends MapBridge {
  final completer = Completer<List<StaticFeature>>();

  @override
  Future<MapInitialState> getInitialState() async =>
      const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false);

  @override
  Future<List<StaticFeature>> getStaticFeatures() => completer.future;

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();
}

class _UnavailableBridge extends MapBridge {
  @override
  Future<MapInitialState> getInitialState() async {
    throw MissingPluginException('native bridge unavailable');
  }
}

class _FailingBridge extends MapBridge {
  _FailingBridge(this.error);

  final Object error;

  @override
  Future<MapInitialState> getInitialState() async => throw error;
}

class _PendingBridge extends MapBridge {
  _PendingBridge(this.pending);

  final Completer<MapInitialState> pending;
  int eventSubscriptions = 0;

  @override
  Future<MapInitialState> getInitialState() => pending.future;

  @override
  Stream<List<MeshEvent>> get events {
    eventSubscriptions++;
    return const Stream<List<MeshEvent>>.empty();
  }
}
