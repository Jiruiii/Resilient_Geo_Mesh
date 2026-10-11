// Top-level build file where you can add configuration options common to all sub-projects/modules.
buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        // Nearby 19.4 includes Kotlin 2.3 metadata. Keep the existing AGP/Flutter
        // integration while using a D8/R8 release that understands that metadata.
        classpath("com.android.tools:r8:8.13.19")
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    // KSP is used for Room annotation processing. The Flutter module is
    // built by Flutter's own Gradle plugin and does not share this plugin
    // declaration.
    alias(libs.plugins.ksp) apply false
}
