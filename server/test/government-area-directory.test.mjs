import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadGovernmentAreaDirectory } from '../src/government/area-directory.mjs';

test('government API loads the canonical county and town ID directory beside AREA_CATALOG_PATH', async () => {
  const directory = await loadGovernmentAreaDirectory(path.resolve('..', 'data', 'area-catalog.json'));
  assert.equal(directory.size, 390);
  assert.equal(directory.get('tw.63000').level, 'county');
  assert.equal(directory.get('tw.63000050').parent_area_id, 'tw.63000');
});

test('government API refuses to start when the area directory is missing or invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-area-directory-'));
  try {
    await assert.rejects(loadGovernmentAreaDirectory(path.join(root, 'area-catalog.json')), /administrative area directory/u);
    await writeFile(path.join(root, 'administrative-area-directory.json'), '{invalid');
    await assert.rejects(loadGovernmentAreaDirectory(path.join(root, 'area-catalog.json')), /administrative area directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
