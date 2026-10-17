import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRateLimiter } from '../src/rate-limit.mjs';

test('allows up to the limit inside one window, then reports when to retry', () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock });
  for (let index = 0; index < 3; index += 1) assert.equal(limiter.hit('key:a', 3, 60_000).allowed, true);
  const blocked = limiter.hit('key:a', 3, 60_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
  clock = 30_000;
  assert.equal(limiter.hit('key:a', 3, 60_000).retryAfterMs, 30_000);
  clock = 60_000;
  assert.equal(limiter.hit('key:a', 3, 60_000).allowed, true);
});

test('keys are independent', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  assert.equal(limiter.hit('ip:1', 1, 1000).allowed, true);
  assert.equal(limiter.hit('ip:1', 1, 1000).allowed, false);
  assert.equal(limiter.hit('ip:2', 1, 1000).allowed, true);
});

test('stale windows are pruned so memory stays bounded', () => {
  let clock = 0;
  const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
  limiter.hit('a', 1, 1000);
  limiter.hit('b', 1, 1000);
  clock = 5000;
  limiter.hit('c', 1, 1000);
  assert.equal(limiter.size(), 1);
});
