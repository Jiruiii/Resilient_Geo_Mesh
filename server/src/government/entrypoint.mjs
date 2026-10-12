import { readFile } from 'node:fs/promises';

import { readPublicKey } from '../../../pipeline/lib/crypto.mjs';
import { buildGovernmentApp } from './app.mjs';
import { createGovernmentPool, loadGovernmentApiConfig } from './config.mjs';
import { createPostgresGovernmentStore } from './postgres-store.mjs';

const config = loadGovernmentApiConfig(process.env);
const pool = await createGovernmentPool(config);
const store = createPostgresGovernmentStore(pool);
await store.migrate();
const publicKey = readPublicKey(config.signingPublicKeyPem ?? await readFile(config.signingPublicKeyPath));
const app = buildGovernmentApp({
  store,
  config: { ...config, trustedKeyIds: [config.signingKeyId], trustedKeys: new Map([[config.signingKeyId, publicKey]]) },
  logger: true,
});

await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
