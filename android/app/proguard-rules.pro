# Release shrinking (R8). Obfuscation stays off so stack traces and the
# exception class names surfaced in bridge errors remain readable.
-dontobfuscate

# Flutter add-to-app: the host app does not receive the Flutter Gradle
# plugin's rules. FlutterEngine loads the generated registrant by name, and
# R8 has stripped plugin classes before (flutter/flutter#154580).
-keep class io.flutter.plugins.GeneratedPluginRegistrant { *; }
-if class * implements io.flutter.embedding.engine.plugins.FlutterPlugin
-keep,allowshrinking,allowobfuscation class <1>
-dontwarn io.flutter.plugin.**
-dontwarn io.flutter.embedding.**
-dontwarn android.**
# Deferred-component support in the embedding references Play Core, which
# this app does not ship.
-dontwarn com.google.android.play.core.**

# Ed25519 trust adapter (module B) uses Bouncy Castle directly; keep the
# whole library so verification never depends on what R8 considers used.
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
