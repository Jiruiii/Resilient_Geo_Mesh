import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

abstract final class AppTheme {
  static const double _fontSizeScale = 1.08;

  static ThemeData light() => _build(Brightness.light);

  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF006C63),
      brightness: brightness,
    );

    return ThemeData(
      brightness: brightness,
      colorScheme: colorScheme,
      typography: _typography(colorScheme),
      fontFamily: 'NotoSansTC',
      useMaterial3: true,
    );
  }

  static Typography _typography(ColorScheme colorScheme) {
    final base = Typography.material2021(
      platform: defaultTargetPlatform,
      colorScheme: colorScheme,
    );

    return base.copyWith(
      englishLike: _scaleGeometry(base.englishLike),
      dense: _scaleGeometry(base.dense),
      tall: _scaleGeometry(base.tall),
    );
  }

  static TextTheme _scaleGeometry(TextTheme theme) {
    TextStyle? scale(TextStyle? style, {bool medium = false}) {
      if (style == null) return null;

      return style.copyWith(
        fontSize:
            style.fontSize == null ? null : style.fontSize! * _fontSizeScale,
        fontWeight: medium ? FontWeight.w500 : null,
      );
    }

    return theme.copyWith(
      displayLarge: scale(theme.displayLarge),
      displayMedium: scale(theme.displayMedium),
      displaySmall: scale(theme.displaySmall),
      headlineLarge: scale(theme.headlineLarge),
      headlineMedium: scale(theme.headlineMedium),
      headlineSmall: scale(theme.headlineSmall),
      titleLarge: scale(theme.titleLarge),
      titleMedium: scale(theme.titleMedium),
      titleSmall: scale(theme.titleSmall),
      bodyLarge: scale(theme.bodyLarge, medium: true),
      bodyMedium: scale(theme.bodyMedium, medium: true),
      bodySmall: scale(theme.bodySmall, medium: true),
      labelLarge: scale(theme.labelLarge, medium: true),
      labelMedium: scale(theme.labelMedium, medium: true),
      labelSmall: scale(theme.labelSmall, medium: true),
    );
  }
}
