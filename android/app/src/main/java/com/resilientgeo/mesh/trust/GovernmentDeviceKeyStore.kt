package com.resilientgeo.mesh.trust

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** Separate Android Keystore wrapped signing identity for official warnings. */
class GovernmentDeviceKeyStore(
    context: Context,
    directoryName: String = "government-device-key",
    keyAlias: String = "resilientgeo-government-device-key-wrap",
    storageRoot: File = context.applicationContext.noBackupFilesDir,
) {
    private val appContext = context.applicationContext
    private val keyStorage = KeystoreWrappedStorage(
        appContext,
        directoryName = directoryName,
        keyAlias = keyAlias,
        storageRoot = storageRoot,
    )
    private val certificateFile = File(storageRoot, "$directoryName/certificate.json")

    fun loadOrCreateSigningKey(): DeviceSigningKey = DeviceSigningKey.loadOrCreate(keyStorage)

    fun readCertificate(): JSONObject? = runCatching {
        if (!certificateFile.isFile) null else JSONObject(certificateFile.readText(Charsets.UTF_8))
    }.getOrNull()

    fun storeCertificate(certificate: JSONObject) {
        certificateFile.parentFile?.mkdirs()
        val temporary = File(certificateFile.parentFile, "${certificateFile.name}.tmp")
        try {
            FileOutputStream(temporary).use { output ->
                output.write(certificate.toString().toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            if (!temporary.renameTo(certificateFile)) {
                temporary.delete()
                throw IllegalStateException("could not persist government device certificate")
            }
        } finally {
            temporary.delete()
        }
    }

    fun clearCertificate() {
        certificateFile.delete()
    }
}
