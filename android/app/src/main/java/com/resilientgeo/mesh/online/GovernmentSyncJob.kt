package com.resilientgeo.mesh.online

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import kotlinx.coroutines.*

/** Android schedules connected background checks; execution time is OS controlled. */
class GovernmentSyncJob : JobService() {
    private var work: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    override fun onStartJob(params: JobParameters): Boolean {
        work = scope.launch {
            val uploadOnly = params.jobId == UPLOAD_ID
            var retry = false
            try {
                val manager = GovernmentSyncManager.get(applicationContext)
                val uploadRetry = manager.flushPendingGovernmentWarnings()
                if (uploadOnly) {
                    retry = uploadRetry
                } else {
                    manager.sync(automatic = true)
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                retry = uploadOnly
            } finally {
                if (isActive) jobFinished(params, retry)
            }
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean { work?.cancel(); return true }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    companion object {
        private const val ID = 7104
        private const val UPLOAD_ID = 7105
        fun schedule(context: Context, enabled: Boolean) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (!enabled) { scheduler.cancel(ID); return }
            scheduler.schedule(JobInfo.Builder(ID, ComponentName(context, GovernmentSyncJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15 * 60_000L)
                .setPersisted(true).build())
        }

        /** Schedules an independent upload attempt, even when feed downloads are disabled. */
        fun schedulePendingUpload(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            scheduler.schedule(
                JobInfo.Builder(UPLOAD_ID, ComponentName(context, GovernmentSyncJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .setPersisted(true)
                    .build(),
            )
        }
    }
}
