import { getSourceDefinition } from '../source-registry.mjs';

export function createScheduler({ registry, run, clock = globalThis, onError } = {}) {
  if (!Array.isArray(registry) || typeof run !== 'function') throw new TypeError('registry and run are required');
  const definitions = registry.map((source) => ({
    ...source,
    scheduleMs: source.scheduleMs,
  }));
  const timerIds = [];
  const pending = new Map();
  const running = new Set();
  let drainPromise = null;
  let started = false;

  function request(sourceId) {
    if (running.has(sourceId)) return Promise.resolve({ skipped: true, sourceId });
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const waiters = pending.get(sourceId) ?? [];
    waiters.push({ resolve: resolveRequest, reject: rejectRequest });
    pending.set(sourceId, waiters);
    void drain();
    return promise;
  }

  async function drain() {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (pending.size > 0) {
        const batch = [...pending.entries()];
        pending.clear();
        const sourceIds = batch.map(([sourceId]) => sourceId).filter((sourceId) => !running.has(sourceId));
        if (sourceIds.length === 0) continue;
        sourceIds.forEach((sourceId) => running.add(sourceId));
        try {
          const result = await run({ sourceIds });
          batch.forEach(([sourceId, waiters]) => {
            if (!sourceIds.includes(sourceId)) return;
            waiters.forEach(({ resolve }) => resolve(result));
          });
        } catch (error) {
          batch.forEach(([sourceId, waiters]) => {
            if (!sourceIds.includes(sourceId)) return;
            waiters.forEach(({ reject }) => reject(error));
          });
        } finally {
          sourceIds.forEach((sourceId) => running.delete(sourceId));
        }
      }
    })().finally(() => {
      drainPromise = null;
      if (pending.size > 0) void drain();
    });
    return drainPromise;
  }

  function resolvePendingAsStopped() {
    for (const waiters of pending.values()) {
      waiters.forEach(({ resolve }) => resolve({ skipped: true, reason: 'stopped' }));
    }
    pending.clear();
  }

  function schedule(sourceId) {
    const promise = request(sourceId);
    promise.catch((error) => {
      if (typeof onError === 'function') onError(error, sourceId);
    });
    return promise;
  }

  return {
    start() {
      if (started) return;
      started = true;
      for (const source of definitions) {
        timerIds.push(clock.setInterval(() => schedule(source.sourceId), source.scheduleMs));
      }
    },
    stop() {
      while (timerIds.length > 0) clock.clearInterval(timerIds.pop());
      resolvePendingAsStopped();
      started = false;
    },
    runNow(sourceId) {
      if (!definitions.some((source) => source.sourceId === sourceId)) {
        getSourceDefinition(sourceId);
      }
      return request(sourceId);
    },
  };
}
