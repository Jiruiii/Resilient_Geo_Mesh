const STORAGE_RESOURCE = 'https://storage.azure.com/';
const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const STORAGE_API_VERSION = '2023-11-03';

function makeHttpError(response) {
  const error = new Error(`Azure Blob request failed with HTTP ${response.status}`);
  error.status = response.status;
  error.code = response.headers.get('x-ms-error-code') ?? `AZURE_BLOB_HTTP_${response.status}`;
  return error;
}

export function createManagedIdentityTokenProvider({ env = process.env, fetchImpl = globalThis.fetch,
  now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  let cachedToken;
  let refreshAfter = 0;
  return async function getStorageToken() {
    if (cachedToken && now() < refreshAfter) return cachedToken;
    let url;
    let headers = {};
    if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
      url = new URL(env.IDENTITY_ENDPOINT);
      url.searchParams.set('api-version', '2019-08-01');
      url.searchParams.set('resource', STORAGE_RESOURCE);
      if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
      headers['X-IDENTITY-HEADER'] = env.IDENTITY_HEADER;
    } else {
      url = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
      url.searchParams.set('api-version', '2018-02-01');
      url.searchParams.set('resource', STORAGE_RESOURCE);
      if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
      headers.Metadata = 'true';
    }
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw makeHttpError(response);
    const body = await response.json();
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('Managed identity response did not contain an access token');
    }
    const expiry = Number.isFinite(Number(body.expires_on))
      ? Number(body.expires_on) * 1000
      : now() + (Number(body.expires_in) || 300) * 1000;
    cachedToken = body.access_token;
    refreshAfter = Math.max(now(), expiry - 120_000);
    return cachedToken;
  };
}

export function createAzureBlobClient({ endpoint, tokenProvider, fetchImpl = globalThis.fetch,
  now = () => new Date() } = {}) {
  if (typeof endpoint !== 'string') throw new TypeError('endpoint is required');
  const baseUrl = new URL(endpoint);
  if (baseUrl.protocol !== 'https:') throw new TypeError('Azure Blob endpoint must use HTTPS');
  if (typeof tokenProvider !== 'function') throw new TypeError('tokenProvider is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  function blobUrl(container, blobName) {
    if (typeof container !== 'string' || !/^[a-z0-9-]{3,63}$/u.test(container)) {
      throw new TypeError('container name is invalid');
    }
    if (typeof blobName !== 'string' || !blobName || blobName.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new TypeError('blob name is invalid');
    }
    const segments = blobName.split('/').map(encodeURIComponent).join('/');
    return new URL(`${container}/${segments}`, `${baseUrl.toString().replace(/\/$/u, '')}/`);
  }

  async function request(container, blobName, { method = 'GET', query, headers = {}, body } = {}) {
    const url = blobUrl(container, blobName);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const token = await tokenProvider(STORAGE_SCOPE);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-date': now().toUTCString(),
        'x-ms-version': STORAGE_API_VERSION,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  }

  return Object.freeze({
    async getJson(container, blobName) {
      const response = await request(container, blobName);
      if (response.status === 404) return null;
      if (!response.ok) throw makeHttpError(response);
      let value;
      try {
        value = await response.json();
      } catch {
        throw new Error('Azure Blob JSON content is invalid');
      }
      return { value, etag: response.headers.get('etag') };
    },
    async putJson(container, blobName, value, conditions = {}) {
      const headers = {
        'Content-Type': 'application/json',
        'x-ms-blob-type': 'BlockBlob',
      };
      if (conditions.ifMatch) headers['If-Match'] = conditions.ifMatch;
      if (conditions.ifNoneMatch) headers['If-None-Match'] = conditions.ifNoneMatch;
      const response = await request(container, blobName, {
        method: 'PUT',
        headers,
        body: JSON.stringify(value),
      });
      if (!response.ok) throw makeHttpError(response);
      return response.headers.get('etag');
    },
    async ensureBlob(container, blobName) {
      try {
        await this.putJson(container, blobName, {}, { ifNoneMatch: '*' });
        return true;
      } catch (error) {
        if (error.status === 412) return false;
        throw error;
      }
    },
    async acquireLease(container, blobName, leaseDurationSeconds = 60) {
      const response = await request(container, blobName, {
        method: 'PUT',
        query: { comp: 'lease' },
        headers: {
          'x-ms-lease-action': 'acquire',
          'x-ms-lease-duration': String(leaseDurationSeconds),
          'Content-Length': '0',
        },
      });
      if (!response.ok) throw makeHttpError(response);
      const leaseId = response.headers.get('x-ms-lease-id');
      if (!leaseId) throw new Error('Azure Blob lease response omitted its lease ID');
      return leaseId;
    },
    async renewLease(container, blobName, leaseId) {
      const response = await request(container, blobName, {
        method: 'PUT',
        query: { comp: 'lease' },
        headers: { 'x-ms-lease-action': 'renew', 'x-ms-lease-id': leaseId, 'Content-Length': '0' },
      });
      if (!response.ok) throw makeHttpError(response);
    },
    async releaseLease(container, blobName, leaseId) {
      const response = await request(container, blobName, {
        method: 'PUT',
        query: { comp: 'lease' },
        headers: { 'x-ms-lease-action': 'release', 'x-ms-lease-id': leaseId, 'Content-Length': '0' },
      });
      if (!response.ok) throw makeHttpError(response);
    },
  });
}
