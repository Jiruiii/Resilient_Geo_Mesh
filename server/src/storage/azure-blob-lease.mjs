export function createAzureBlobLeaseProvider({ blobClient, container, blobName = 'locks/collector.lock',
  leaseDurationSeconds = 60, renewEveryMs = 25_000,
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval } = {}) {
  if (!blobClient || !['ensureBlob', 'acquireLease', 'renewLease', 'releaseLease']
    .every((method) => typeof blobClient[method] === 'function')) {
    throw new TypeError('blobClient must support Azure Blob leases');
  }
  if (typeof container !== 'string' || !container) throw new TypeError('container is required');
  if (!Number.isSafeInteger(leaseDurationSeconds) || leaseDurationSeconds < 15 || leaseDurationSeconds > 60) {
    throw new RangeError('leaseDurationSeconds must be between 15 and 60');
  }
  if (!Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 || renewEveryMs >= leaseDurationSeconds * 1000) {
    throw new RangeError('renewEveryMs must be shorter than the lease duration');
  }

  return Object.freeze({
    async acquire() {
      await blobClient.ensureBlob(container, blobName);
      let leaseId;
      try {
        leaseId = await blobClient.acquireLease(container, blobName, leaseDurationSeconds);
      } catch (error) {
        if (error.status === 409 || error.status === 412) {
          const held = new Error('collector lease is already held');
          held.code = 'COLLECTOR_LOCK_HELD';
          throw held;
        }
        throw error;
      }
      let lostError;
      let released = false;
      let renewing = false;
      const renew = async () => {
        if (released || renewing || lostError) return;
        renewing = true;
        try {
          await blobClient.renewLease(container, blobName, leaseId);
        } catch (error) {
          lostError = error;
        } finally {
          renewing = false;
        }
      };
      const timer = setIntervalImpl(renew, renewEveryMs);
      timer?.unref?.();
      return Object.freeze({
        async assertHeld() {
          if (lostError) {
            const lost = new Error('collector lease was lost before publication');
            lost.code = 'COLLECTOR_LEASE_LOST';
            throw lost;
          }
        },
        async release() {
          if (released) return;
          released = true;
          clearIntervalImpl(timer);
          try {
            await blobClient.releaseLease(container, blobName, leaseId);
          } catch (error) {
            if (error.status !== 409 && error.status !== 412) throw error;
          }
        },
      });
    },
  });
}
