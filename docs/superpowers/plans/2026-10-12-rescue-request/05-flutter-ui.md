# 05 Flutter UI（Android 與 Web 共用）

> 總覽與 Global Constraints：[README.md](README.md)。所有 UI 都在 Flutter 共用層，Android 與 Web 跑同一份 widget；平台差異只經由 04 的 `RescueService` 與 06 的 `SirenController` 進來。marker 是 Flutter widget（見 `maplibre_overlay.dart` 註解），因此兩端外觀、點擊與 semantics 天然一致。

| 檔案 | 責任 |
|---|---|
| `flutter/lib/data/map_models.dart`（改） | 已結束的求救不畫在地圖上 |
| `flutter/lib/data/route_event_snapshot.dart`（改） | 求救不觸發路線重算 |
| `flutter/lib/widgets/map_layers.dart`（改） | 求救 marker、cluster 求救計數、`eventName` |
| `flutter/lib/widgets/rescue_marker.dart`（新） | 求救 marker widget 與 semantic label |
| `flutter/lib/widgets/feature_details_sheet.dart`（改） | 求救詳情 |
| `flutter/lib/screens/notifications_screen.dart`（改） | 求救通知卡 |
| `flutter/lib/widgets/crowd_report_sheet.dart`（改） | 「受困／受傷」導引；通用地圖選點列 |
| `flutter/lib/widgets/rescue_request_sheet.dart`（新） | 表單與確認頁 |
| `flutter/lib/app/rescue_flow_controller.dart`（新） | 求救流程狀態（建立、修訂、恢復、提醒） |
| `flutter/lib/widgets/rescue_status_card.dart`（新） | 首頁進行中求救卡片 |
| `flutter/lib/screens/map_screen.dart`、`flutter/lib/widgets/map_canvas.dart`、`flutter/lib/app/map_app_controller.dart`、`flutter/lib/main.dart`（改） | 整合 |

---

### Task 17: 既有邏輯調整

**Files:**
- Modify: `flutter/lib/data/map_models.dart:233-241`
- Modify: `flutter/lib/data/route_event_snapshot.dart:48-49`
- Modify: `flutter/lib/widgets/map_layers.dart:1064-1068`（`eventName`）
- Modify: `flutter/lib/screens/notifications_screen.dart`
- Modify: `flutter/lib/widgets/crowd_report_sheet.dart:84-95`
- Test: `flutter/test/rescue_existing_logic_test.dart`
- Create: `flutter/test/support/rescue_events.dart`（`rescue({status, expiresAt})` 測試事件，Task 18、19、22 共用）

**Interfaces:**
- Consumes: 04 Task 16 的 `RescueRequestView`、`rescueNamespace`
- Produces:
  - `MeshEvent.isEndedRescueRequest`（getter）；`isShownAt` 對已結束的求救回 `false`
  - `RouteEventSnapshot._kind` 對 `crowd.rescue` 回 `null`
  - `eventName(event)` 對 `RESCUE_REQUEST` 回 `求救點：<類型>`
  - `crowd_report_sheet.dart` 的「受困／受傷」選項副標題：`若是你或現場有人需要救援，請改用「需要救援」`

- [ ] **Step 1: 寫失敗的測試**

`flutter/test/support/rescue_events.dart`：

```dart
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
```

`flutter/test/rescue_existing_logic_test.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/corroboration.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/route_event_snapshot.dart';
import 'package:resilientgeo_flutter/widgets/crowd_report_sheet.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';

import 'support/rescue_events.dart';

void main() {
  final now = DateTime.parse('2026-10-12T04:00:00Z');

  test('ended or expired rescue requests are never drawn as active', () {
    expect(rescue().isShownAt(now), isTrue);
    expect(rescue(status: 'RESOLVED').isShownAt(now), isFalse);
    expect(rescue(status: 'CANCELLED').isShownAt(now), isFalse);
    expect(rescue(expiresAt: '2026-10-12T03:30:00Z').isShownAt(now), isFalse);
  });

  test('rescue points do not trigger evacuation re-routing', () {
    final before = RouteEventSnapshot(const <MeshEvent>[], now);
    final after = RouteEventSnapshot(<MeshEvent>[rescue()], now);
    expect(before.changeReason(after), isNull);
  });

  test('rescue requests are named as rescue points and never corroborated', () {
    expect(eventName(rescue()), '求救點：受困於瓦礫或倒塌建物下');
    expect(corroborationCount(rescue(), <MeshEvent>[rescue(), rescue()], now: now), 0);
  });

  testWidgets('the trapped/injured report option points people to 需要救援', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CrowdReportSheet(
          draft: const CrowdReportDraft(
            category: CrowdReportCategory.trappedInjured,
            location: null,
            locationSource: null,
            description: '',
          ),
          step: CrowdReportSheetStep.edit,
          submitting: false,
          onDraftChanged: (_) {},
          onRequestCurrentLocation: () {},
          onRequestMapPick: () {},
          onShowConfirmation: () {},
          onBackToEdit: () {},
          onSubmit: () {},
          onCancel: () {},
        ),
      ),
    ));
    expect(find.text('若是你或現場有人需要救援，請改用「需要救援」'), findsOneWidget);
  });
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_existing_logic_test.dart`
Expected: FAIL

- [ ] **Step 3: 實作**

`map_models.dart`，在 `isShownAt` 之前加入 getter，並在 `isShownAt` 第一行判斷：

```dart
  /// A rescue request whose latest version is RESOLVED or CANCELLED. It stays
  /// in storage until expiry so relays learn it ended, but is never drawn.
  bool get isEndedRescueRequest =>
      namespace == 'crowd.rescue' && attributes?['status'] != 'ACTIVE';

  bool isShownAt([DateTime? now]) {
    if (isEndedRescueRequest) return false;
    if (applyState != 'UNVERIFIED') return isCurrentAt(now);
    // ...不變
  }
```

（這裡用字串常數而不 import `rescue_request_models.dart`，避免 `map_models` 與它互相依賴。）

`route_event_snapshot.dart` 的 `_kind` 第一行加入：

```dart
    // Rescue points are people needing help, not hazards (HazardOverlay ignores them).
    if (event.namespace == 'crowd.rescue') return null;
```

`map_layers.dart`：import `../data/rescue_request_models.dart`；`eventName` 開頭加入：

```dart
  final rescue = RescueRequestView.fromEvent(event);
  if (rescue != null) return '求救點：${rescue.type.label}';
```

`notifications_screen.dart` 的 `_EventCard`：

```dart
    final rescue = RescueRequestView.fromEvent(event);
    // ...
            child: Icon(
              event.isExpired
                  ? MapIconCatalog.expiredEvent
                  : rescue != null
                      ? MapIconCatalog.rescueRequest(rescue.type)
                      : MapIconCatalog.disaster,
              // ...
            ),
    // subtitle 的 lines：
              if (rescue != null) ...<String>[
                '求救狀態：${rescue.status.label}',
                '急迫程度：${rescue.urgency.label}',
                '人數：${rescue.peopleCount} 人',
              ] else ...<String>[
                '事件類型：${event.eventType ?? '無資料'}',
                '來源：${event.source ?? '無資料'}',
                '嚴重度：${event.severity ?? '無資料'}',
              ],
```

其餘 lines（驗證狀態、發布、有效期限）不變。`MapIconCatalog.rescueRequest` 在 Task 18 定義；本任務先在 `MapIconCatalog` 加入：

```dart
  static IconData rescueRequest(RescueRequestType type) => switch (type) {
    RescueRequestType.firstAidNeeded => LucideIcons.heartPulse,
    RescueRequestType.immobile => LucideIcons.accessibility,
    RescueRequestType.trapped => LucideIcons.doorClosed,
    RescueRequestType.trappedDebris => LucideIcons.brickWall,
    RescueRequestType.otherRescue => LucideIcons.lifeBuoy,
  };
  static const IconData rescueEntry = LucideIcons.lifeBuoy;
  static const IconData locatorSound = LucideIcons.volume2;
```

`crowd_report_sheet.dart` 的 `RadioListTile`：

```dart
          (category) => RadioListTile<CrowdReportCategory>(
            contentPadding: EdgeInsets.zero,
            title: Text(category.label),
            subtitle: category == CrowdReportCategory.trappedInjured
                ? const Text('若是你或現場有人需要救援，請改用「需要救援」')
                : null,
            // ...不變
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_existing_logic_test.dart test/map_models_test.dart test/route_event_snapshot_test.dart test/crowd_report_sheet_test.dart test/corroboration_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add flutter/lib/data/map_models.dart flutter/lib/data/route_event_snapshot.dart flutter/lib/widgets/map_layers.dart flutter/lib/screens/notifications_screen.dart flutter/lib/widgets/crowd_report_sheet.dart flutter/test/rescue_existing_logic_test.dart flutter/test/support/rescue_events.dart
git commit -m "feat(flutter): treat rescue requests separately from crowd reports"
```

---

### Task 18: 求救 marker 與 cluster

**Files:**
- Create: `flutter/lib/widgets/rescue_marker.dart`
- Modify: `flutter/lib/widgets/map_layers.dart`（`MapMarkerData`、`MapMarkerCluster`、`_eventMarker`、`_administrativeSummaryMarkers`、`_AdministrativeSummaryGroup`、`_clusterMarker`、`_clusterLabel`、`_MapClusterBubble`）
- Test: `flutter/test/rescue_marker_test.dart`

**Interfaces:**
- Consumes: Task 16、Task 17
- Produces:
  - `String rescueSemanticLabel(RescueRequestView view, CrowdVerification verification)`：`求救點：<類型>，急迫程度<危急|高|中>，<未經查證|官方已確認>，<狀態>，<N> 人`
  - `class RescueMarker extends StatelessWidget { RescueMarker({required RescueRequestView view, required CrowdVerification verification, required bool compact, required VoidCallback onTap}) }`
  - `rescueUrgencyColor(RescueUrgency): Color`
  - `MapMarkerData` 新欄位 `rescueCount`（int，預設 0）、`urgentRescueCount`（int，預設 0；HIGH 或 CRITICAL 求救的數量）、`hasUrgentRescue`（bool，預設 false）；`MapMarkerCluster` 對應 getter（`rescueCount`、`urgentRescueCount` 加總，`hasUrgentRescue` 取 any）
  - `String clusterSemanticLabel(MapMarkerCluster cluster, {String? areaName})`（原 `_clusterLabel` 改為公開）
  - 求救 marker 尺寸：完整 34、精簡 20

視覺規則：

| 維度 | 呈現 |
|---|---|
| 類型 | 圓形底座中的 `MapIconCatalog.rescueRequest(type)` 圖示 |
| 急迫度 | 底色（危急 `#D92D20`、高 `#F97316`、中 `#D97706`）＋右上角白底文字角標「危／高／中」 |
| 驗證 | 未驗證：紫色 `#7C3AED` 虛線外環＋左下「?」角標；官方確認：青色 `#0F766E` 實線外環＋左下「✓」角標 |
| 人數 | 精簡模式不顯示；完整模式在 semantic label 中 |

- [ ] **Step 1: 寫失敗的測試**

`flutter/test/rescue_marker_test.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/widgets/map_layers.dart';
import 'package:resilientgeo_flutter/widgets/rescue_marker.dart';

import 'support/rescue_events.dart';

void main() {
  final view = RescueRequestView.fromEvent(rescue())!;

  test('semantic label states type, urgency, verification, status and people without colour', () {
    expect(
      rescueSemanticLabel(view, CrowdVerification.unverified),
      '求救點：受困於瓦礫或倒塌建物下，急迫程度危急，未經查證，進行中，2 人',
    );
    expect(rescueSemanticLabel(view, CrowdVerification.confirmed), contains('官方已確認'));
  });

  testWidgets('the marker carries an urgency badge and an unverified badge as text', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: SizedBox(
          width: 34,
          height: 34,
          child: RescueMarker(view: view, verification: CrowdVerification.unverified, compact: false, onTap: () => taps++),
        ),
      ),
    ));
    expect(find.text('危'), findsOneWidget);
    expect(find.text('?'), findsOneWidget);
    expect(find.bySemanticsLabel('求救點：受困於瓦礫或倒塌建物下，急迫程度危急，未經查證，進行中，2 人'), findsOneWidget);
    await tester.tap(find.byType(RescueMarker));
    expect(taps, 1);
  });

  test('event markers for rescue requests use the rescue widget and count as urgent rescue', () {
    final markers = MapLayers.buildMarkers(
      features: const <StaticFeature>[],
      events: <MeshEvent>[rescue()],
      showShelters: false,
      showMedical: false,
      showEvents: true,
      onStaticFeatureSelected: (_) {},
      onEventSelected: (_) {},
      now: DateTime.parse('2026-10-12T04:00:00Z'),
    );
    final marker = markers.single;
    expect(marker.child, isA<RescueMarker>());
    expect(marker.rescueCount, 1);
    expect(marker.hasUrgentRescue, isTrue);
    final cluster = MapMarkerCluster(members: <MapMarkerData>[marker, marker], point: marker.point);
    expect(cluster.rescueCount, 2);
    expect(cluster.hasUrgentRescue, isTrue);
    expect(clusterSemanticLabel(cluster), contains('求救點2，其中2個高或危急'));
  });

  test('ended rescue requests produce no marker', () {
    final markers = MapLayers.buildMarkers(
      features: const <StaticFeature>[],
      events: <MeshEvent>[rescue(status: 'RESOLVED')],
      showShelters: false,
      showMedical: false,
      showEvents: true,
      onStaticFeatureSelected: (_) {},
      onEventSelected: (_) {},
      now: DateTime.parse('2026-10-12T04:00:00Z'),
    );
    expect(markers, isEmpty);
  });
}
```


- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_marker_test.dart`
Expected: 編譯失敗

- [ ] **Step 3: 實作 `rescue_marker.dart`**

```dart
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../data/map_models.dart';
import '../data/rescue_request_models.dart';
import 'map_layers.dart';

Color rescueUrgencyColor(RescueUrgency urgency) => switch (urgency) {
  RescueUrgency.critical => const Color(0xFFD92D20),
  RescueUrgency.high => const Color(0xFFF97316),
  RescueUrgency.medium => const Color(0xFFD97706),
};

String rescueSemanticLabel(RescueRequestView view, CrowdVerification verification) {
  final verified = verification == CrowdVerification.confirmed ? '官方已確認' : '未經查證';
  return '求救點：${view.type.label}，急迫程度${view.urgency.label}，$verified，${view.status.label}，${view.peopleCount} 人';
}

/// Shape = request type (icon), fill + text badge = urgency, ring + text
/// badge = verification. Nothing is conveyed by colour alone.
class RescueMarker extends StatelessWidget {
  const RescueMarker({
    super.key,
    required this.view,
    required this.verification,
    required this.compact,
    required this.onTap,
  });

  final RescueRequestView view;
  final CrowdVerification verification;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final confirmed = verification == CrowdVerification.confirmed;
    final ringColor = confirmed ? confirmedCrowdEventColor : unverifiedEventColor;
    return Semantics(
      button: true,
      container: true,
      label: rescueSemanticLabel(view, verification),
      child: ExcludeSemantics(
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: CustomPaint(
            foregroundPainter: _RingPainter(color: ringColor, dashed: !confirmed),
            child: Padding(
              padding: const EdgeInsets.all(3),
              child: Stack(
                clipBehavior: Clip.none,
                children: <Widget>[
                  Positioned.fill(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: rescueUrgencyColor(view.urgency),
                        shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 1.5),
                        boxShadow: const <BoxShadow>[BoxShadow(color: Colors.black38, blurRadius: 3)],
                      ),
                      child: compact
                          ? null
                          : Icon(MapIconCatalog.rescueRequest(view.type), color: Colors.white, size: 15),
                    ),
                  ),
                  if (!compact) ...<Widget>[
                    Positioned(right: -6, top: -6, child: _Badge(text: view.urgency.badge, color: rescueUrgencyColor(view.urgency))),
                    Positioned(left: -6, bottom: -6, child: _Badge(text: confirmed ? '✓' : '?', color: ringColor)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: Colors.white,
      shape: BoxShape.circle,
      border: Border.all(color: color, width: 1.5),
    ),
    child: SizedBox(
      width: 15,
      height: 15,
      child: Center(
        child: Text(
          text,
          style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w800, height: 1),
        ),
      ),
    ),
  );
}

class _RingPainter extends CustomPainter {
  const _RingPainter({required this.color, required this.dashed});

  final Color color;
  final bool dashed;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5;
    final rect = Offset.zero & size;
    final radius = math.min(size.width, size.height) / 2 - 1.25;
    final center = rect.center;
    if (!dashed) {
      canvas.drawCircle(center, radius, paint);
      return;
    }
    const segments = 12;
    const sweep = 2 * math.pi / segments;
    for (var index = 0; index < segments; index += 1) {
      canvas.drawArc(Rect.fromCircle(center: center, radius: radius), index * sweep, sweep * 0.6, false, paint);
    }
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) => oldDelegate.color != color || oldDelegate.dashed != dashed;
}
```

- [ ] **Step 4: 修改 `map_layers.dart`**

1. `MapMarkerData` 加欄位與建構參數：

```dart
    this.rescueCount = 0,
    this.urgentRescueCount = 0,
    this.hasUrgentRescue = false,
  // ...
  final int rescueCount;
  final int urgentRescueCount;
  final bool hasUrgentRescue;
```

2. `MapMarkerCluster` 加：

```dart
  int get rescueCount => members.fold(0, (total, marker) => total + marker.rescueCount);

  int get urgentRescueCount => members.fold(0, (total, marker) => total + marker.urgentRescueCount);

  bool get hasUrgentRescue => members.any((marker) => marker.hasUrgentRescue);
```

3. 常數：`static const double _rescueMarkerSize = 34; static const double _compactRescueMarkerSize = 20;`

4. `_eventMarker` 開頭加入：

```dart
    final rescue = RescueRequestView.fromEvent(event);
    if (rescue != null) {
      final point = meshEventFocusPoint(event)!;
      final size = compact ? _compactRescueMarkerSize : _rescueMarkerSize;
      return MapMarkerData(
        key: ValueKey<String>('event-marker-${meshEventIdentity(event)}'),
        point: point,
        width: size,
        height: size,
        child: RescueMarker(
          view: rescue,
          verification: event.verification ?? CrowdVerification.unverified,
          compact: compact,
          onTap: () => onSelected(event),
        ),
        onTap: () => onSelected(event),
        kind: MapMarkerKind.event,
        eventCount: 1,
        hasCriticalEvent: rescue.urgency != RescueUrgency.medium,
        rescueCount: 1,
        urgentRescueCount: rescue.urgency != RescueUrgency.medium ? 1 : 0,
        hasUrgentRescue: rescue.urgency != RescueUrgency.medium,
      );
    }
```

5. `_AdministrativeSummaryGroup` 加 `int rescueCount = 0; int urgentRescueCount = 0; bool hasUrgentRescue = false;`，`add()` 加同名必填參數並累加（`hasUrgentRescue` 用 `|=`）；`_administrativeSummaryMarkers` 內 `addPoint` 增加這三個參數（facility 點傳 0／0／false；事件點用 `RescueRequestView.fromEvent(event)` 判斷）；summary 的 `MapMarkerData` 建構時帶上 group 的三個值。

6. `_clusterMarker` 的 `_MapClusterBubble(...)` 帶 `rescueCount`、`hasUrgentRescue`；回傳的 `MapMarkerData(...)` 帶 `rescueCount`、`urgentRescueCount`、`hasUrgentRescue`。

7. `_clusterLabel` 改名為公開的 `clusterSemanticLabel`（同檔內呼叫處一併改），並加入：

```dart
  if (cluster.rescueCount > 0) {
    details.add('求救點${cluster.rescueCount}，其中${cluster.urgentRescueCount}個高或危急');
  }
```

`urgentRescueCount` 用計數而不是從 `hasUrgentRescue` 推算，因為行政區彙總的 cluster 只有一個聚合 member，布林值無法還原數量。測試中兩個相同 marker 的 cluster 預期「其中2個高或危急」。

8. `_MapClusterBubble` 加 `rescueCount`、`hasUrgentRescue` 參數。`showCount` 時在數字下方加一行：

```dart
                      if (rescueCount > 0)
                        Text(
                          'SOS $rescueCount',
                          style: const TextStyle(color: Colors.white, fontSize: 8, fontWeight: FontWeight.w800, height: 1.1),
                        ),
```

`!showCount` 且 `rescueCount > 0` 時，中心白點改為白色 `!` 字：

```dart
                  : Center(
                    child: rescueCount > 0
                        ? const Text('!', style: TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w900, height: 1))
                        : SizedBox(/* 既有白點 */),
                  ),
```

bubble 底色在 `hasCriticalEvent || hasUrgentRescue` 時用既有的紅色 `0xFFB42318`。

import：`rescue_marker.dart`、`../data/rescue_request_models.dart`（Task 17 已加）。

- [ ] **Step 5: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_marker_test.dart test/map_interaction_test.dart test/map_marker_projection_test.dart`
Expected: PASS（若 `map_marker_projection_test.dart` 不存在就略過該檔；以 `flutter test` 跑整個 `test/` 目錄中與 marker／cluster 相關的既有測試）

- [ ] **Step 6: Commit**

```bash
git add flutter/lib/widgets/rescue_marker.dart flutter/lib/widgets/map_layers.dart flutter/test/rescue_marker_test.dart
git commit -m "feat(flutter): rescue markers encode type, urgency and verification"
```

---

### Task 19: 求救詳情

**Files:**
- Modify: `flutter/lib/widgets/feature_details_sheet.dart:144-158`
- Test: `flutter/test/rescue_details_test.dart`

**Interfaces:**
- Consumes: Task 16、Task 18
- Produces: 求救詳情行：驗證提示、`求救類型`、`急迫程度`（含推導原因）、`求救狀態`、`人數`、`描述`、`位置來源`、`最後更新`、`到期時間`，固定文字 `未經查證，不代表已派遣救援`；被官方確認的是較早版本時另顯示 `官方確認的是先前版本，最新內容未經查證`

- [ ] **Step 1: 寫失敗的測試**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/widgets/feature_details_sheet.dart';

import 'support/rescue_events.dart';

void main() {
  testWidgets('rescue details describe the request without implying dispatch', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: FeatureDetailsSheet.event(event: rescue(), onClose: () {})),
    ));
    expect(find.text('求救點：受困於瓦礫或倒塌建物下'), findsOneWidget);
    expect(find.text('未經查證，僅供參考'), findsOneWidget);
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    expect(find.text('求救狀態：進行中'), findsOneWidget);
    expect(find.text('人數：2 人'), findsOneWidget);
    expect(find.text('未經查證，不代表已派遣救援'), findsOneWidget);
    expect(find.textContaining('回報類別'), findsNothing);
  });
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_details_test.dart`
Expected: FAIL

- [ ] **Step 3: 實作**

`_eventBody` 改為：

```dart
  List<Widget> _eventBody(MeshEvent event) {
    final rescue = RescueRequestView.fromEvent(event);
    if (rescue != null) return _rescueBody(event, rescue);
    return <Widget>[
      // ...原本內容不變
    ];
  }

  List<Widget> _rescueBody(MeshEvent event, RescueRequestView rescue) => <Widget>[
    _VerificationNotice(event.verification ?? CrowdVerification.unverified),
    _DetailLine('求救類型', rescue.type.label),
    _DetailLine('急迫程度', '${rescue.urgency.label}（${rescueUrgencyReason(rescue.type, rescue.triage, rescue.subject)}）'),
    _DetailLine('求救狀態', rescue.status.label),
    _DetailLine('求救對象', rescue.subject.label),
    _DetailLine('人數', '${rescue.peopleCount} 人'),
    _DetailLine('描述', _text(rescue.description)),
    _DetailLine('位置來源', event.attributes?['location_source'] == 'MAP_PICK' ? '地圖選點' : '目前位置'),
    _DetailLine('最後更新', formatUpdateTime(event.issuedAt)),
    _DetailLine('到期時間', formatUpdateTime(event.expiresAt)),
    const Padding(
      padding: EdgeInsets.only(top: 8),
      child: Text('未經查證，不代表已派遣救援', key: ValueKey<String>('rescue-not-dispatched')),
    ),
  ];
```

「官方確認的是先前版本」：`AttestationIndex.attestationFor` 已以 `payload_hash` 綁定版本；更新後的事件 `verification` 會回到 `unverified`，因此這句提示需要知道「同 event_id 有被確認的舊版」。`AttestationIndex` 的 `_byTarget` 以 (namespace, event_id) 為 key，加入：

```dart
  /// True when an attestation targets this request id but a different
  /// version, e.g. the reporter updated it after the government confirmed it.
  bool confirmedOtherVersion(MeshEvent report) {
    final attestation = _byTarget[_key(report.namespace ?? '', report.eventId ?? '')];
    return attestation != null &&
        _verdict(attestation) == CrowdVerification.confirmed &&
        attestation.attributes?['target_payload_hash'] != report.payloadHash;
  }
```

`FeatureDetailsSheet.event` 增加選填參數 `bool confirmedEarlierVersion = false`，為 true 時在 `_VerificationNotice` 下方顯示 `官方確認的是先前版本，最新內容未經查證`。`map_screen.dart` 呼叫處（Task 22）傳入 `AttestationIndex.fromEvents(_persistedEvents).confirmedOtherVersion(event)`。

`formatUpdateTime` 已在 `display_time.dart`（本檔已 import）。

- [ ] **Step 4: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_details_test.dart test/attestation_index_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add flutter/lib/widgets/feature_details_sheet.dart flutter/lib/data/attestation_index.dart flutter/test/rescue_details_test.dart
git commit -m "feat(flutter): rescue request details"
```

---

### Task 20: 求救表單與確認頁

**Files:**
- Create: `flutter/lib/widgets/rescue_request_sheet.dart`
- Modify: `flutter/lib/widgets/crowd_report_sheet.dart:300-365`（抽出通用 `MapLocationPickerBar`）
- Test: `flutter/test/rescue_request_sheet_test.dart`

**Interfaces:**
- Consumes: Task 16 的 `RescueDraft`、列舉與 label
- Produces:
  - `enum RescueSheetStep { edit, confirm }`
  - `class RescueRequestSheet extends StatelessWidget`，參數：`draft`、`step`、`submitting`、`isUpdate`、`capabilities`（`RescueCapabilities?`，`canSign == false` 時顯示限制並停用送出）、`errorMessage`、`onDraftChanged`、`onRequestCurrentLocation`、`onRequestMapPick`、`addressController`、`addressResults`、`onAddressChanged`、`onAddressSelected`、`onShowConfirmation`、`onBackToEdit`、`onSubmit`、`onCancel`、`onOpenSirenOnly`
  - Keys：`rescue-type-<WIRE>`、`rescue-subject-<WIRE>`、`rescue-triage-<field>-<ANSWER>`、`rescue-people-minus`、`rescue-people-plus`、`rescue-description`、`rescue-confirm`、`rescue-submit`、`rescue-siren-only`、`rescue-urgency-preview`
  - `class MapLocationPickerBar`：`title`、`instruction`、`point`、`backKey`、`confirmKey`、`onBack`、`onConfirm`；`CrowdReportMapPickerBar` 改為包它（keys 維持 `report-location-back`／`report-location-confirm`）

表單內容順序：

1. 標題「需要救援」（更新時「更新求救」）與關閉鍵。
2. 固定提示：「此功能不能取代 119，請在可撥打時優先撥打 119」。
3. 「只發出定位警報聲」按鍵（`rescue-siren-only`），說明「不送出求救，也不需要網路」。
4. 求救類型（5 個 RadioListTile）。
5. 求救對象：我自己／現場其他人。
6. 結構化問題：是否無法移動、是否呼吸困難、是否大量出血、是否清醒（`SELF` 時不顯示這題）；每題三個 ChoiceChip：是／否／不確定。
7. 人數：減號、數字、加號（1–50）。
8. 急迫程度預覽（`rescue-urgency-preview`）：`急迫程度：危急（受困於瓦礫或倒塌建物下）`，TRAPPED_DEBRIS 時旁邊加「固定為危急」。
9. 位置：使用目前位置、地圖選點、地址搜尋（同 crowd report）。
10. 描述（最多 160 字），helper：「請勿輸入姓名、電話、身分證號等非必要個資；描述會公開給收到求救的人」。
11. 取消／確認內容。

確認頁：位置來源與座標、搜尋參考（若有）、類型、對象、急迫程度與原因、人數、描述、紫色提示「送出後為未經查證的求救，不代表已派遣救援」、隱私提示「求救帶有精確位置，收到的裝置與伺服器都看得到；同一裝置的求救可被串連」、返回修改／確認送出。`capabilities.supportsMesh == false`（Web）且不是更新時，另顯示 `rescueBrowserKeyText`：「這個瀏覽器會保存簽署求救的金鑰；清除網站資料或使用無痕視窗後，將無法更新或取消這筆求救，只能等它到期」。`capabilities.canSign == false` 時送出鍵停用並顯示 `RescueFailure(code: unsupported).userMessage()` 的文字。`errorMessage` 非空時以錯誤色顯示在送出鍵上方。

- [ ] **Step 1: 寫失敗的測試**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/widgets/rescue_request_sheet.dart';

Widget _sheet({
  required RescueDraft draft,
  RescueSheetStep step = RescueSheetStep.edit,
  ValueChanged<RescueDraft>? onChanged,
  RescueCapabilities? capabilities,
  VoidCallback? onSirenOnly,
}) => MaterialApp(
  home: Scaffold(
    body: RescueRequestSheet(
      draft: draft,
      step: step,
      submitting: false,
      isUpdate: false,
      capabilities: capabilities,
      errorMessage: null,
      onDraftChanged: onChanged ?? (_) {},
      onRequestCurrentLocation: () {},
      onRequestMapPick: () {},
      onShowConfirmation: () {},
      onBackToEdit: () {},
      onSubmit: () {},
      onCancel: () {},
      onOpenSirenOnly: onSirenOnly ?? () {},
    ),
  ),
);

void main() {
  testWidgets('TRAPPED_DEBRIS previews a fixed CRITICAL urgency', (tester) async {
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial()));
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    expect(find.text('固定為危急'), findsOneWidget);
    expect(find.text('此功能不能取代 119，請在可撥打時優先撥打 119'), findsOneWidget);
  });

  testWidgets('answers drive the urgency preview; there is no urgency picker', (tester) async {
    var draft = RescueDraft.initial().copyWith(type: RescueRequestType.firstAidNeeded, subject: RescueSubject.others);
    await tester.pumpWidget(_sheet(draft: draft, onChanged: (next) => draft = next));
    expect(find.text('急迫程度：中（需要協助）'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-triage-severe_bleeding-YES')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-triage-severe_bleeding-YES')));
    expect(draft.urgency, RescueUrgency.critical);
    expect(find.textContaining('LOW'), findsNothing);
  });

  testWidgets('the consciousness question is hidden for SELF', (tester) async {
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial()));
    expect(find.byKey(const ValueKey<String>('rescue-triage-conscious-NO')), findsNothing);
    await tester.pumpWidget(_sheet(draft: RescueDraft.initial().copyWith(subject: RescueSubject.others)));
    expect(find.byKey(const ValueKey<String>('rescue-triage-conscious-NO')), findsOneWidget);
  });

  testWidgets('confirmation shows every field and the unverified warning', (tester) async {
    final draft = RescueDraft.initial().copyWith(
      peopleCount: 3,
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
      description: '一樓樓梯間',
    );
    await tester.pumpWidget(_sheet(draft: draft, step: RescueSheetStep.confirm));
    for (final text in <String>[
      '類型：受困於瓦礫或倒塌建物下',
      '對象：我自己',
      '急迫程度：危急（受困於瓦礫或倒塌建物下）',
      '人數：3 人',
      '描述：一樓樓梯間',
      '位置來源：目前位置',
      '座標：25.000000, 121.500000',
      '送出後為未經查證的求救，不代表已派遣救援',
    ]) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
  });

  testWidgets('a browser that cannot sign cannot submit, but can still sound the alarm', (tester) async {
    var sirenTaps = 0;
    final draft = RescueDraft.initial().copyWith(
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
    );
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: false, canVerify: false, hasStorage: true, supportsMesh: false),
      onSirenOnly: () => sirenTaps++,
    ));
    final submit = tester.widget<ElevatedButton>(find.byKey(const ValueKey<String>('rescue-submit')));
    expect(submit.onPressed, isNull);
    expect(find.text('此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲'), findsOneWidget);
    await tester.pumpWidget(_sheet(draft: draft, onSirenOnly: () => sirenTaps++));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-siren-only')));
    expect(sirenTaps, 1);
  });

  testWidgets('the web confirmation warns that the browser key can be lost', (tester) async {
    final draft = RescueDraft.initial().copyWith(
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
    );
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: false),
    ));
    expect(find.text(rescueBrowserKeyText), findsOneWidget);
    await tester.pumpWidget(_sheet(
      draft: draft,
      step: RescueSheetStep.confirm,
      capabilities: const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: true),
    ));
    expect(find.text(rescueBrowserKeyText), findsNothing);
  });
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_request_sheet_test.dart`
Expected: 編譯失敗

- [ ] **Step 3: 實作 `rescue_request_sheet.dart`**

```dart
import 'package:flutter/material.dart';

import '../data/crowd_report_models.dart';
import '../data/map_search.dart';
import '../data/rescue_request_models.dart';
import '../data/rescue_service.dart';
import 'map_layers.dart';

enum RescueSheetStep { edit, confirm }

const rescueNot119Text = '此功能不能取代 119，請在可撥打時優先撥打 119';
const rescueUnverifiedText = '送出後為未經查證的求救，不代表已派遣救援';
const rescuePrivacyText = '求救帶有精確位置，收到的裝置與伺服器都看得到；同一裝置的求救可被串連';
const rescueDescriptionHelper = '請勿輸入姓名、電話、身分證號等非必要個資；描述會公開給收到求救的人';
const rescueBrowserKeyText = '這個瀏覽器會保存簽署求救的金鑰；清除網站資料或使用無痕視窗後，將無法更新或取消這筆求救，只能等它到期';

class RescueRequestSheet extends StatelessWidget {
  const RescueRequestSheet({
    super.key,
    required this.draft,
    required this.step,
    required this.submitting,
    required this.isUpdate,
    required this.capabilities,
    required this.errorMessage,
    required this.onDraftChanged,
    required this.onRequestCurrentLocation,
    required this.onRequestMapPick,
    this.addressController,
    this.addressResults = const <MapSearchResult>[],
    this.onAddressChanged,
    this.onAddressSelected,
    required this.onShowConfirmation,
    required this.onBackToEdit,
    required this.onSubmit,
    required this.onCancel,
    required this.onOpenSirenOnly,
  });

  final RescueDraft draft;
  final RescueSheetStep step;
  final bool submitting;
  final bool isUpdate;
  final RescueCapabilities? capabilities;
  final String? errorMessage;
  final ValueChanged<RescueDraft> onDraftChanged;
  final VoidCallback onRequestCurrentLocation;
  final VoidCallback onRequestMapPick;
  final TextEditingController? addressController;
  final List<MapSearchResult> addressResults;
  final ValueChanged<String>? onAddressChanged;
  final ValueChanged<MapSearchResult>? onAddressSelected;
  final VoidCallback onShowConfirmation;
  final VoidCallback onBackToEdit;
  final VoidCallback onSubmit;
  final VoidCallback onCancel;
  final VoidCallback onOpenSirenOnly;

  bool get _canSign => capabilities?.canSign ?? true;

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    elevation: 12,
    borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
    child: SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: step == RescueSheetStep.edit ? _editBody(context) : _confirmBody(context),
        ),
      ),
    ),
  );

  Widget _header(BuildContext context, String title) => Row(
    children: <Widget>[
      Expanded(child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
      IconButton(tooltip: '關閉需要救援', onPressed: submitting ? null : onCancel, icon: const Icon(Icons.close)),
    ],
  );

  Widget _section(BuildContext context, String title) => Padding(
    padding: const EdgeInsets.only(top: 12, bottom: 4),
    child: Text(title, style: Theme.of(context).textTheme.titleMedium),
  );

  Widget _editBody(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(context, isUpdate ? '更新求救' : '需要救援'),
        Text(rescueNot119Text, style: TextStyle(color: theme.colorScheme.error, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          key: const ValueKey<String>('rescue-siren-only'),
          onPressed: onOpenSirenOnly,
          icon: const Icon(MapIconCatalog.locatorSound),
          label: const Text('只發出定位警報聲（不送出求救，也不需要網路）'),
        ),
        _section(context, '求救類型'),
        for (final type in RescueRequestType.values)
          RadioListTile<RescueRequestType>(
            key: ValueKey<String>('rescue-type-${type.wireValue}'),
            contentPadding: EdgeInsets.zero,
            secondary: Icon(MapIconCatalog.rescueRequest(type)),
            title: Text(type.label),
            value: type,
            groupValue: draft.type,
            onChanged: submitting ? null : (value) => onDraftChanged(draft.copyWith(type: value)),
          ),
        _section(context, '需要救援的是'),
        Wrap(
          spacing: 8,
          children: <Widget>[
            for (final subject in RescueSubject.values)
              ChoiceChip(
                key: ValueKey<String>('rescue-subject-${subject.wireValue}'),
                label: Text(subject.label),
                selected: draft.subject == subject,
                onSelected: submitting ? null : (_) => onDraftChanged(draft.copyWith(subject: subject)),
              ),
          ],
        ),
        _section(context, '目前狀況'),
        _question('immobile', '是否無法移動', draft.triage.immobile, (answer) => draft.triage.copyWith(immobile: answer)),
        _question('breathing_difficulty', '是否呼吸困難', draft.triage.breathingDifficulty, (answer) => draft.triage.copyWith(breathingDifficulty: answer)),
        _question('severe_bleeding', '是否大量出血', draft.triage.severeBleeding, (answer) => draft.triage.copyWith(severeBleeding: answer)),
        if (draft.subject == RescueSubject.others)
          _question('conscious', '是否清醒', draft.triage.conscious, (answer) => draft.triage.copyWith(conscious: answer)),
        _section(context, '需要救援的人數'),
        Row(
          children: <Widget>[
            IconButton(
              key: const ValueKey<String>('rescue-people-minus'),
              tooltip: '減少人數',
              onPressed: submitting || draft.peopleCount <= 1 ? null : () => onDraftChanged(draft.copyWith(peopleCount: draft.peopleCount - 1)),
              icon: const Icon(Icons.remove),
            ),
            Text('${draft.peopleCount} 人', style: theme.textTheme.titleMedium),
            IconButton(
              key: const ValueKey<String>('rescue-people-plus'),
              tooltip: '增加人數',
              onPressed: submitting || draft.peopleCount >= rescuePeopleMax ? null : () => onDraftChanged(draft.copyWith(peopleCount: draft.peopleCount + 1)),
              icon: const Icon(Icons.add),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          children: <Widget>[
            Flexible(
              child: Text(
                '急迫程度：${draft.urgency.label}（${draft.urgencyReason}）',
                key: const ValueKey<String>('rescue-urgency-preview'),
                style: theme.textTheme.titleSmall,
              ),
            ),
            if (draft.type == RescueRequestType.trappedDebris) ...<Widget>[
              const SizedBox(width: 8),
              const Chip(label: Text('固定為危急')),
            ],
          ],
        ),
        _section(context, '求救位置'),
        Text(_locationText()),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            OutlinedButton.icon(onPressed: submitting ? null : onRequestCurrentLocation, icon: const Icon(Icons.my_location), label: const Text('使用目前位置')),
            OutlinedButton.icon(onPressed: submitting ? null : onRequestMapPick, icon: const Icon(Icons.pin_drop_outlined), label: const Text('地圖選點')),
          ],
        ),
        if (addressController != null) ...<Widget>[
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey<String>('rescue-address'),
            controller: addressController,
            enabled: !submitting,
            onChanged: onAddressChanged,
            decoration: const InputDecoration(
              labelText: '輸入區域、道路或地址',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
          ),
          if (addressController!.text.trim().isNotEmpty)
            ...addressResults.take(5).map(
              (result) => ListTile(
                dense: true,
                title: Text(result.displayTitle),
                subtitle: Text(result.typeLabel),
                onTap: onAddressSelected == null || result.coordinate == null ? null : () => onAddressSelected!(result),
              ),
            ),
        ],
        const SizedBox(height: 12),
        TextFormField(
          key: const ValueKey<String>('rescue-description'),
          initialValue: draft.description,
          maxLength: rescueDescriptionMaxCodePoints,
          maxLines: 3,
          enabled: !submitting,
          onChanged: (value) => onDraftChanged(draft.copyWith(description: value)),
          decoration: const InputDecoration(
            labelText: '補充說明（選填，最多 160 字）',
            helperText: rescueDescriptionHelper,
            helperMaxLines: 2,
            border: OutlineInputBorder(),
          ),
        ),
        Row(
          children: <Widget>[
            TextButton(onPressed: submitting ? null : onCancel, child: const Text('取消')),
            const Spacer(),
            ElevatedButton(
              key: const ValueKey<String>('rescue-confirm'),
              onPressed: draft.location != null && draft.locationSource != null && !submitting ? onShowConfirmation : null,
              child: const Text('確認內容'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _question(String field, String label, TriageAnswer current, RescueTriage Function(TriageAnswer) update) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: <Widget>[
        Expanded(child: Text(label)),
        for (final answer in TriageAnswer.values)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: ChoiceChip(
              key: ValueKey<String>('rescue-triage-$field-${answer.wireValue}'),
              label: Text(answer.label),
              selected: current == answer,
              onSelected: submitting ? null : (_) => onDraftChanged(draft.copyWith(triage: update(answer))),
            ),
          ),
      ],
    ),
  );

  Widget _confirmBody(BuildContext context) {
    final theme = Theme.of(context);
    final unsupported = !_canSign;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(context, isUpdate ? '確認更新內容' : '確認求救內容'),
        Text('位置來源：${_locationSourceLabel()}'),
        if (draft.locationHint != null) Text('搜尋參考：${draft.locationHint!.label}'),
        Text('座標：${_coordinateText()}'),
        Text('類型：${draft.type.label}'),
        Text('對象：${draft.subject.label}'),
        Text('急迫程度：${draft.urgency.label}（${draft.urgencyReason}）'),
        Text('人數：${draft.peopleCount} 人'),
        Text('描述：${draft.description.trim().isEmpty ? '無描述' : draft.description.trim()}'),
        const SizedBox(height: 12),
        Text(rescueUnverifiedText, style: const TextStyle(color: unverifiedEventColor, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(rescuePrivacyText, style: theme.textTheme.bodySmall),
        const SizedBox(height: 4),
        Text(rescueNot119Text, style: theme.textTheme.bodySmall),
        if (capabilities?.supportsMesh == false && !isUpdate)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(rescueBrowserKeyText, style: theme.textTheme.bodySmall),
          ),
        if (unsupported)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              const RescueFailure(code: RescueFailureCode.unsupported, message: 'signing_unsupported').userMessage(),
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        if (errorMessage != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(errorMessage!, key: const ValueKey<String>('rescue-error'), style: TextStyle(color: theme.colorScheme.error)),
          ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            TextButton(onPressed: submitting ? null : onBackToEdit, child: const Text('返回修改')),
            const Spacer(),
            ElevatedButton.icon(
              key: const ValueKey<String>('rescue-submit'),
              onPressed: submitting || unsupported ? null : onSubmit,
              icon: submitting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.send),
              label: Text(isUpdate ? '確認更新' : '確認送出'),
            ),
          ],
        ),
      ],
    );
  }

  String _locationText() {
    if (draft.location == null) return '尚未選擇位置';
    return '${_locationSourceLabel()}：${_coordinateText()}';
  }

  String _locationSourceLabel() => switch (draft.locationSource) {
    CrowdReportLocationSource.currentLocation => '目前位置',
    CrowdReportLocationSource.mapPick => '地圖選點',
    null => '尚未選擇',
  };

  String _coordinateText() {
    final point = draft.location;
    if (point == null) return '無資料';
    return '${point.latitude.toStringAsFixed(6)}, ${point.longitude.toStringAsFixed(6)}';
  }
}
```

- [ ] **Step 4: 抽出 `MapLocationPickerBar`**

在 `crowd_report_sheet.dart` 新增通用 widget，`CrowdReportMapPickerBar.build` 改為回傳它：

```dart
class MapLocationPickerBar extends StatelessWidget {
  const MapLocationPickerBar({
    super.key,
    required this.title,
    required this.instruction,
    required this.point,
    required this.onBack,
    required this.onConfirm,
    this.backKey = const ValueKey<String>('report-location-back'),
    this.confirmKey = const ValueKey<String>('report-location-confirm'),
  });

  final String title;
  final String instruction;
  final GeoPoint? point;
  final VoidCallback onBack;
  final VoidCallback onConfirm;
  final Key backKey;
  final Key confirmKey;

  @override
  Widget build(BuildContext context) => Material(
    // 內容搬自原 CrowdReportMapPickerBar.build：title、instruction、
    // 「地圖中心：lat, lon」或「尚未取得地圖中心位置」、返回表單／確認此位置兩鍵（使用 backKey／confirmKey）。
  );
}
```

（把原 `CrowdReportMapPickerBar.build` 的 Material 樹整段搬入，`'拖動地圖調整警示位置'` 改用 `title`，hint 文字改用 `instruction`。）`CrowdReportMapPickerBar.build`：

```dart
  @override
  Widget build(BuildContext context) => MapLocationPickerBar(
    title: '拖動地圖調整警示位置',
    instruction: draft.locationHint == null ? '將中心圖釘放在警示發生的位置' : '已定位到「${draft.locationHint!.label}」，請拖動地圖微調',
    point: draft.location,
    onBack: onBackToForm,
    onConfirm: onConfirm,
  );
```

- [ ] **Step 5: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_request_sheet_test.dart test/crowd_report_sheet_test.dart test/crowd_report_flow_test.dart`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add flutter/lib/widgets/rescue_request_sheet.dart flutter/lib/widgets/crowd_report_sheet.dart flutter/test/rescue_request_sheet_test.dart
git commit -m "feat(flutter): rescue request form with derived urgency"
```

---

### Task 21: 求救流程控制與首頁狀態卡

**Files:**
- Create: `flutter/lib/app/rescue_flow_controller.dart`
- Create: `flutter/lib/widgets/rescue_status_card.dart`
- Test: `flutter/test/rescue_flow_controller_test.dart`
- Test: `flutter/test/rescue_status_card_test.dart`
- Create: `flutter/test/support/fake_rescue_service.dart`

**Interfaces:**
- Consumes: Task 16、Task 20
- Produces（`RescueFlowController extends ChangeNotifier`）：
  - 建構：`RescueFlowController({required RescueService service, DateTime Function()? clock})`
  - 狀態：`RescueCapabilities? capabilities`、`List<RescueSession> sessions`、`RescueDraft? draft`、`RescueSheetStep? step`（null 表示表單關閉）、`String? editingEventId`、`bool busy`、`String? errorMessage`、`String? notice`（一次性訊息，讀取後由 UI 呼叫 `consumeNotice()`）
  - 衍生：`RescueSession? get activeSession`（自己最新、`isActiveAt(now)` 的那筆）、`bool get showsSirenShortcut`（active 且類型為 TRAPPED_DEBRIS）、`bool get expiryReminderDue`（active、`canExtendAt(now)`、距到期 ≤ 30 分鐘）、`RescueSession? get expiredSession`（沒有 active 時，自己最新一筆狀態仍為 ACTIVE 但已過期、且過期不到 24 小時的求救；用來提供「以原內容重新建立」）
  - 方法：`Future<void> load()`、`void startNew()`、`void startRecreate()`（以 `expiredSession` 的內容預填一筆**新的**求救，`editingEventId` 為 null）、`void startUpdate()`、`void closeSheet()`、`void updateDraft(RescueDraft)`、`void showConfirmation()`、`void backToEdit()`、`Future<void> submit()`、`Future<void> extend()`、`Future<void> resolve()`、`Future<void> cancelRequest()`、`Future<void> refresh()`、`String? consumeNotice()`
  - 計時：每 60 秒 `refresh()`（Web 會 flush outbox；兩端都重算提醒）
- Produces（`RescueStatusCard`）：參數 `session`、`now`、`reminderDue`、`busy`、`sirenPanel`（`Widget?`）、`onUpdate`、`onExtend`、`onResolve`、`onCancel`；keys：`rescue-status-card`、`rescue-extend`、`rescue-resolve`、`rescue-cancel`、`rescue-update`、`rescue-expiry-reminder`
- Produces（測試支援 `FakeRescueService implements RescueService`）：可設定 `capabilitiesResult`、`initialSessions`、`submitResult`／`submitError`／`pendingSubmit`（`Completer`）、記錄 `submitCalls`、`revisions`（`List<(String, RescueAction)>`）、`nearbyResult`

- [ ] **Step 1: 建立測試支援檔**

`flutter/test/support/fake_rescue_service.dart`：

```dart
import 'dart:async';

import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';

/// A rescue session built from fields, for widget and controller tests.
RescueSession fakeSession({
  String status = 'ACTIVE',
  String type = 'TRAPPED_DEBRIS',
  String issuedAt = '2026-10-12T03:00:00Z',
  String expiresAt = '2026-10-12T09:00:00Z',
  int version = 1,
  bool meshPending = true,
  RescueDelivery server = RescueDelivery.waitingUpload,
}) {
  final event = MeshEvent.fromJson(<String, dynamic>{
    'namespace': 'crowd.rescue',
    'event_id': 'rescue:${'a' * 32}:00000000-0000-4000-8000-000000000001',
    'event_version': version,
    'event_type': 'RESCUE_REQUEST',
    'severity': type == 'TRAPPED_DEBRIS' ? 'CRITICAL' : 'HIGH',
    'source': 'CROWD',
    'issued_at': issuedAt,
    'expires_at': expiresAt,
    'apply_state': 'UNVERIFIED',
    'geometry': <String, dynamic>{'type': 'Point', 'coordinates': <double>[121.5, 25.0]},
    'signing_key_id': 'device:${'a' * 32}',
    'attributes': <String, dynamic>{
      'request_type': type,
      'status': status,
      'subject': 'SELF',
      'people_count': 1,
      'triage': <String, String>{'immobile': 'YES', 'breathing_difficulty': 'NO', 'severe_bleeding': 'NO', 'conscious': 'YES'},
      'description': '',
      'location_source': 'CURRENT_LOCATION',
      'first_issued_at': '2026-10-12T03:00:00Z',
      'area_id': 'crowd',
      'theme': 'rescue',
    },
  });
  return RescueSession(request: RescueRequestView.fromEvent(event)!, meshPending: meshPending, server: server);
}

class FakeRescueService implements RescueService {
  RescueCapabilities capabilitiesResult = const RescueCapabilities(canSign: true, canVerify: true, hasStorage: true, supportsMesh: true);
  List<RescueSession> initialSessions = const <RescueSession>[];
  RescueSession? submitResult;
  RescueFailure? submitError;
  Completer<RescueSession>? pendingSubmit;
  final Map<RescueAction, RescueSession> revisionResults = <RescueAction, RescueSession>{};
  List<MeshEvent> nearbyResult = const <MeshEvent>[];
  int submitCalls = 0;
  int flushCalls = 0;
  final List<(String, RescueAction)> revisions = <(String, RescueAction)>[];
  final List<RescueBounds> nearbyCalls = <RescueBounds>[];

  @override
  Future<RescueCapabilities> capabilities() async => capabilitiesResult;

  @override
  Future<List<RescueSession>> ownSessions() async => initialSessions;

  @override
  Future<List<RescueSession>> flush() async {
    flushCalls += 1;
    return initialSessions;
  }

  @override
  Future<RescueSession> submit(RescueDraft draft) {
    submitCalls += 1;
    if (submitError != null) return Future<RescueSession>.error(submitError!);
    if (pendingSubmit != null) return pendingSubmit!.future;
    return Future<RescueSession>.value(submitResult ?? fakeSession());
  }

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) async {
    revisions.add((eventId, action));
    return revisionResults[action] ?? fakeSession(version: 2, status: switch (action) {
      RescueAction.resolve => 'RESOLVED',
      RescueAction.cancel => 'CANCELLED',
      _ => 'ACTIVE',
    });
  }

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) async {
    nearbyCalls.add(bounds);
    return nearbyResult;
  }
}
```

- [ ] **Step 2: 寫失敗的 controller 測試**

`flutter/test/rescue_flow_controller_test.dart`：

```dart
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/rescue_flow_controller.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/widgets/rescue_request_sheet.dart';

import 'support/fake_rescue_service.dart';

void main() {
  var now = DateTime.parse('2026-10-12T04:00:00Z');
  late FakeRescueService service;
  late RescueFlowController controller;

  setUp(() {
    now = DateTime.parse('2026-10-12T04:00:00Z');
    service = FakeRescueService();
    controller = RescueFlowController(service: service, clock: () => now);
  });

  tearDown(() => controller.dispose());

  RescueDraft located() => RescueDraft.initial().copyWith(
    location: const GeoPoint(longitude: 121.5, latitude: 25.0),
    locationSource: CrowdReportLocationSource.currentLocation,
  );

  test('restores an ACTIVE request after the app restarts', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    expect(controller.activeSession, isNotNull);
    expect(controller.showsSirenShortcut, isTrue);
  });

  test('ended or expired requests are not treated as in progress', () async {
    service.initialSessions = <RescueSession>[fakeSession(status: 'RESOLVED')];
    await controller.load();
    expect(controller.activeSession, isNull);
    service.initialSessions = <RescueSession>[fakeSession(expiresAt: '2026-10-12T03:59:00Z')];
    await controller.load();
    expect(controller.activeSession, isNull);
  });

  test('submit is single-flight and failures keep the sheet open', () async {
    await controller.load();
    controller
      ..startNew()
      ..updateDraft(located())
      ..showConfirmation();
    service.pendingSubmit = Completer<RescueSession>();
    final first = controller.submit();
    final second = controller.submit();
    expect(service.submitCalls, 1);
    service.pendingSubmit!.complete(fakeSession());
    await Future.wait(<Future<void>>[first, second]);
    expect(controller.step, isNull);
    expect(controller.activeSession, isNotNull);
    expect(controller.consumeNotice(), '求救已建立：未經查證');

    controller
      ..startNew()
      ..updateDraft(located())
      ..showConfirmation();
    service
      ..pendingSubmit = null
      ..submitError = const RescueFailure(code: RescueFailureCode.conflict, message: 'rescue_active_exists');
    await controller.submit();
    expect(controller.step, RescueSheetStep.confirm);
    expect(controller.errorMessage, '此裝置已有進行中的求救，請先更新或結束它');
  });

  test('resolve, cancel and extend go through the service with the right action', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    await controller.extend();
    await controller.resolve();
    expect(service.revisions.map((entry) => entry.$2), <RescueAction>[RescueAction.extend, RescueAction.resolve]);
    expect(controller.activeSession, isNull);
  });

  test('the expiry reminder appears 30 minutes before expiry', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    expect(controller.expiryReminderDue, isFalse);
    now = DateTime.parse('2026-10-12T08:31:00Z');
    expect(controller.expiryReminderDue, isTrue);
  });

  test('after expiry the request can only be re-created as a new one, prefilled', () async {
    service.initialSessions = <RescueSession>[fakeSession()];
    await controller.load();
    now = DateTime.parse('2026-10-12T09:30:00Z');
    expect(controller.activeSession, isNull);
    expect(controller.expiredSession, isNotNull);
    controller.startRecreate();
    expect(controller.editingEventId, isNull);
    expect(controller.draft!.type, RescueRequestType.trappedDebris);
    expect(controller.step, RescueSheetStep.edit);
    now = DateTime.parse('2026-10-13T10:00:00Z');
    expect(controller.expiredSession, isNull);
  });
}
```

- [ ] **Step 3: 寫失敗的狀態卡測試**

`flutter/test/rescue_status_card_test.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/widgets/rescue_status_card.dart';

import 'support/fake_rescue_service.dart';

void main() {
  testWidgets('the card states status, delivery and the unverified limits', (tester) async {
    var resolved = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: RescueStatusCard(
          session: fakeSession(),
          now: DateTime.parse('2026-10-12T08:40:00Z'),
          reminderDue: true,
          busy: false,
          sirenPanel: const Text('SIREN-SLOT'),
          onUpdate: () {},
          onExtend: () {},
          onResolve: () => resolved++,
          onCancel: () {},
        ),
      ),
    ));
    expect(find.text('你的求救：受困於瓦礫或倒塌建物下'), findsOneWidget);
    expect(find.text('急迫程度：危急　狀態：進行中'), findsOneWidget);
    expect(find.text('已存於本機，等待附近裝置轉傳；伺服器：等待上傳，尚未送出'), findsOneWidget);
    expect(find.text('未經查證，不代表已派遣救援'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('rescue-expiry-reminder')), findsOneWidget);
    expect(find.text('SIREN-SLOT'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-resolve')));
    await tester.pumpAndSettle();
    expect(find.text('確認你已安全或已獲救？'), findsOneWidget);
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();
    expect(resolved, 1);
  });
}
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_flow_controller_test.dart test/rescue_status_card_test.dart`
Expected: 編譯失敗

- [ ] **Step 5: 實作 `rescue_flow_controller.dart`**

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/rescue_request_models.dart';
import '../data/rescue_service.dart';
import '../widgets/rescue_request_sheet.dart';

/// Rescue flow state shared by Android and Web. Nothing here is persisted:
/// the active request is restored from the platform's own store (Room or the
/// browser's IndexedDB) through [RescueService.ownSessions].
class RescueFlowController extends ChangeNotifier {
  RescueFlowController({required RescueService service, DateTime Function()? clock})
    : _service = service,
      _clock = clock ?? DateTime.now;

  static const reminderWindow = Duration(minutes: 30);
  static const refreshInterval = Duration(seconds: 60);

  final RescueService _service;
  final DateTime Function() _clock;
  Timer? _refreshTimer;
  bool _disposed = false;

  RescueCapabilities? capabilities;
  List<RescueSession> sessions = const <RescueSession>[];
  RescueDraft? draft;
  RescueSheetStep? step;
  String? editingEventId;
  bool busy = false;
  String? errorMessage;
  String? _notice;

  DateTime get now => _clock().toUtc();

  RescueSession? get activeSession {
    final active = sessions.where((session) => session.request.isActiveAt(now)).toList()
      ..sort((a, b) => (b.request.event.eventVersion ?? 0).compareTo(a.request.event.eventVersion ?? 0));
    return active.isEmpty ? null : active.first;
  }

  bool get showsSirenShortcut => activeSession?.request.type == RescueRequestType.trappedDebris;

  bool get expiryReminderDue {
    final active = activeSession;
    if (active == null || !active.request.canExtendAt(now)) return false;
    return active.request.expiresAt.difference(now) <= reminderWindow;
  }

  /// The latest own request that ran out while still ACTIVE, within a day.
  /// An expired request cannot be extended; it can only be filed again.
  RescueSession? get expiredSession {
    if (activeSession != null) return null;
    final expired = sessions.where((session) {
      final request = session.request;
      return request.status == RescueStatus.active &&
          !request.expiresAt.isAfter(now) &&
          now.difference(request.expiresAt) < const Duration(hours: 24);
    }).toList()
      ..sort((a, b) => b.request.expiresAt.compareTo(a.request.expiresAt));
    return expired.isEmpty ? null : expired.first;
  }

  Future<void> load() async {
    try {
      capabilities = await _service.capabilities();
      sessions = await _service.ownSessions();
    } on RescueFailure catch (failure) {
      errorMessage = failure.userMessage();
    }
    _refreshTimer ??= Timer.periodic(refreshInterval, (_) => unawaited(refresh()));
    _notify();
  }

  Future<void> refresh() async {
    try {
      sessions = await _service.flush();
    } on RescueFailure {
      // Keep the last known sessions; delivery text already says what is pending.
    }
    _notify();
  }

  void startNew() {
    draft = RescueDraft.initial();
    editingEventId = null;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void startRecreate() {
    final expired = expiredSession;
    if (expired == null) return;
    draft = RescueDraft.fromView(expired.request);
    editingEventId = null;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void startUpdate() {
    final active = activeSession;
    if (active == null) return;
    draft = RescueDraft.fromView(active.request);
    editingEventId = active.request.eventId;
    step = RescueSheetStep.edit;
    errorMessage = null;
    _notify();
  }

  void closeSheet() {
    if (busy) return;
    draft = null;
    step = null;
    editingEventId = null;
    errorMessage = null;
    _notify();
  }

  void updateDraft(RescueDraft next) {
    draft = next;
    _notify();
  }

  void showConfirmation() {
    final error = draft?.validate();
    if (error != null) {
      errorMessage = error;
      _notify();
      return;
    }
    errorMessage = null;
    step = RescueSheetStep.confirm;
    _notify();
  }

  void backToEdit() {
    step = RescueSheetStep.edit;
    _notify();
  }

  Future<void> submit() async {
    final current = draft;
    if (current == null || busy) return;
    final eventId = editingEventId;
    await _run(() async {
      final session = eventId == null
          ? await _service.submit(current)
          : await _service.revise(eventId, RescueAction.update, draft: current);
      _replace(session);
      draft = null;
      step = null;
      editingEventId = null;
      _notice = eventId == null ? '求救已建立：未經查證' : '求救已更新：未經查證';
    });
  }

  Future<void> extend() => _revise(RescueAction.extend, '求救已延長');
  Future<void> resolve() => _revise(RescueAction.resolve, '已標記為安全／已獲救');
  Future<void> cancelRequest() => _revise(RescueAction.cancel, '求救已取消');

  String? consumeNotice() {
    final value = _notice;
    _notice = null;
    return value;
  }

  Future<void> _revise(RescueAction action, String notice) async {
    final active = activeSession;
    if (active == null || busy) return;
    await _run(() async {
      _replace(await _service.revise(active.request.eventId, action));
      _notice = notice;
    });
  }

  Future<void> _run(Future<void> Function() work) async {
    busy = true;
    errorMessage = null;
    _notify();
    try {
      await work();
    } on RescueFailure catch (failure) {
      errorMessage = failure.userMessage();
      _notice = step == null ? failure.userMessage() : null;
    } finally {
      busy = false;
      _notify();
    }
  }

  void _replace(RescueSession session) {
    sessions = <RescueSession>[
      for (final existing in sessions)
        if (existing.request.eventId != session.request.eventId) existing,
      session,
    ];
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _refreshTimer?.cancel();
    super.dispose();
  }
}
```

`submit()` 的單飛行為：第二次呼叫時 `busy` 已為 true，直接 return；兩個 future 都在第一次完成後結束（測試以 `Future.wait` 等待）。

- [ ] **Step 6: 實作 `rescue_status_card.dart`**

```dart
import 'package:flutter/material.dart';

import '../data/display_time.dart';
import '../data/rescue_request_models.dart';
import 'map_layers.dart';
import 'rescue_marker.dart';
import 'rescue_request_sheet.dart';

class RescueStatusCard extends StatelessWidget {
  const RescueStatusCard({
    super.key,
    required this.session,
    required this.now,
    required this.reminderDue,
    required this.busy,
    required this.sirenPanel,
    required this.onUpdate,
    required this.onExtend,
    required this.onResolve,
    required this.onCancel,
  });

  final RescueSession session;
  final DateTime now;
  final bool reminderDue;
  final bool busy;
  final Widget? sirenPanel;
  final VoidCallback onUpdate;
  final VoidCallback onExtend;
  final VoidCallback onResolve;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final request = session.request;
    final theme = Theme.of(context);
    return Card(
      key: const ValueKey<String>('rescue-status-card'),
      elevation: 6,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: rescueUrgencyColor(request.urgency), width: 2),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (sirenPanel != null) ...<Widget>[sirenPanel!, const SizedBox(height: 8)],
            Row(
              children: <Widget>[
                Icon(MapIconCatalog.rescueRequest(request.type), color: rescueUrgencyColor(request.urgency)),
                const SizedBox(width: 8),
                Expanded(child: Text('你的求救：${request.type.label}', style: theme.textTheme.titleMedium)),
              ],
            ),
            Text('急迫程度：${request.urgency.label}　狀態：${request.status.label}'),
            Text(session.deliveryText()),
            Text('到期：${formatUpdateTime(request.expiresAt.toIso8601String())}'),
            const Text('未經查證，不代表已派遣救援', style: TextStyle(color: unverifiedEventColor, fontWeight: FontWeight.w600)),
            const Text(rescueNot119Text),
            if (reminderDue)
              Container(
                key: const ValueKey<String>('rescue-expiry-reminder'),
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('求救將於 ${formatUpdateTime(request.expiresAt.toIso8601String())} 到期，仍需救援？'),
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                OutlinedButton(key: const ValueKey<String>('rescue-update'), onPressed: busy ? null : onUpdate, child: const Text('更新')),
                if (request.canExtendAt(now))
                  OutlinedButton(key: const ValueKey<String>('rescue-extend'), onPressed: busy ? null : onExtend, child: const Text('延長 6 小時')),
                FilledButton(
                  key: const ValueKey<String>('rescue-resolve'),
                  onPressed: busy ? null : () => _confirm(context, '確認你已安全或已獲救？', onResolve),
                  child: const Text('我已安全／已獲救'),
                ),
                TextButton(
                  key: const ValueKey<String>('rescue-cancel'),
                  onPressed: busy ? null : () => _confirm(context, '確認取消這筆求救（誤報）？', onCancel),
                  child: const Text('取消誤報'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(BuildContext context, String question, VoidCallback onConfirmed) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(question),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('返回')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('確認')),
        ],
      ),
    );
    if (confirmed == true) onConfirmed();
  }
}
```

`formatUpdateTime` 若只接受 `String?`，上面以 `toIso8601String()` 轉換；若它已能接收 `DateTime`，直接傳入。

- [ ] **Step 7: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_flow_controller_test.dart test/rescue_status_card_test.dart`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add flutter/lib/app/rescue_flow_controller.dart flutter/lib/widgets/rescue_status_card.dart flutter/test/support/fake_rescue_service.dart flutter/test/rescue_flow_controller_test.dart flutter/test/rescue_status_card_test.dart
git commit -m "feat(flutter): rescue flow controller and home status card"
```

---

### Task 22: 首頁整合

**Files:**
- Modify: `flutter/lib/widgets/map_canvas.dart`（新增 `onCameraSettled`）
- Modify: `flutter/lib/screens/map_screen.dart`
- Modify: `flutter/lib/app/map_app_controller.dart`
- Modify: `flutter/lib/main.dart`
- Test: `flutter/test/rescue_flow_test.dart`
- Test: `flutter/test/map_app_controller_rescue_test.dart`

**Interfaces:**
- Consumes: Task 16–21
- Produces:
  - `MapCanvas.onCameraSettled: ValueChanged<GeoPoint>?`：鏡頭停下且位置改變時呼叫，帶地圖中心
  - `MapScreen` 新參數：`RescueService? rescueService`、`ValueChanged<GeoPoint>? onViewportSettled`、`Widget Function(BuildContext, RescueFlowController)? sirenPanelBuilder`（06 Task 26 提供；`null` 表示不顯示警報入口）
  - 首頁快速操作新增 `需要救援`（semantics label 同文字、key `open-rescue-request`），位置在「回報警示」左邊
  - `MapAppController` 新參數 `RescueService? rescueService`；新增 `RescueService get rescueService`、`void setRescueViewport(GeoPoint center)`；Web 時把 `nearby` 結果併入 `events` 與 `eventUpdates`；每 60 秒以最後的中心點重查
  - `MapAppController.dispose()` 取消 rescue timer

整合規則：

1. `_MapScreenState.initState` 建立 `_rescue = RescueFlowController(service: widget.rescueService ?? RescueService.forPlatform(bridge: _bridge))`，`addListener(_onRescueChanged)`，`unawaited(_rescue.load())`；`dispose` 時 `removeListener` 與 `dispose`。`_onRescueChanged` 呼叫 `setState(() {})`，並把 `_rescue.consumeNotice()` 用 `_showMessage` 顯示。
2. 新增 `enum _PickTarget { report, rescue }` 欄位 `_pickTarget`。`_reportPicking` 沿用為「正在地圖選點」旗標；`_onReportCameraSettled` 依 `_pickTarget` 更新 crowd draft 或 `_rescue.updateDraft(draft.copyWith(location: point, locationSource: CrowdReportLocationSource.mapPick))`。
3. 新增 `_openRescueRequest()`：關閉詳情與其他 sheet，清空 `_reportAddressController`，呼叫 `_rescue.startNew()`。`_rescueSheetHidden`（bool）在選點時為 true。
4. 新增 `_setRescueCurrentLocation()`、`_beginRescueMapPick()`、`_confirmRescueMapLocation()`、`_returnToRescueForm()`、`_onRescueAddressSelected(MapSearchResult)`，寫法與 report 版本相同，但寫入 `_rescue.draft`；地址搜尋共用 `_reportAddressController`、`_onReportAddressChanged`、`_reportSearchResults`、`_locationHintFor`。
5. `build()`：
   - `_MapQuickActions` 增加 `onRescue`，任何 sheet／選點進行中時為 null。
   - 在 quick actions 那個 `Row` 之後、`if (_reportPicking)` 之前，若 `_rescue.activeSession != null && _rescue.step == null && !_reportPicking`，放 `PointerInterceptor(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: 520), child: RescueStatusCard(...)))`，`sirenPanel: _rescue.showsSirenShortcut ? widget.sirenPanelBuilder?.call(context, _rescue) : null`。
   - 沒有 active、但 `_rescue.expiredSession != null` 且 `_rescue.step == null` 時，在同一位置放一張小卡（key `rescue-expired-banner`）：「你的求救已到期，已不再顯示給其他人」與按鍵「以原內容重新建立」（key `rescue-recreate`，呼叫 `_rescue.startRecreate()`）。
   - `_rescue.step != null && !_rescueSheetHidden` 時在底部顯示 `RescueRequestSheet`（`capabilities: _rescue.capabilities`、`errorMessage: _rescue.errorMessage`、`onOpenSirenOnly: _openSirenOnly`）。
   - 選點中且 `_pickTarget == rescue` 時顯示 `MapLocationPickerBar(title: '拖動地圖調整求救位置', instruction: '將中心圖釘放在需要救援的位置', point: _rescue.draft?.location, backKey: const ValueKey('rescue-location-back'), confirmKey: const ValueKey('rescue-location-confirm'), ...)`。
   - `MapCanvas(onCameraSettled: widget.onViewportSettled, ...)`。
   - `FeatureDetailsSheet.event` 傳 `confirmedEarlierVersion: AttestationIndex.fromEvents(_persistedEvents).confirmedOtherVersion(_selectedEvent!)`（Task 19）。
6. `_openSirenOnly()`：06 Task 26 實作；本任務先寫成 `void _openSirenOnly() => _showMessage('定位警報聲尚未啟用');` 並在 06 替換——**不得**保留到交付。
7. `_visibleEvents`：把 `_rescue.sessions` 的 `request.event` 併入（同 identity 取 `eventVersion` 較大者），讓 Web 尚未上傳的自己求救也顯示在地圖上；Android 上兩者相同版本，不會重複。

`MapCanvas._onMapSettled` 在 `widget.onReportCameraIdle?.call(...)` 之後加入：

```dart
    if (cameraChanged) {
      widget.onCameraSettled?.call(
        GeoPoint(longitude: position.target.longitude, latitude: position.target.latitude),
      );
    }
```

`MapAppController`：

```dart
  MapAppController({
    // ...既有參數
    RescueService? rescueService,
  }) : // ...既有初始化
       _rescueServiceOverride = rescueService { ... }

  final RescueService? _rescueServiceOverride;
  late final RescueService rescueService =
      _rescueServiceOverride ?? RescueService.forPlatform(bridge: bridge, isWeb: _isWeb);
  List<MeshEvent> _rescueNearby = const <MeshEvent>[];
  GeoPoint? _rescueCenter;
  DateTime? _rescueFetchedAt;
  Timer? _rescueTimer;
  bool _rescueFetching = false;

  /// Map centre after the camera settles. Fetches rescue points around it at
  /// most once per 60 s unless the centre moved more than ~1 km.
  void setRescueViewport(GeoPoint center) {
    final previous = _rescueCenter;
    _rescueCenter = center;
    final moved = previous == null ||
        (previous.longitude - center.longitude).abs() > 0.01 ||
        (previous.latitude - center.latitude).abs() > 0.01;
    final stale = _rescueFetchedAt == null || DateTime.now().difference(_rescueFetchedAt!) >= const Duration(seconds: 60);
    if (moved || stale) unawaited(_refreshRescueNearby());
    _rescueTimer ??= Timer.periodic(const Duration(seconds: 60), (_) => unawaited(_refreshRescueNearby()));
  }

  Future<void> _refreshRescueNearby() async {
    final center = _rescueCenter;
    if (_disposed || center == null || _rescueFetching) return;
    _rescueFetching = true;
    try {
      _rescueNearby = List<MeshEvent>.unmodifiable(await rescueService.nearby(RescueBounds.around(center)));
      _rescueFetchedAt = DateTime.now();
      _publishEvents();
    } on RescueFailure {
      // Offline or server not configured: keep what we have; the map never
      // shows unverified server data in its place.
    } finally {
      _rescueFetching = false;
    }
  }

  /// Persisted (Room or signed government feed) plus verified server rescue points.
  List<MeshEvent> get _publishedEvents {
    final byId = <String, MeshEvent>{};
    for (final event in <MeshEvent>[...persistedEvents, ..._rescueNearby]) {
      final key = meshEventIdentity(event);
      final existing = byId[key];
      if (existing == null || (event.eventVersion ?? 0) > (existing.eventVersion ?? 0)) byId[key] = event;
    }
    return byId.values.toList(growable: false);
  }

  void _publishEvents() {
    _eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents));
    _notifyIfAlive();
  }
```

- `events` getter 改為遍歷 `_withoutExpiredEvents(_publishedEvents)`。
- 所有 `_eventUpdates.add(...persistedEvents...)` 改為 `_eventUpdates.add(List<MeshEvent>.unmodifiable(_publishedEvents))`（`_listenToNativeEvents`、`retryEventUpdates`、`_refreshWebGovernmentFeed`、`_scheduleExpiryRefresh`、`didChangeAppLifecycleState` 共五處）。
- `dispose()` 加 `_rescueTimer?.cancel();`。

`main.dart` 的 `MapScreen(...)` 加入：

```dart
                  rescueService: controller.rescueService,
                  onViewportSettled: controller.setRescueViewport,
```

- [ ] **Step 1: 寫失敗的整合測試**

`flutter/test/rescue_flow_test.dart`（沿用 `crowd_report_flow_test.dart` 的 `_FakeMapBridge`／`_FakeLocationController` 寫法，複製到本檔）：

```dart
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/location_controller.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';
import 'package:resilientgeo_flutter/screens/map_screen.dart';

import 'support/fake_rescue_service.dart';

void main() {
  testWidgets('submits a TRAPPED_DEBRIS request and shows the active card', (tester) async {
    final service = FakeRescueService();
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);

    await tester.tap(find.bySemanticsLabel('需要救援'));
    await tester.pump();
    expect(find.text('急迫程度：危急（受困於瓦礫或倒塌建物下）'), findsOneWidget);
    await tester.ensureVisible(find.text('使用目前位置'));
    await tester.tap(find.text('使用目前位置'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-confirm')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-confirm')));
    await tester.pump();
    expect(find.text('送出後為未經查證的求救，不代表已派遣救援'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();

    expect(service.submitCalls, 1);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsOneWidget);
    expect(find.text('求救已建立：未經查證'), findsOneWidget);
  });

  testWidgets('a failed submit keeps the form and never shows the card', (tester) async {
    final service = FakeRescueService()
      ..submitError = const RescueFailure(code: RescueFailureCode.signingUnavailable, message: 'x');
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    await _openAndConfirm(tester);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();
    expect(find.text('裝置安全簽署不可用，求救未送出'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
    expect(find.byKey(const ValueKey<String>('rescue-submit')), findsOneWidget);
  });

  testWidgets('an ACTIVE request is restored on start and can be marked safe', (tester) async {
    final service = FakeRescueService()..initialSessions = <RescueSession>[fakeSession()];
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-resolve')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('確認'));
    await tester.pumpAndSettle();
    expect(service.revisions.single.$2, RescueAction.resolve);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
  });

  testWidgets('an expired request offers to file it again instead of extending', (tester) async {
    final service = FakeRescueService()
      ..initialSessions = <RescueSession>[fakeSession(issuedAt: '2026-10-11T00:00:00Z', expiresAt: DateTime.now().toUtc().subtract(const Duration(minutes: 5)).toIso8601String())];
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    expect(find.byKey(const ValueKey<String>('rescue-status-card')), findsNothing);
    expect(find.byKey(const ValueKey<String>('rescue-expired-banner')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-recreate')));
    await tester.pump();
    expect(find.text('需要救援'), findsWidgets);
    expect(find.byKey(const ValueKey<String>('rescue-confirm')), findsOneWidget);
  });

  testWidgets('duplicate submits are ignored while one is in flight', (tester) async {
    final service = FakeRescueService()..pendingSubmit = Completer<RescueSession>();
    await tester.pumpWidget(_app(service));
    await _finishLoad(tester);
    await _openAndConfirm(tester);
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('rescue-submit')), warnIfMissed: false);
    expect(service.submitCalls, 1);
    service.pendingSubmit!.complete(fakeSession());
    await tester.pump();
  });
}

Future<void> _openAndConfirm(WidgetTester tester) async {
  await tester.tap(find.bySemanticsLabel('需要救援'));
  await tester.pump();
  await tester.ensureVisible(find.text('使用目前位置'));
  await tester.tap(find.text('使用目前位置'));
  await tester.pump();
  await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-confirm')));
  await tester.tap(find.byKey(const ValueKey<String>('rescue-confirm')));
  await tester.pump();
  await tester.ensureVisible(find.byKey(const ValueKey<String>('rescue-submit')));
}

Future<void> _finishLoad(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Widget _app(FakeRescueService service) => MaterialApp(
  home: MapScreen(
    key: UniqueKey(),
    staticFeatures: const StaticFeatureCollection(schemaVersion: 'test', datasetId: 'test', snapshotAt: null, features: <StaticFeature>[]),
    initialState: const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false),
    bridge: _FakeMapBridge(),
    rescueService: service,
    locationController: _FakeLocationController(const GeoPoint(longitude: 121.5, latitude: 25)),
  ),
);

class _FakeMapBridge extends MapBridge {
  _FakeMapBridge() : super(methodChannel: const MethodChannel('test/rescue-flow'));

  @override
  Future<MapInitialState> getInitialState() async =>
      const MapInitialState(events: <MeshEvent>[], emergencyModeEnabled: false);

  @override
  Stream<List<MeshEvent>> get events => const Stream<List<MeshEvent>>.empty();
}

class _FakeLocationController extends LocationController {
  _FakeLocationController(this.result);

  final GeoPoint? result;

  @override
  Stream<GeoPoint> get locations => const Stream<GeoPoint>.empty();

  @override
  Future<GeoPoint?> requestCurrentLocation() async => result;
}
```

`flutter/test/map_app_controller_rescue_test.dart`：

```dart
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/app/map_app_controller.dart';
import 'package:resilientgeo_flutter/data/government_feed_models.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/rescue_events.dart';
import 'support/fake_rescue_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('on the web, verified server rescue points join the event stream', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final service = FakeRescueService()..nearbyResult = <MeshEvent>[rescue(expiresAt: '2999-01-01T00:00:00Z')];
    final controller = MapAppController(
      bridge: MapBridge(methodChannel: const MethodChannel('test/no-native')),
      isWeb: true,
      webStaticLayerLoader: () async => '',
      webGovernmentFeedLoader: () async => const WebGovernmentFeedSnapshot(revision: 1, stale: false, warning: null, events: <MeshEvent>[]),
      rescueService: service,
    );
    await controller.load();
    final next = controller.eventUpdates.first;
    controller.setRescueViewport(const GeoPoint(longitude: 121.5, latitude: 25.0));
    final events = await next;
    expect(events.any((event) => event.namespace == 'crowd.rescue'), isTrue);
    expect(service.nearbyCalls.single.toList()[0], closeTo(121.476, 0.001));
    controller.dispose();
  });
}
```

（`WebGovernmentFeedSnapshot` 的建構參數以 `government_feed_models.dart` 的實際定義為準；若欄位名不同就照實際調整。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_flow_test.dart test/map_app_controller_rescue_test.dart`
Expected: 編譯失敗（`rescueService` 參數不存在）

- [ ] **Step 3: 依「整合規則」實作 map_canvas、map_screen、map_app_controller、main**

- [ ] **Step 4: 執行測試確認通過，並跑既有首頁測試**

Run: `cd flutter; flutter test test/rescue_flow_test.dart test/map_app_controller_rescue_test.dart test/crowd_report_flow_test.dart test/map_screen_test.dart test/map_interaction_test.dart test/evacuation_route_flow_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add flutter/lib/widgets/map_canvas.dart flutter/lib/screens/map_screen.dart flutter/lib/app/map_app_controller.dart flutter/lib/main.dart flutter/test/rescue_flow_test.dart flutter/test/map_app_controller_rescue_test.dart
git commit -m "feat(flutter): 需要救援 on the home map for Android and Web"
```
