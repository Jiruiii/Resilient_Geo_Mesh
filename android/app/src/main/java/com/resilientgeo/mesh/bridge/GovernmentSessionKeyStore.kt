package com.resilientgeo.mesh.bridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores the government bearer token encrypted by a non-exportable Android Keystore key. */
class GovernmentSessionKeyStore(context: Context) {
    private val file = File(context.applicationContext.noBackupFilesDir, "government/session-token.bin")

    @Synchronized
    fun read(): String? {
        if (!file.isFile) return null
        val encrypted = file.readBytes()
        if (encrypted.size <= IV_BYTES) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, encrypted, 0, IV_BYTES))
        return cipher.doFinal(encrypted, IV_BYTES, encrypted.size - IV_BYTES).toString(Charsets.UTF_8)
    }

    @Synchronized
    fun write(token: String) {
        require(token.length in 40..128) { "session token is invalid" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeBytes(encrypted)
        if (!temporary.renameTo(file)) {
            temporary.delete()
            throw IllegalStateException("could not persist government session")
        }
    }

    @Synchronized
    fun clear() {
        if (file.exists() && !file.delete()) throw IllegalStateException("could not clear government session")
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "resilientgeo-government-session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
