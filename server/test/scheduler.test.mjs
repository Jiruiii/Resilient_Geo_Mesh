import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../src/collector/scheduler.mjs';

test('scheduler registers source-specific intervals and clears them on stop', async () => {
  const timers = new Map();
  const cleared = [];
  const calls = [];
  let nextTimer = 0;
  const clock = {
    setInterval(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
      timers.delete(id);
    },
  };
  const registry = [
    { sourceId: 'tdx-road-events', scheduleMs: 900000 },
    { sourceId: 'cwa-earthquake', scheduleMs: 600000 },
  ];
  const scheduler = createScheduler({
    registry,
    clock,
    run: async ({ sourceIds }) => { calls.push(sourceIds[0]); },
  });

  scheduler.start();
  assert.deepEqual([...timers.values()].map(({ delay }) => delay).sort((a, b) => a - b), [600000, 900000]);
  await scheduler.runNow('tdx-road-events');
  assert.deepEqual(calls, ['tdx-road-events']);
  scheduler.stop();
  assert.equal(cleared.length, 2);
  assert.equal(timers.size, 0);
});

test('scheduler skips an overlapping run for the same source', async () => {
  const timers = [];
  let resolveRun;
  const pending = new Promise((resolve) => { resolveRun = resolve; });
  let count = 0;
  const scheduler = createScheduler({
    registry: [{ sourceId: 'ncdr-hazard-events', scheduleMs: 600000 }],
    clock: {
      setInterval(fn) { timers.push(fn); return timers.length; },
      clearInterval() {},
    },
    run: async () => { count += 1; await pending; },
  });
  scheduler.start();
  const first = timers[0]();
  const second = timers[0]();
  await Promise.resolve();
  assert.equal(count, 1);
  resolveRun();
  await Promise.all([first, second]);
  scheduler.stop();
});

test('scheduler queues different sources instead of dropping timers that fire together', async () => {
  const timers = [];
  let resolveFirst;
  const firstRun = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = [];
  const scheduler = createScheduler({
    registry: [
      { sourceId: 'cwa-earthquake', scheduleMs: 600000 },
      { sourceId: 'cwa-weather-warning', scheduleMs: 600000 },
    ],
    clock: {
      setInterval(fn) { timers.push(fn); return timers.length; },
      clearInterval() {},
    },
    run: async ({ sourceIds }) => {
      calls.push(sourceIds);
      if (calls.length === 1) await firstRun;
      return { sourceIds };
    },
  });

  scheduler.start();
  const first = timers[0]();
  const second = timers[1]();
  await Promise.resolve();
  assert.deepEqual(calls, [['cwa-earthquake']]);

  resolveFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [['cwa-earthquake'], ['cwa-weather-warning']]);
  scheduler.stop();
});
