final class SyncStatus {
  const SyncStatus({
    required this.emergencyModeEnabled,
    required this.bluetoothAvailable,
    required this.bluetoothEnabled,
    required this.blePermissionsGranted,
    required this.notificationsEnabled,
    required this.serviceRunning,
    required this.discoveryActive,
    required this.nearbyPeers,
    required this.activeSessions,
    required this.syncCompletions,
    required this.chunksReceived,
    required this.observedAt,
    this.lastSuccessAt,
    this.lastFailureAt,
    this.lastFailureCode,
    this.transport = 'ble',
    this.wifiDirectAvailable = false,
    this.wifiEnabled = false,
    this.wifiPermissionsGranted = false,
    this.locationEnabled = false,
    this.activeTransports = const [],
    this.nearbyAvailable = false,
    this.nearbyReady = false,
    this.fallbackReason,
    this.lastFailureTransport,
    this.discoveryMode = 'balanced',
    this.discoveryResting = false,
  });

  final bool emergencyModeEnabled,
      bluetoothAvailable,
      bluetoothEnabled,
      blePermissionsGranted,
      notificationsEnabled,
      serviceRunning,
      discoveryActive;
  final int nearbyPeers, activeSessions, syncCompletions, chunksReceived;
  final DateTime observedAt;
  final DateTime? lastSuccessAt, lastFailureAt;
  final String? lastFailureCode;
  final String transport;
  final List<String> activeTransports;
  final bool nearbyAvailable, nearbyReady;
  final String? fallbackReason, lastFailureTransport;
  bool get automatic => transport == 'auto';
  bool get usesNearby => transport == 'nearby';
  static String transportLabel(String value) => switch (value) {
    'auto' => '自動選擇',
    'nearby' => 'Nearby',
    'wifi_direct' => 'Wi-Fi Direct',
    'ble' => '藍牙 BLE',
    _ => '未知方式',
  };
  String get activeTransportLabel =>
      !serviceRunning || activeTransports.isEmpty
          ? '尚未啟動'
          : activeTransports.map(transportLabel).join(' + ');
  String? get fallbackDescription {
    final reason = fallbackReason;
    if (reason == null) return null;
    if (reason == 'fast_transport_unavailable') return '高速傳輸尚未就緒，正在嘗試藍牙備援。';
    final label = reason.startsWith('nearby_') ? 'Nearby' : 'Wi-Fi Direct';
    if (reason.endsWith('_no_peer')) return '$label 暫未完成交換，已改試其他方式。';
    if (reason.endsWith('_unavailable')) return '$label 目前不可用，已改試其他方式。';
    return '$label 嘗試失敗，已改試其他方式。';
  }

  final String discoveryMode;
  final bool discoveryResting;
  final bool wifiDirectAvailable,
      wifiEnabled,
      wifiPermissionsGranted,
      locationEnabled;
  bool get usesWifiDirect => transport == 'wifi_direct';

  factory SyncStatus.fromMessage(Map<String, dynamic> message) {
    bool flag(String key) {
      final value = message[key];
      if (value is! bool) throw FormatException('Invalid sync status: $key');
      return value;
    }

    int count(String key) {
      final value = message[key];
      if (value is! int || value < 0) {
        throw FormatException('Invalid sync status: $key');
      }
      return value;
    }

    DateTime? timestamp(String key) {
      final value = message[key];
      if (value == null) return null;
      final parsed = value is String ? DateTime.tryParse(value) : null;
      if (parsed == null) throw FormatException('Invalid sync status: $key');
      return parsed;
    }

    final observed = timestamp('observed_at');
    if (observed == null) {
      throw const FormatException('Missing sync observation time');
    }
    final code = message['last_failure_code'];
    if (code != null && code is! String) {
      throw const FormatException('Invalid sync failure code');
    }
    return SyncStatus(
      transport: message['transport'] as String? ?? 'ble',
      activeTransports:
          (message['active_transports'] as List?)?.cast<String>() ?? const [],
      nearbyAvailable: message['nearby_available'] as bool? ?? false,
      nearbyReady: message['nearby_ready'] as bool? ?? false,
      fallbackReason: message['fallback_reason'] as String?,
      lastFailureTransport: message['last_failure_transport'] as String?,
      discoveryMode: message['discovery_mode'] as String? ?? 'balanced',
      discoveryResting: message['discovery_resting'] as bool? ?? false,
      wifiDirectAvailable: message['wifi_direct_available'] as bool? ?? false,
      wifiEnabled: message['wifi_enabled'] as bool? ?? false,
      wifiPermissionsGranted:
          message['wifi_permissions_granted'] as bool? ?? false,
      locationEnabled: message['location_enabled'] as bool? ?? false,
      emergencyModeEnabled: flag('emergency_mode_enabled'),
      bluetoothAvailable: flag('bluetooth_available'),
      bluetoothEnabled: flag('bluetooth_enabled'),
      blePermissionsGranted: flag('ble_permissions_granted'),
      notificationsEnabled: flag('notifications_enabled'),
      serviceRunning: flag('service_running'),
      discoveryActive: flag('discovery_active'),
      nearbyPeers: count('nearby_peers'),
      activeSessions: count('active_sessions'),
      syncCompletions: count('sync_completions'),
      chunksReceived: count('chunks_received'),
      observedAt: observed,
      lastSuccessAt: timestamp('last_success_at'),
      lastFailureAt: timestamp('last_failure_at'),
      lastFailureCode: code as String?,
    );
  }

  String get activityLabel {
    if (!emergencyModeEnabled) return '緊急模式未開啟';
    if (automatic) {
      if (serviceRunning && activeTransports.isEmpty) {
        return '等待可用傳輸方式，請確認藍牙、Wi-Fi 與附近裝置權限';
      }
    } else if (usesNearby) {
      if (!nearbyAvailable) {
        return 'Nearby 所需的 Google Play services 不可用，可改用自動模式';
      }
      if (!bluetoothEnabled || !wifiEnabled) return '請開啟藍牙與 Wi-Fi，不需要連上網際網路';
      if (!nearbyReady) return 'Nearby 尚未就緒，請確認附近裝置／區域網路權限與定位設定';
    } else if (usesWifiDirect) {
      if (!wifiDirectAvailable) return '裝置不支援 Wi-Fi Direct';
      if (!wifiPermissionsGranted) return '尚未取得 Wi-Fi 附近裝置權限';
      if (!wifiEnabled) return '請開啟 Wi-Fi';
      if (!locationEnabled) return '請開啟系統定位服務以搜尋 Wi-Fi Direct 裝置';
    } else {
      if (!bluetoothAvailable) return '裝置不支援藍牙';
      if (!blePermissionsGranted) return '尚未取得附近裝置權限';
      if (!bluetoothEnabled) return '請開啟藍牙';
    }
    if (!serviceRunning) return '尚未確認服務運作，請重新開啟緊急模式';
    if (!discoveryActive) {
      return lastFailureCode == 'discovery_failed'
          ? '搜尋失敗，請重新開啟緊急模式'
          : '服務已啟動，尚未開始搜尋';
    }
    if (activeSessions > 0) return '正在與附近節點同步';
    if (usesWifiDirect && discoveryResting) return '搜尋暫歇中，將自動恢復；也可立即搜尋';
    return nearbyPeers > 0 ? '正在搜尋，附近有可同步節點' : '正在搜尋附近節點';
  }

  String get failureDescription => switch (lastFailureCode) {
    'connection_failed' =>
      '${transportLabel(lastFailureTransport ?? transport)} 連線未成功或已逾時',
    'hello_timeout' => '對方未在時間內回應資料摘要',
    'send_failed' =>
      '${transportLabel(lastFailureTransport ?? transport)} 訊息傳送失敗',
    'transfer_incomplete' => '需要的資料未收齊，或資料驗證未通過',
    'session_failed' => '同步過程中發生錯誤',
    'discovery_failed' => '無法搜尋附近節點',
    'message_invalid' => '收到無法讀取的同步訊息',
    _ => '同步未完成',
  };
}
