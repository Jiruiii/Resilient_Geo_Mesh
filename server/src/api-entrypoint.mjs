import { readFile } from 'node:fs/promises';

import { readPublicKey } from '../../pipeline/lib/crypto.mjs';
import { loadApiConfig } from './config.mjs';
import { buildApp } from './app.mjs';
import { createReleaseStore } from './storage/release-store.mjs';
import { createAzureRuntimeStorage } from './storage/azure-runtime.mjs';
import { createFileRescueStore } from './storage/crowd-rescue-store.mjs';

const config = loadApiConfig(process.env);
const publicKeyPem = process.env.SIGNING_PUBLIC_KEY_PEM
  ?? await readFile(config.signingPublicKeyPath);
const publicKey = readPublicKey(publicKeyPem);
const azureStorage = createAzureRuntimeStorage(config);
const releaseStore = createReleaseStore({
  releaseRoot: config.publicReleaseRoot,
  releasePointerStore: azureStorage.releasePointerStore,
});
const rescueStore = azureStorage.rescueStore
  ?? (config.crowdDataRoot ? createFileRescueStore({ root: config.crowdDataRoot }) : null);
const app = buildApp({
  config: { ...config, signingPublicKey: publicKey },
  releaseStore,
  rescueStore,
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
