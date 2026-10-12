import { readFile } from 'node:fs/promises';

import { readPrivateKey, readPublicKey } from '../../../pipeline/lib/crypto.mjs';
import { createAzureRuntimeStorage } from '../storage/azure-runtime.mjs';
import { createGovernmentPool, loadGovernmentPublisherConfig } from './config.mjs';
import { createPostgresGovernmentStore } from './postgres-store.mjs';
import { publishGovernmentOutboxBatch } from './publisher-worker.mjs';

const config = loadGovernmentPublisherConfig(process.env);
const pool = await createGovernmentPool(config);
const store = createPostgresGovernmentStore(pool);
await store.migrate();
const privateKey = readPrivateKey(config.signingPrivateKeyPem ?? await readFile(config.signingPrivateKeyPath));
const publicKey = readPublicKey(config.signingPublicKeyPem ?? await readFile(config.signingPublicKeyPath));
const azureStorage = createAzureRuntimeStorage(config);
const signingKey = { privateKey, publicKey, keyId: config.signingKeyId };
let running = false;
let stopping = false;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    const result = await publishGovernmentOutboxBatch({
      store,
      releaseRoot: config.publicReleaseRoot,
      signingKey,
      releasePointerStore: azureStorage.releasePointerStore,
      lockProvider: azureStorage.collectorLockProvider,
      lockPath: `${config.privateDataRoot}/collector.lock`,
      now: new Date(),
    });
    if (result.published) console.info(`[government-publisher] revision=${result.revision} count=${result.count}`);
  } catch (error) {
    console.error(`[government-publisher] failed code=${error.code ?? 'PUBLISHER_ERROR'}`);
  } finally { running = false; }
}

const timer = setInterval(() => { void tick(); }, config.publishPollMs);
timer.unref();
await tick();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.end();
    process.exit(0);
  });
}
