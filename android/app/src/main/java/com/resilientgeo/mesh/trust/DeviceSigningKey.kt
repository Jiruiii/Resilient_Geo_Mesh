package com.resilientgeo.mesh.trust

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory
import org.bouncycastle.util.encoders.Base64
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * This device's own Ed25519 key for signing crowd reports.
 *
 * Only [publicKeySpkiBase64], [keyId] and [sign] are exposed; there is
 * deliberately no accessor for the private key, and [toString] never prints
 * it, so it cannot leak into logs, bridge replies, HELLO or events.
 *
 * Android Keystore only supports Ed25519 from API 33 while minSdk is 26, so the
 * key is generated with Bouncy Castle and its 32-byte seed is stored encrypted
 * under a Keystore AES-GCM key ([KeystoreWrappedStorage]).
 */
class DeviceSigningKey internal constructor(private val privateKey: Ed25519PrivateKeyParameters) {

    private val spkiDer: ByteArray =
        SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(privateKey.generatePublicKey()).encoded

    fun publicKeySpkiBase64(): String = Base64.toBase64String(spkiDer)

    fun keyId(): String = DeviceKeys.keyIdFromSpkiDer(spkiDer)

    /** Base64 Ed25519 signature over [message]. */
    fun sign(message: ByteArray): String {
        val signer = Ed25519Signer()
        signer.init(true, privateKey)
        signer.update(message, 0, message.size)
        return Base64.toBase64String(signer.generateSignature())
    }

    fun signCanonical(canonicalJson: String): String = sign(canonicalJson.toByteArray(StandardCharsets.UTF_8))

    override fun toString(): String = "DeviceSigningKey(${keyId()})"

    /** Where the encrypted seed lives; swapped for an in-memory store in JVM tests. */
    interface Storage {
        fun read(): ByteArray?
        fun write(seed: ByteArray)
    }

    companion object {
        private const val SEED_BYTES = 32

        fun loadOrCreate(storage: Storage, random: SecureRandom = SecureRandom()): DeviceSigningKey {
            val stored = storage.read()
            if (stored != null && stored.size == SEED_BYTES) {
                return DeviceSigningKey(Ed25519PrivateKeyParameters(stored, 0))
            }
            val generated = Ed25519PrivateKeyParameters(random)
            storage.write(generated.encoded)
            return DeviceSigningKey(generated)
        }

        /** Deterministic key for fixture parity tests only. */
        internal fun fromSeed(seed: ByteArray): DeviceSigningKey {
            require(seed.size == SEED_BYTES) { "seed must be $SEED_BYTES bytes" }
            return DeviceSigningKey(Ed25519PrivateKeyParameters(seed, 0))
        }
    }
}

/**
 * Keeps the device key's seed in app-private storage, encrypted with an
 * AES-256-GCM key that never leaves Android Keystore. File layout:
 * 12-byte IV followed by the GCM ciphertext.
 */
class KeystoreWrappedStorage(
    context: Context,
    directoryName: String = "device-key",
    private val keyAlias: String = "resilientgeo-device-key-wrap",
    storageRoot: File = context.applicationContext.noBackupFilesDir,
) : DeviceSigningKey.Storage {
    private val file = File(storageRoot, "$directoryName/ed25519.seed")

    override fun read(): ByteArray? {
        if (!file.isFile) return null
        val bytes = file.readBytes()
        if (bytes.size <= IV_BYTES) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
        return cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)
    }

    override fun write(seed: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val encrypted = cipher.iv + cipher.doFinal(seed)
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeBytes(encrypted)
        if (!temp.renameTo(file)) {
            temp.delete()
            throw IllegalStateException("could not persist device key")
        }
    }

    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
