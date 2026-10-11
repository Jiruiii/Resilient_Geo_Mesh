plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

val launcherIconResDir = layout.buildDirectory.dir("generated/res/launcher/main")
android {
    namespace = "com.resilientgeo.mesh"
    // MapLibre GL 0.27.1 and its Android dependencies require API 36.
    // targetSdk remains independently controlled for runtime behavior.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.resilientgeo.mesh"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        getByName("debug") {
            // Install an isolated hardware-test app when a phone's existing APK
            // was signed on another workstation. The normal app ID is unchanged.
            applicationIdSuffix = providers.gradleProperty("meshTestApplicationIdSuffix").orNull
        }
        create("profile") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Required by Nearby 19.4, independently of the app's minSdk.
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    buildFeatures {
        // Views + ViewBinding for the native support screens (module B). Compose
        // was dropped: the only place it was used was the placeholder
        // "Hello Android" MainActivity this replaces — BleSpikeActivity
        // (module C's Stage 0 spike) was always a plain ComponentActivity
        // with no Compose UI. Re-add compose = true and the Compose BOM
        // dependencies if a future screen genuinely wants Compose.
        viewBinding = true
    }

    packaging {
        resources.excludes +=
            "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
    }

    androidResources {
        // PMTiles tile payloads and the graph are already compressed. Zip
        // recompression wastes heap/CPU and prevents efficient asset copying.
        noCompress += listOf("pmtiles", "rgmz", "gz")
    }

    sourceSets["main"].res.srcDir(launcherIconResDir)

    testOptions {
        unitTests {
            // These JVM tests read fixtures directly and do not use Robolectric.
            // Packaging the entire 450 MB map into a second test APK caused OOMs.
            isIncludeAndroidResources = false
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation(project(":flutter"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.material)
    implementation(libs.androidx.recyclerview)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.kotlinx.coroutines.android)

    // Nearby is optional at runtime; native transports remain available without GMS.
    implementation(libs.play.services.nearby)
    implementation(libs.kotlinx.coroutines.play.services)

    // Local database (module B): events, versions, expiry.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // Ed25519 verification adapter (module B): Android's own java.security
    // provider only gained EdDSA support in API 33, so the trust adapter
    // uses Bouncy Castle directly instead of relying on the platform
    // provider (see android/README.md).
    implementation(libs.bouncycastle.bcprov)

    testImplementation(libs.junit)
    // The stub org.json shipped in android.jar throws on every call under
    // plain JUnit; pull in the real implementation for the trust-adapter
    // and apply-rule unit tests, which don't need a device.
    testImplementation(libs.json.org)
    // runTest/virtual time for AutoPeerSyncEngineTest, which drives two
    // in-memory engines through connect/HELLO/REQUEST/TRANSFER timeouts
    // without a real device or real wall-clock waits.
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.room.testing)
}

val copyLauncherLightLogo = tasks.register<Copy>("copyLauncherLightLogo") {
    from(project.file("../../flutter/assets/Geo_light_square_logo.png"))
    into(launcherIconResDir.map { it.dir("drawable-nodpi") })
    rename { "app_icon.png" }
}

val copyLauncherDarkLogo = tasks.register<Copy>("copyLauncherDarkLogo") {
    from(project.file("../../flutter/assets/Geo_dark_square_logo.png"))
    into(launcherIconResDir.map { it.dir("drawable-night-nodpi") })
    rename { "app_icon.png" }
}

tasks.named("preBuild").configure {
    dependsOn(copyLauncherLightLogo, copyLauncherDarkLogo)
}
