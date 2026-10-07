import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cleanupReleases } from '../src/ops/release-cleanup.mjs';

const NOW = new Date('2026-10-02T00:00:00Z');

async function createFixture(root) {
  await mkdir(path.join(root, 'current', 'layers'), { recursive: true });
  await mkdir(path.join(root, 'releases', 'layers', 'taiwan-shelter'), { recursive: true });
  for (let revision = 1; revision <= 12; revision += 1) {
    const createdAt = new Date(NOW.getTime() - (12 - revision) * 5 * 24 * 60 * 60 * 1000).toISOString();
    await mkdir(path.join(root, 'releases', String(revision)), { recursive: true });
    await writeFile(path.join(root, 'releases', String(revision), 'feed.json'), JSON.stringify({
      revision,
      created_at: createdAt,
      datasets: [],
    }));
    await mkdir(path.join(root, 'releases', 'layers', 'taiwan-shelter', String(revision)), { recursive: true });
    await writeFile(path.join(root, 'releases', 'layers', 'taiwan-shelter', String(revision), 'manifest.json'), JSON.stringify({
      dataset_version: revision,
      created_at: createdAt,
    }));
  }
  await writeFile(path.join(root, 'current', 'feed.json'), JSON.stringify({
    revision: 12,
    datasets: [{ chunk_paths: ['releases/12/ncdr/0.json'] }],
  }));
  await symlink('../../releases/layers/taiwan-shelter/12', path.join(root, 'current', 'layers', 'taiwan-shelter'), 'dir');
}

test('release cleanup dry-run and execution preserve current and the wider retention window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-cleanup-'));
  try {
    await createFixture(root);
    const dryRun = await cleanupReleases({
      releaseRoot: root,
      now: NOW,
      keepRevisions: 2,
      keepDays: 30,
      dryRun: true,
    });
    assert.equal(dryRun.dry_run, true);
    assert.ok(dryRun.would_delete.includes(path.join(root, 'releases', '1')));
    assert.equal(await realpath(path.join(root, 'current', 'layers', 'taiwan-shelter')), await realpath(path.join(root, 'releases', 'layers', 'taiwan-shelter', '12')));

    const executed = await cleanupReleases({
      releaseRoot: root,
      now: NOW,
      keepRevisions: 2,
      keepDays: 30,
      dryRun: false,
    });
    assert.ok(executed.deleted.includes(path.join(root, 'releases', '1')));
    await assert.rejects(readFile(path.join(root, 'releases', '1', 'feed.json')));
    assert.equal((await readFile(path.join(root, 'releases', '12', 'feed.json'))).length > 0, true);
    assert.equal((await readFile(path.join(root, 'current', 'feed.json'))).length > 0, true);
    assert.equal(await realpath(path.join(root, 'current', 'layers', 'taiwan-shelter')), await realpath(path.join(root, 'releases', 'layers', 'taiwan-shelter', '12')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release cleanup honors the active release pointer and keeps the current and previous static layer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-pointer-cleanup-'));
  try {
    await mkdir(path.join(root, 'current'), { recursive: true });
    for (let revision = 1; revision <= 5; revision += 1) {
      const createdAt = new Date(NOW.getTime() - (5 - revision) * 24 * 60 * 60 * 1000).toISOString();
      await mkdir(path.join(root, 'releases', String(revision)), { recursive: true });
      await writeFile(path.join(root, 'releases', String(revision), 'feed.json'), JSON.stringify({
        revision,
        created_at: createdAt,
        datasets: [],
      }));
    }
    for (let version = 1; version <= 4; version += 1) {
      await mkdir(path.join(root, 'releases', 'layers', 'taiwan-shelter', String(version)), { recursive: true });
      await writeFile(path.join(root, 'releases', 'layers', 'taiwan-shelter', String(version), 'manifest.json'), JSON.stringify({
        dataset_version: version,
        created_at: new Date(NOW.getTime() - (4 - version) * 24 * 60 * 60 * 1000).toISOString(),
      }));
    }
    const currentV2Hash = 'a'.repeat(64);
    const oldV2Hash = 'b'.repeat(64);
    await mkdir(path.join(root, 'v2', 'manifests'), { recursive: true });
    await mkdir(path.join(root, 'v2', 'chunks'), { recursive: true });
    await writeFile(path.join(root, 'v2', 'manifests', `${currentV2Hash}.json`), JSON.stringify({
      created_at: NOW.toISOString(),
      chunks: [{ path: `v2/chunks/${currentV2Hash}.json` }],
    }));
    await writeFile(path.join(root, 'v2', 'manifests', `${oldV2Hash}.json`), JSON.stringify({
      created_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      chunks: [{ path: `v2/chunks/${oldV2Hash}.json` }],
    }));
    await writeFile(path.join(root, 'v2', 'chunks', `${currentV2Hash}.json`), '{}');
    await writeFile(path.join(root, 'v2', 'chunks', `${oldV2Hash}.json`), '{}');
    await writeFile(path.join(root, 'current', 'release-pointer.json'), JSON.stringify({
      schema_version: 'release-pointer-v1',
      revision: 5,
      feed_path: 'releases/5/feed.json',
      v2_manifest_path: `v2/manifests/${currentV2Hash}.json`,
      layers: { 'taiwan-shelter': 4 },
    }));

    const report = await cleanupReleases({ releaseRoot: root, now: NOW, keepRevisions: 1, keepDays: 2, dryRun: true });
    assert.equal(report.current_revision, 5);
    assert.equal(report.current_layer_versions['taiwan-shelter'], 4);
    assert.equal(report.would_delete.includes(path.join(root, 'releases', 'layers', 'taiwan-shelter', '4')), false);
    assert.equal(report.would_delete.includes(path.join(root, 'releases', 'layers', 'taiwan-shelter', '3')), false);
    assert.equal(report.would_delete.includes(path.join(root, 'releases', 'layers', 'taiwan-shelter', '2')), true);
    assert.equal(report.would_delete.includes(path.join(root, 'v2', 'chunks', `${currentV2Hash}.json`)), false);
    assert.equal(report.would_delete.includes(path.join(root, 'v2', 'chunks', `${oldV2Hash}.json`)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
