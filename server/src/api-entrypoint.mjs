import { readFile } from 'node:fs/promises';

import { readPublicKey } from '../../pipeline/lib/crypto.mjs';
import { loadApiConfig } from './config.mjs';
import { buildApp } from './app.mjs';
import { createReleaseStore } from './storage/release-store.mjs';
import { createAzureRuntimeStorage } from './storage/azure-runtime.mjs';

const config = loadApiConfig(process.env);
const publicKeyPem = process.env.SIGNING_PUBLIC_KEY_PEM
  ?? await readFile(config.signingPublicKeyPath);
const publicKey = readPublicKey(publicKeyPem);
const azureStorage = createAzureRuntimeStorage(config);
const releaseStore = createReleaseStore({
  releaseRoot: config.publicReleaseRoot,
  releasePointerStore: azureStorage.releasePointerStore,
});
const app = buildApp({
  config: { ...config, signingPublicKey: publicKey },
  releaseStore,
  sourceStateStore: {
    async list() {
      try {
        return await releaseStore.readSourceStatus();
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  },
});

await app.listen({ host: config.host, port: config.port });
