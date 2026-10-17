#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildScenario } from './lib/scenario.mjs';
import { runSimulation } from './lib/engine.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { runMatrix, runKey } from './lib/matrix.mjs';
import { canonicalRun, matrixSummary, renderReport } from './lib/report.mjs';
import { STRATEGY_NAMES } from './lib/strategies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'fixtures', 'sim-config.json');
const DEFAULT_RESULTS_DIR = path.join(HERE, '..', 'experiments', 'results');
const DEFAULT_SEED = 20260904;

const BOOLEAN_FLAGS = new Set(['geo_filter', 'waves', 'allow_any', 'check']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2).replaceAll('-', '_');
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
    } else {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${item.slice(2)}`);
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function gitRev() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE }).toString().trim();
  } catch {
    return null;
  }
}

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requireInt(options, name, fallback) {
  const raw = options[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name.replaceAll('_', '-')} must be an integer`);
  return value;
}

async function runCommand(options) {
  const config = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : await loadConfig();
  const transportProfile = options.transport_profile ? JSON.parse(await readFile(options.transport_profile, 'utf8')) : null;
  const nodeCount = requireInt(options, 'nodes');
  if (!options.allow_any && !config.node_counts.includes(nodeCount)) {
    throw new Error(`--nodes must be one of ${config.node_counts.join(', ')} (or pass --allow-any)`);
  }
  const strategy = options.strategy ?? 'rarest-first';
  if (!STRATEGY_NAMES.includes(strategy)) {
    throw new Error(`--strategy must be one of ${STRATEGY_NAMES.join(', ')}`);
  }
  const seed = requireInt(options, 'seed', DEFAULT_SEED);
  const geoFilter = Boolean(options.geo_filter);
  const rarityScope = options.rarity_scope ?? config.rarity_scope ?? 'global';
  const rounds = options.rounds ? requireInt(options, 'rounds') : config.rounds;
  const secondsPerRound = options.seconds_per_round ? requireInt(options, 'seconds_per_round') : config.seconds_per_round;

  const scenario = buildScenario();
  const run = runSimulation({
    scenario,
    config,
    nodeCount,
    strategy,
    seed,
    geoFilter,
    rounds,
    secondsPerRound,
    rarityScope,
    transportProfile,
  });
  const metrics = computeMetrics(run, scenario, config);
  const record = { key: runKey(nodeCount, strategy, geoFilter), git_rev: gitRev(), ...metrics };

  const outDir = options.out ? path.resolve(options.out) : path.join(HERE, '..', '.sim-out');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${record.key}.json`);
  await writeJson(outPath, record);

  console.log(
    JSON.stringify(
      {
        out: outPath,
        coverage_final: metrics.coverage.final,
        coverage_relevant_final: metrics.coverage.relevant_final,
        cellular_savings: metrics.cellular.savings,
        cellular_total_vs_full: metrics.cellular.total_vs_full,
        transfer_efficiency: metrics.transfer.efficiency,
        freshness_p50_seconds: metrics.freshness.p50_seconds,
      },
      null,
      2,
    ),
  );
}

async function matrixCommand(options) {
  if (options.transport_profile || options.config) throw new Error('Custom profiles/configs use the run command; the committed matrix is the legacy baseline.');
  const config = await loadConfig();
  const seed = requireInt(options, 'seed', DEFAULT_SEED);
  const geoFilterMode = options.geo ?? 'both';
  if (!['both', 'on', 'off'].includes(geoFilterMode)) throw new Error('--geo must be both, on or off');
  const rarityScope = options.rarity_scope ?? config.rarity_scope ?? 'global';
  const outDir = options.out ? path.resolve(options.out) : DEFAULT_RESULTS_DIR;

  const scenario = buildScenario();
  const results = runMatrix({ scenario, config, seed, geoFilterMode, rarityScope });

  if (options.check) {
    const mismatches = [];
    for (const result of results) {
      const filePath = path.join(outDir, `${result.key}.json`);
      let committed;
      try {
        committed = JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        mismatches.push(`${result.key}: no committed result at ${path.relative(process.cwd(), filePath)}`);
        continue;
      }
      if (canonicalRun(committed) !== canonicalRun(result)) {
        mismatches.push(`${result.key}: differs from committed result`);
      }
    }
    if (mismatches.length > 0) {
      for (const line of mismatches) console.error(`MISMATCH: ${line}`);
      console.error('Re-run `node simulator/cli.mjs matrix --out experiments/results` and commit.');
      process.exitCode = 1;
      return;
    }
    console.log('PASS: committed experiment results match a fresh deterministic run');
    return;
  }

  await mkdir(outDir, { recursive: true });
  const rev = gitRev();
  for (const result of results) {
    await writeJson(path.join(outDir, `${result.key}.json`), { git_rev: rev, ...result });
  }
  await writeJson(path.join(outDir, 'matrix-summary.json'), matrixSummary(results, scenario, config));
  const reportPath = path.join(outDir, 'report.md');
  await writeFile(reportPath, renderReport(results, scenario, config), 'utf8');

  // prune stale result files from a previous, larger grid
  const expected = new Set([
    ...results.map((r) => `${r.key}.json`),
    'matrix-summary.json',
    'report.md',
  ]);
  for (const name of await readdir(outDir)) {
    if (name.endsWith('.json') && !expected.has(name)) {
      console.warn(`note: ${name} is not part of the current grid`);
    }
  }

  console.log(JSON.stringify({ out: outDir, runs: results.length, report: reportPath }, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node simulator/cli.mjs run --nodes N --strategy S --seed K [--geo-filter] [--config FILE] [--transport-profile FILE]
       [--out DIR] [--rounds R] [--seconds-per-round SEC]
       [--rarity-scope global|neighbourhood] [--allow-any]
  node simulator/cli.mjs matrix [--seed K] [--out experiments/results]
       [--geo both|on|off] [--check]

Strategies: ${STRATEGY_NAMES.join(', ')}
`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'run') return runCommand(options);
  if (command === 'matrix') return matrixCommand(options);
  printHelp();
  if (command) throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});
