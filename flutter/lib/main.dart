import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import 'app/map_app_controller.dart';
import 'data/app_performance.dart';
import 'data/map_models.dart';
import 'data/ncdr_map_filter.dart';
import 'data/offline_map_web_protocol.dart';
import 'data/maplibre_web_runtime.dart';
import 'data/siren_controller.dart';
import 'debug/route_validation_app.dart';
import 'debug/mesh_drill_app.dart';
import 'screens/map_screen.dart';
import 'screens/notifications_screen.dart';
import 'screens/profile_screen.dart';
import 'theme/app_theme.dart';
import 'widgets/app_bottom_navigation.dart';
import 'widgets/siren_panel.dart';
import 'widgets/startup_splash.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    // The emulator's Virtual Display path can leave the GL map black while
    // Flutter overlays continue to paint. Create the map as a TextureView.
    MapLibreMap.useHybridComposition = true;
  }
  AppPerformance.register();
  if (kIsWeb) {
    MapLibreWebRuntime.configure();
    await registerOfflineMapProtocol();
  }
  runApp(const ResilientGeoApp());
}

@pragma('vm:entry-point')
void meshDrillMain() {
  if (kReleaseMode) return;
  WidgetsFlutterBinding.ensureInitialized();
  runMeshDrillApp();
}

@pragma('vm:entry-point')
void routeValidationMain() {
  if (kReleaseMode) return;
  WidgetsFlutterBinding.ensureInitialized();
  runRouteValidationApp();
}

class ResilientGeoApp extends StatefulWidget {
  const ResilientGeoApp({super.key});

  @override
  State<ResilientGeoApp> createState() => _ResilientGeoAppState();
}

class _ResilientGeoAppState extends State<ResilientGeoApp> {
  late final MapAppController _controller;
  late final SirenController _siren;

  @override
  void initState() {
    super.initState();
    _controller = MapAppController()..load();
    _siren = SirenController(SirenPlatform.forPlatform());
  }

  @override
  void dispose() {
    _siren.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder:
        (context, _) => MaterialApp(
          debugShowCheckedModeBanner: false,
          themeMode: _controller.themeMode,
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          home: _MapAppHome(controller: _controller, siren: _siren),
        ),
  );
}

class _MapAppHome extends StatefulWidget {
  const _MapAppHome({required this.controller, required this.siren});

  final MapAppController controller;
  final SirenController siren;

  @override
  State<_MapAppHome> createState() => _MapAppHomeState();
}

class _MapAppHomeState extends State<_MapAppHome> {
  int _selectedIndex = 0;
  MeshEvent? _notificationFocusEvent;
  int _notificationFocusRequestId = 0;

  void _openNotificationOnMap(MeshEvent event) {
    unawaited(widget.controller.markEventRead(event));
    final point = meshEventFocusPoint(event);
    if (!isMapVisibleEvent(event) || point == null) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('此通知沒有地圖位置')));
      return;
    }
    setState(() {
      _selectedIndex = 0;
      _notificationFocusEvent = event;
      _notificationFocusRequestId += 1;
    });
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (controller.isLoading) {
      return const StartupSplash();
    }
    if (controller.staticFeatures == null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              '無法載入台灣地圖資料\n${controller.loadError ?? '無資料'}',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      );
    }

    return Scaffold(
      body: Column(
        children: <Widget>[
          if (controller.eventUpdateError != null)
            SafeArea(
              bottom: false,
              child: MaterialBanner(
                content: const Text('事件更新失敗，目前保留最後一份已驗證資料'),
                actions: <Widget>[
                  TextButton(
                    onPressed:
                        controller.retryingEvents
                            ? null
                            : controller.retryEventUpdates,
                    child: Text(controller.retryingEvents ? '重試中…' : '重試'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: IndexedStack(
              index: _selectedIndex,
              children: <Widget>[
                MapScreen(
                  key: const ValueKey<String>('home-map'),
                  staticFeatures: controller.staticFeatures,
                  staticFeaturesPending: controller.staticFeaturesPending,
                  staticFeaturesFailed:
                      controller.staticFeatureLoadError != null,
                  initialState: controller.initialState,
                  bridge: controller.bridge,
                  eventUpdates: controller.eventUpdates,
                  themeMode: controller.themeMode,
                  animationEnabled: controller.animationEnabled,
                  active: _selectedIndex == 0,
                  rescueService: controller.rescueService,
                  onViewportSettled: controller.setRescueViewport,
                  sirenPanelBuilder: (context, _) => SirenPanel(controller: widget.siren),
                  notificationFocusEvent: _notificationFocusEvent,
                  notificationFocusRequestId: _notificationFocusRequestId,
                ),
                NotificationsScreen(
                  events: controller.notificationEvents,
                  readEventKeys: controller.readEventKeys,
                  attestationSource: controller.events,
                  onEventRead: controller.markEventRead,
                  onEventMapRequested: _openNotificationOnMap,
                  onMarkAllRead: controller.markAllNotificationsRead,
                  onEventDeleted: controller.deleteNotification,
                  onDeleteAll: controller.deleteAllNotifications,
                  onUndoDelete: controller.restoreNotification,
                ),
                ProfileScreen(
                  governmentAuth: controller.governmentAuth,
                  bridge: controller.bridge,
                  themeMode: controller.themeMode,
                  animationEnabled: controller.animationEnabled,
                  onThemeModeChanged: controller.setThemeMode,
                  onAnimationChanged: controller.setAnimationEnabled,
                ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: AppBottomNavigation(
        currentIndex: _selectedIndex,
        notificationCount: controller.notificationCount,
        onSelected: (index) => setState(() => _selectedIndex = index),
      ),
    );
  }
}
