import { buildGovernmentApp } from './app.mjs';
import { createGovernmentPool, loadGovernmentApiConfig } from './config.mjs';
import { createPostgresGovernmentStore } from './postgres-store.mjs';

const config = loadGovernmentApiConfig(process.env);
const pool = await createGovernmentPool(config);
const store = createPostgresGovernmentStore(pool);
await store.migrate();
const app = buildGovernmentApp({ store, config, logger: true });

await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
