import { createAzureBlobLeaseProvider } from './azure-blob-lease.mjs';
import { createAzureBlobClient, createManagedIdentityTokenProvider } from './azure-blob-rest.mjs';
import { createAzureBlobReleasePointerStore } from './azure-release-pointer.mjs';

export function createAzureRuntimeStorage(config, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!config?.azureStorageBlobEndpoint) return Object.freeze({});
  const tokenProvider = createManagedIdentityTokenProvider({ env, fetchImpl });
  const blobClient = createAzureBlobClient({
    endpoint: config.azureStorageBlobEndpoint,
    tokenProvider,
    fetchImpl,
  });
  return Object.freeze({
    releasePointerStore: createAzureBlobReleasePointerStore({
      blobClient,
      container: config.azureControlContainer,
      blobName: config.azureReleasePointerBlob,
    }),
    collectorLockProvider: createAzureBlobLeaseProvider({
      blobClient,
      container: config.azureControlContainer,
      blobName: config.azureCollectorLockBlob,
    }),
  });
}
