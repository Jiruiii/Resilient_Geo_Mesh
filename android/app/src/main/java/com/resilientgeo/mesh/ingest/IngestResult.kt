package com.resilientgeo.mesh.ingest

import com.resilientgeo.mesh.trust.VerificationResult

/** Mirrors the `{ result, reason, ... }` shape `ingestEvent()` returns in contract.mjs. */
sealed class IngestResult {
    data class Inserted(val insertedIntoSeparateNamespace: Boolean, val state: ApplyState) : IngestResult()
    data class Updated(val fromVersion: Int, val toVersion: Int, val state: ApplyState) : IngestResult()
    data class RejectedVersionRollback(val storedVersion: Int, val incomingVersion: Int) : IngestResult()
    data class RejectedSameVersionConflict(val storedVersion: Int, val incomingVersion: Int) : IngestResult()
    data class RejectedVerification(val stage: VerificationResult.Stage, val errors: List<String>) : IngestResult()

    /** Rejected by the crowd update rules: signer_mismatch or a rescue lifecycle code. */
    data class RejectedTransition(val reason: String) : IngestResult()
}
