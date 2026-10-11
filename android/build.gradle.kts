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

// Configure the generated Flutter module from the maintained host project.
// The module defaults to an older compile SDK/NDK than MapLibre requires.
subprojects {
    if (name == "flutter") {
        var windowsSourceAlias: File? = null
        // Flutter 3.29's Windows shader compiler cannot write non-ASCII paths.
        // Keep only generated outputs in an ASCII cache; source stays here so
        // Android Studio builds the actual checkout, including local edits.
        if (System.getProperty("os.name").startsWith("Windows") &&
            projectDir.absolutePath.any { it.code > 127 }) {
            val cacheRoot = System.getenv("LOCALAPPDATA") ?: System.getProperty("java.io.tmpdir")
            require(cacheRoot.all { it.code < 128 }) {
                "Flutter shader output needs an ASCII Windows cache path."
            }
            val checkoutId = rootDir.absolutePath.hashCode().toUInt().toString(16)
            layout.buildDirectory.set(file("$cacheRoot/ResilientGeo/build/$checkoutId/flutter"))
            // gen_snapshot also needs an ASCII path to .dart_tool/app.dill.
            // A junction refers to the same checkout, so edits and hot reload
            // cannot drift into a stale copied project.
            val alias = file("$cacheRoot/ResilientGeo/checkouts/$checkoutId")
            alias.parentFile.mkdirs()
            if (!alias.exists()) {
                val builder = ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "New-Item -ItemType Junction -Path \$env:RGM_LINK -Target \$env:RGM_TARGET -ErrorAction Stop | Out-Null"
                ).redirectErrorStream(true)
                builder.environment()["RGM_LINK"] = alias.absolutePath
                builder.environment()["RGM_TARGET"] = rootDir.parentFile.absolutePath
                val process = builder.start()
                val message = process.inputStream.bufferedReader().readText()
                check(process.waitFor() == 0) { "Cannot create Flutter path alias: $message" }
            }
            check(java.nio.file.Files.isSameFile(alias.toPath(), rootDir.parentFile.toPath())) {
                "Flutter path alias points at another checkout: $alias"
            }
            windowsSourceAlias = alias.resolve("flutter")
            rootProject.extra["windowsCheckoutAlias"] = alias
        }
        afterEvaluate {
            windowsSourceAlias?.let { source ->
                extensions.getByName("flutter").withGroovyBuilder {
                    setProperty("source", source.absolutePath)
                }
            }
            extensions.configure<com.android.build.gradle.LibraryExtension> {
                compileSdk = 36
                ndkVersion = "27.0.12077973"
            }
        }
    }
    tasks.withType<Test>().configureEach {
        doFirst {
            // Gradle's Windows test-worker classpath also loses non-ASCII
            // characters. Reuse the verified junction, preserving outputs.
            val alias = rootProject.findProperty("windowsCheckoutAlias") as? File
            if (alias != null) {
                fun asciiPath(path: File): File {
                    val base = rootDir.parentFile.toPath()
                    return if (path.toPath().startsWith(base))
                        alias.resolve(base.relativize(path.toPath()).toString()) else path
                }
                classpath = files(classpath.files.map(::asciiPath))
                testClassesDirs = files(testClassesDirs.files.map(::asciiPath))
            }
        }
    }
}
