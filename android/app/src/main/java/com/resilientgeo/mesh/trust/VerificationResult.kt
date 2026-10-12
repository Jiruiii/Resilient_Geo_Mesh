package com.resilientgeo.mesh.trust

/** Mirrors the `{ valid, stage, errors, expired, current }` shape returned by `verifyEvent()` in contract.mjs. */
sealed class VerificationResult {
    data class Valid(val expired: Boolean) : VerificationResult() {
        val current: Boolean get() = !expired
    }

    data class Invalid(val stage: Stage, val errors: List<String>) : VerificationResult()

    enum class Stage { SCHEMA, TRUST, INTEGRITY, SIGNATURE, CONTRACT }

    val isValid: Boolean get() = this is Valid
}
