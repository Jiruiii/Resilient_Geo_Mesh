import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('government outbox publisher is separate from central source collection', async () => {
  const scripts = packageJson.scripts ?? {};
  assert.equal(scripts['collector:start'], 'node server/src/collector-entrypoint.mjs');
  assert.equal(scripts['government:api'], 'node server/src/government/entrypoint.mjs');
  assert.equal(scripts['government:publisher'], 'node server/src/government/publisher-entrypoint.mjs');
  assert.equal(scripts['government:bootstrap-admin'], 'node server/src/government/bootstrap-admin.mjs');
  assert.equal(scripts['government:collection'], undefined);
  await assert.rejects(access(new URL('../../pipeline/government-publisher.mjs', import.meta.url)));
  await assert.rejects(access(new URL('../../pipeline/government-collector-worker.mjs', import.meta.url)));
  await assert.rejects(access(new URL('../../pipeline/deploy-government.mjs', import.meta.url)));
  await assert.rejects(access(new URL('../../pipeline/serve-government.mjs', import.meta.url)));
});

test('government online documentation no longer points to the retired publisher or worker', async () => {
  const documentation = await readFile(new URL('../../docs/government-online-sync.md', import.meta.url), 'utf8');
  assert.equal(documentation.includes('government-publisher.mjs'), false);
  assert.equal(documentation.includes('government-collector-worker.mjs'), false);
  assert.match(documentation, /collector:start/u);
  assert.match(documentation, /server:health/u);
});
