import { randomUUID } from 'node:crypto';

import { hashGovernmentPassword, normalizeGovernmentAccount, validateGovernmentPassword } from './auth-service.mjs';
import { createGovernmentPool, loadGovernmentApiConfig } from './config.mjs';
import { createPostgresGovernmentStore } from './postgres-store.mjs';

const config = loadGovernmentApiConfig(process.env);
const account = normalizeGovernmentAccount(process.env.GOV_ADMIN_ACCOUNT);
const displayName = process.env.GOV_ADMIN_NAME?.trim();
const agency = process.env.GOV_ADMIN_AGENCY?.trim();
const password = process.env.GOV_ADMIN_PASSWORD;
if (!account || !displayName || !agency || !password) {
  throw new Error('Set GOV_ADMIN_ACCOUNT, GOV_ADMIN_NAME, GOV_ADMIN_AGENCY and GOV_ADMIN_PASSWORD');
}
try {
  validateGovernmentPassword(password);
} catch {
  throw new Error('GOV_ADMIN_PASSWORD must contain at least 12 characters');
}

const pool = await createGovernmentPool(config);
try {
  const store = createPostgresGovernmentStore(pool);
  await store.migrate();
  const user = await store.bootstrapSystemAdmin({
    id: randomUUID(), account, displayName, agency, passwordHash: await hashGovernmentPassword(password), now: new Date(),
  });
  console.info(`[government-bootstrap] system administrator created id=${user.id} account=${user.account}`);
} finally { await pool.end(); }
