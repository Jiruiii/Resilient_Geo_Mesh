/**
 * Fixed-window counters kept in this process only. With Azure Container Apps
 * maxReplicas = 2 the effective limit is at most twice the configured value;
 * docs/central-server-runbook.md records that trade-off.
 */
export function createRateLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const windows = new Map();

  function prune(at) {
    for (const [key, window] of windows) {
      if (at - window.start >= window.windowMs) windows.delete(key);
    }
  }

  return Object.freeze({
    hit(key, limit, windowMs) {
      const at = now();
      let window = windows.get(key);
      if (!window || at - window.start >= windowMs) {
        window = { start: at, count: 0, windowMs };
        windows.set(key, window);
        if (windows.size > maxKeys) prune(at);
      }
      if (window.count >= limit) return { allowed: false, retryAfterMs: window.start + windowMs - at };
      window.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    size() {
      return windows.size;
    },
  });
}
