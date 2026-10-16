import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = await readFile(path.join(ROOT, 'flutter/web/locator_siren.js'), 'utf8').catch(() => '');

function fakeAudio({ resumeState = 'running', decodeFails = false } = {}) {
  const log = [];
  class FakeContext {
    constructor() { this.state = 'suspended'; this.destination = {}; log.push('new'); }
    resume() { log.push('resume'); this.state = resumeState; return Promise.resolve(); }
    decodeAudioData() { return decodeFails ? Promise.reject(new Error('bad')) : Promise.resolve({ duration: 3.3 }); }
    createBufferSource() {
      const source = { loop: false, connect() {}, disconnect() {}, start() { log.push('start'); }, stop() { log.push('stop'); } };
      return source;
    }
  }
  return { FakeContext, log };
}

function browser({ AudioContext, timers = [], hidden = false } = {}) {
  const listeners = {};
  const context = vm.createContext({
    AudioContext,
    console,
    URL,
    location: { href: 'https://map.example.test/' },
    document: { baseURI: 'https://map.example.test/', hidden, addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    Date,
    globalThis: undefined,
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(script, context);
  return { context, listeners };
}

const call = async (context, name) => {
  const envelope = JSON.parse(await context[name]());
  assert.equal(envelope.ok, true, envelope.error);
  return envelope.value;
};

test('plays after a user gesture, stops, and auto-stops after 60 seconds', async () => {
  const { FakeContext, log } = fakeAudio();
  const timers = [];
  const { context } = browser({ AudioContext: FakeContext, timers });
  const statuses = [];
  context.locatorSirenSetListener((status) => statuses.push(JSON.parse(status).phase));
  const started = await call(context, 'locatorSirenStart');
  assert.equal(started.phase, 'PLAYING');
  assert.deepEqual(log.slice(0, 2), ['new', 'resume']);
  assert.ok(log.includes('start'));
  assert.equal(timers.at(-1).ms, 60_000);
  timers.at(-1).fn();
  assert.equal((await call(context, 'locatorSirenStatus')).phase, 'AUTO_STOPPED');
  assert.deepEqual(statuses, ['STARTING', 'PLAYING', 'AUTO_STOPPED']);
  await call(context, 'locatorSirenStart');
  assert.equal((await call(context, 'locatorSirenStop')).phase, 'IDLE');
});

test('a browser that refuses audio reports failure, never playing', async () => {
  const { FakeContext } = fakeAudio({ resumeState: 'suspended' });
  const { context } = browser({ AudioContext: FakeContext });
  const status = await call(context, 'locatorSirenStart');
  assert.equal(status.phase, 'FAILED');
  assert.equal(status.reason, 'browser_blocked');
});

test('decode errors and missing Web Audio are explicit failures', async () => {
  const broken = fakeAudio({ decodeFails: true });
  assert.equal((await call(browser({ AudioContext: broken.FakeContext }).context, 'locatorSirenStart')).reason, 'audio_init_failed');
  assert.equal((await call(browser({ AudioContext: undefined }).context, 'locatorSirenStart')).reason, 'unsupported');
});

test('a hidden page is flagged while playing, not silently trusted', async () => {
  const { FakeContext } = fakeAudio();
  const { context, listeners } = browser({ AudioContext: FakeContext });
  await call(context, 'locatorSirenStart');
  context.document.hidden = true;
  listeners.visibilitychange();
  assert.deepEqual((await call(context, 'locatorSirenStatus')).warnings, ['page_hidden']);
});
