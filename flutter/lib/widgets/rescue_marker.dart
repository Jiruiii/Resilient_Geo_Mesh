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
