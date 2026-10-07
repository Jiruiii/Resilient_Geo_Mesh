import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app/map_app_controller.dart';
import 'data/app_performance.dart';
import 'data/offline_map_web_protocol.dart';
import 'data/maplibre_web_runtime.dart';
import 'debug/route_validation_app.dart';
import 'screens/map_screen.dart';
import 'screens/notifications_screen.dart';
import 'screens/profile_screen.dart';
import 'theme/app_theme.dart';
import 'widgets/app_bottom_navigation.dart';
import 'widgets/startup_splash.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  AppPerformance.register();
  if (kIsWeb) {
    MapLibreWebRuntime.configure();
    await registerOfflineMapProtocol();
  }
  runApp(const ResilientGeoApp());
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

  @override
  void initState() {
    super.initState();
    _controller = MapAppController()..load();
  }

  @override
  void dispose() {
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
          home: _MapAppHome(controller: _controller),
        ),
  );
}

class _MapAppHome extends StatefulWidget {
  const _MapAppHome({required this.controller});

  final MapAppController controller;

  @override
  State<_MapAppHome> createState() => _MapAppHomeState();
}

class _MapAppHomeState extends State<_MapAppHome> {
  int _selectedIndex = 0;

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
                ),
                NotificationsScreen(
                  events: controller.unreadEvents,
                  attestationSource: controller.events,
                  onEventRead: controller.markEventRead,
                ),
                ProfileScreen(
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
