package com.resilientgeo.mesh.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.resilientgeo.mesh.protocol.LayerBundleVerifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** A clean install must not expose an old or unverified packaged static layer. */
@RunWith(AndroidJUnit4::class)
class StaticLayerInstrumentedTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun cleanInstallDoesNotShowPackagedStaticLayersBeforeSignedDownload() = runBlocking {
        // Static layers now arrive as signed server releases. Remove any local
        // state first so this test represents a fresh installation and cannot
        // pass because a previous run populated the private cache.
        File(context.noBackupFilesDir, "verified-layers").deleteRecursively()
        File(context.filesDir, "static-layer-bundles").deleteRecursively()

        val features = MeshRepository(context).verifiedStaticFeatures(serverBaseUrl = null)

        assertTrue(
            "a clean install must wait for a signed static-layer download; got ${features.size} features",
            features.isEmpty(),
        )
        assertTrue(
            "no verified-layer cache should be created before a signed bundle is accepted",
            File(context.noBackupFilesDir, "verified-layers").listFiles().orEmpty().isEmpty(),
        )
    }

    @Test
    fun signedNationwideLayersDownloadAndRemainUsableAfterUpdateFailure() = runBlocking {
        val serverUrl = InstrumentationRegistry.getArguments().getString("government_url")
        assumeTrue("Opt-in signed-layer API validation", !serverUrl.isNullOrBlank())

        File(context.noBackupFilesDir, "verified-layers").deleteRecursively()
        File(context.filesDir, "static-layer-bundles").deleteRecursively()

        val downloaded = MeshRepository(context).verifiedStaticFeatures(serverUrl)
        val shelters = downloaded.filter { it["kind"] == "shelter" }
        val medical = downloaded.filter { it["kind"] == "medical" }
        val directory = downloaded.filter { it["kind"] == "medical-directory" }
        assertTrue("expected the nationwide shelter layer, got ${shelters.size}", shelters.size > 5_000)
        assertTrue("expected verified medical map points, got ${medical.size}", medical.isNotEmpty())
        assertTrue("expected the medical search directory, got ${directory.size}", directory.size > 20_000)
        assertTrue(directory.any { it["geometry"] == null })
        assertTrue(directory.any { it["geometry"] is Map<*, *> })

        val trustText = context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() }
        val trust = TrustedKeyStore.fromJson(trustText)
        val cache = StaticLayerBundleCache(File(context.filesDir, "static-layer-bundles"))
        for (layerId in listOf("taiwan-shelter", "taiwan-medical", "taiwan-medical-directory")) {
            val bundle = cache.read(layerId)
            assertNotNull("downloaded bundle missing from app-private cache: $layerId", bundle)
            val verification = LayerBundleVerifier.verifyJsonChunks(
                JSONObject(requireNotNull(bundle).manifest),
                bundle.chunks,
                trust,
            ) { }
            assertTrue("cached $layerId bundle failed verification: ${verification.errors}", verification.valid)
        }

        // A failed update must continue from the complete signed cache without
        // inventing geometry for unresolved directory records.
        val offline = MeshRepository(context).verifiedStaticFeatures("http://127.0.0.1:1/")
        assertEquals(downloaded.map { it["id"] }, offline.map { it["id"] })
        assertTrue(offline.filter { it["kind"] == "medical-directory" }
            .any { it["geometry"] == null })
    }
}
