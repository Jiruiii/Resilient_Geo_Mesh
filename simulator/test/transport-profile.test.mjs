import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScenario } from '../lib/scenario.mjs';
import { runSimulation } from '../lib/engine.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
import { contactBudget, validateTransportProfile } from '../lib/transport-profile.mjs';
const config = JSON.parse(readFileSync(new URL('../fixtures/sim-config.json', import.meta.url)));
const profile = JSON.parse(readFileSync(new URL('../fixtures/wifi-direct-profile.json', import.meta.url)));
test('short contact cannot transmit before setup; reversed pair has the same budget', () => {
  assert.equal(contactBudget(profile, 1, 7, 0, 0, 1), 0);
  assert.equal(contactBudget(profile, 30, 7, 0, 0, 1), contactBudget(profile, 30, 7, 0, 1, 0));
  assert.throws(() => validateTransportProfile({ ...profile, bytes_per_second: -1 }));
  assert.throws(() => validateTransportProfile({ ...profile, setup_ms: [] }));
});
test('opt-in profile is deterministic and limits each paired contact across both directions', () => {
  const scenario = buildScenario();
  const runConfig = { ...config, contact_probability: 1, gateway_ratio: 1, cellular_fallback_rounds: 999 };
  const options = { scenario, config: runConfig, nodeCount: 10, strategy: 'rarest-first', seed: 42, rounds: 3, secondsPerRound: 30, transportProfile: profile };
  const a = runSimulation(options), b = runSimulation(options);
  assert.deepEqual(computeMetrics(a, scenario, runConfig), computeMetrics(b, scenario, runConfig));
  assert.equal(a.params.contact_model.max_peer_count, 1);
  const total = a.nodes.reduce((s, n) => s + n.p2pRxBytes, 0);
  assert.ok(total > 0, 'fixture must actually exercise peer transfers');
  assert.ok(total <= 5 * 3 * (30 - Math.min(...profile.setup_ms) / 1000) * profile.bytes_per_second);
  const short = runSimulation({ ...options, secondsPerRound: 1 });
  assert.equal(short.nodes.reduce((s, n) => s + n.p2pRxBytes, 0), 0);
  assert.equal(runSimulation({ ...options, transportProfile: null }).params.transport_profile, undefined);
});
