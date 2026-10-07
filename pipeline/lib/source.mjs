const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SECRET_NAME_RE = /^(?:authorization|proxy-authorization|x-api-key|api-key|api_key|client-secret|client_id|client-id|client_secret|access-token|access_token|token|apikey|key)$/iu;
const SAFE_RESPONSE_HEADERS = {
  etag: 'etag',
  last_modified: 'last-modified',
  content_type: 'content-type',
};

export class SourceRequestError extends Error {
  constructor(message, { code, status = null, url, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SourceRequestError';
    this.code = code;
    this.status = status;
    this.url = url;
  }
}

function isJsonContainer(value) {
  return value !== null && typeof value === 'object';
}

function assertTimestamp(value, fieldName) {
  if (typeof value !== 'string' || !RFC3339_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be an RFC 3339 date-time`);
  }
}

function assertHttpUrl(value, fieldName = 'url') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${fieldName} must be a URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${fieldName} must be a URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError(`${fieldName} must use HTTP or HTTPS`);
  return parsed;
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  if (typeof headers[Symbol.iterator] === 'function' && typeof headers !== 'string') return [...headers];
  if (typeof headers === 'object') return Object.entries(headers);
  throw new TypeError('headers must be an object or Headers');
}

function readHeader(headers, expectedName) {
  const expected = expectedName.toLowerCase();
  for (const [name, value] of headerEntries(headers)) {
    if (String(name).toLowerCase() === expected) return String(value);
  }
  return undefined;
}

function retryAfterMilliseconds(headers, now = Date.now(), maxRetryAfterMs = 60_000) {
  const value = readHeader(headers, 'retry-after');
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(trimmed)
    ? seconds * 1000
    : Math.max(0, Date.parse(trimmed) - now);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(milliseconds, maxRetryAfterMs);
}

function safeResponseHeaders(headers) {
  const safe = {};
  for (const [outputName, inputName] of Object.entries(SAFE_RESPONSE_HEADERS)) {
    const value = readHeader(headers, inputName);
    if (value !== undefined) safe[outputName] = value;
  }
  return safe;
}

function conditionalRequestHeaders(validators = {}) {
  const output = {};
  if (validators.etag) output['If-None-Match'] = String(validators.etag);
  if (validators.lastModified) output['If-Modified-Since'] = String(validators.lastModified);
  return output;
}

function queryEntries(query) {
  if (query === undefined || query === null) return [];
  return query instanceof URLSearchParams
    ? [...query.entries()]
    : Array.isArray(query)
      ? query
      : Object.entries(query);
}

function sanitizeQuery(query, allowedSensitiveNames = new Set()) {
  return Object.fromEntries(queryEntries(query).filter(([name]) => (
    allowedSensitiveNames.has(String(name).toLowerCase()) || !SECRET_NAME_RE.test(String(name))
  )));
}

function sanitizeUrl(value, allowedSensitiveNames = new Set()) {
  const parsed = assertHttpUrl(value);
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_NAME_RE.test(name) && !allowedSensitiveNames.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  return parsed.toString();
}

function urlWithQuery(value, query, allowedSensitiveNames = new Set()) {
  const parsed = new URL(sanitizeUrl(value, allowedSensitiveNames));
  const safeQuery = sanitizeQuery(query, allowedSensitiveNames);
  for (const [name, queryValue] of Object.entries(safeQuery)) {
    parsed.searchParams.delete(name);
    if (Array.isArray(queryValue)) {
      for (const item of queryValue) parsed.searchParams.append(name, String(item));
    } else {
      parsed.searchParams.set(name, String(queryValue));
    }
  }
  return parsed.toString();
}

function safeRequest(request = {}) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!/^[A-Z]+$/u.test(method)) throw new TypeError('request.method must be an HTTP method');
  const url = sanitizeUrl(request.url);
  return {
    method,
    url: urlWithQuery(url, request.query),
    query: sanitizeQuery(request.query),
  };
}

export function makeRawSnapshot({
  sourceId,
  request,
  responseStatus,
  responseHeaders,
  retrievedAt,
  payload,
} = {}) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('sourceId is required');
  const safeStatus = Number(responseStatus);
  if (!Number.isInteger(safeStatus) || safeStatus < 200 || safeStatus >= 300) {
    throw new TypeError('responseStatus must be a 2xx status');
  }
  assertTimestamp(retrievedAt, 'retrievedAt');
  if (!isJsonContainer(payload)) throw new TypeError('payload must be an object or array');

  return {
    schema_version: 'raw-snapshot-v0',
    source_id: sourceId,
    request: safeRequest(request),
    response: {
      status: safeStatus,
      headers: safeResponseHeaders(responseHeaders),
    },
    retrieved_at: retrievedAt,
    payload,
  };
}

export function validateRawSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ['snapshot must be an object'];
  if (snapshot.schema_version !== 'raw-snapshot-v0') errors.push('schema_version must be raw-snapshot-v0');
  if (typeof snapshot.source_id !== 'string' || snapshot.source_id.length === 0) errors.push('source_id is required');
  if (!snapshot.request || typeof snapshot.request !== 'object' || Array.isArray(snapshot.request)) {
    errors.push('request must be an object');
  } else {
    if (typeof snapshot.request.method !== 'string' || !/^[A-Z]+$/u.test(snapshot.request.method)) errors.push('request.method is invalid');
    try { assertHttpUrl(snapshot.request.url, 'request.url'); } catch (error) { errors.push(error.message); }
    if (!snapshot.request.query || typeof snapshot.request.query !== 'object' || Array.isArray(snapshot.request.query)) errors.push('request.query must be an object');
  }
  if (!snapshot.response || typeof snapshot.response !== 'object' || Array.isArray(snapshot.response)) {
    errors.push('response must be an object');
  } else if (!Number.isInteger(snapshot.response.status) || snapshot.response.status < 200 || snapshot.response.status >= 300) {
    errors.push('response.status must be a 2xx status');
  }
  try { assertTimestamp(snapshot.retrieved_at, 'retrieved_at'); } catch (error) { errors.push(error.message); }
  if (!isJsonContainer(snapshot.payload)) errors.push('payload must be an object or array');
  return errors;
}

function shouldRetryStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestJson(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  query,
  allowedSensitiveQueryNames = [],
  validators,
  allowNotModified = false,
  sleepImpl = wait,
  maxRetryAfterMs = 60_000,
  timeoutMs = 30000,
  maxAttempts = 3,
} = {}) {
  const allowedSensitiveNames = new Set(allowedSensitiveQueryNames.map((name) => String(name).toLowerCase()));
  const requestUrl = urlWithQuery(url, query, allowedSensitiveNames);
  const safeRequestUrl = urlWithQuery(url, query);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError('maxAttempts must be positive');
  if (!Number.isInteger(maxRetryAfterMs) || maxRetryAfterMs < 0) {
    throw new TypeError('maxRetryAfterMs must be a non-negative integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelayMs;
    try {
      const response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: { ...conditionalRequestHeaders(validators), ...headers },
        signal: controller.signal,
      });
      if (!response || typeof response.status !== 'number') {
        throw new SourceRequestError('source response has no HTTP status', {
          code: 'INVALID_RESPONSE',
          url: safeRequestUrl,
        });
      }
      const responseHeaders = safeResponseHeaders(response.headers);
      if (allowNotModified && response.status === 304) {
        return { notModified: true, status: 304, headers: responseHeaders };
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new SourceRequestError(`source returned HTTP ${response.status}`, {
          code: 'HTTP_ERROR',
          status: response.status,
          url: safeRequestUrl,
        });
        if (attempt === maxAttempts || !shouldRetryStatus(response.status)) throw error;
        lastError = error;
        retryDelayMs = retryAfterMilliseconds(response.headers, Date.now(), maxRetryAfterMs);
        await sleepImpl(retryDelayMs ?? Math.min(250 * 2 ** (attempt - 1), 2000));
        continue;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SourceRequestError('source returned invalid JSON', {
          code: 'INVALID_JSON',
          status: response.status,
          url: safeRequestUrl,
          cause: error,
        });
      }
      if (!isJsonContainer(payload)) {
        throw new SourceRequestError('source JSON payload must be an object or array', {
          code: 'INVALID_PAYLOAD',
          status: response.status,
          url: safeRequestUrl,
        });
      }
      return { status: response.status, headers: responseHeaders, payload };
    } catch (error) {
      if (error instanceof SourceRequestError) {
        if (error.code !== 'HTTP_ERROR' || attempt === maxAttempts || !shouldRetryStatus(error.status)) throw error;
        lastError = error;
      } else {
        lastError = new SourceRequestError('source request failed', {
          code: 'NETWORK_ERROR',
          url: safeRequestUrl,
          cause: error,
        });
        if (attempt === maxAttempts) throw lastError;
      }
      if (attempt < maxAttempts) await sleepImpl(retryDelayMs ?? Math.min(250 * 2 ** (attempt - 1), 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new SourceRequestError('source request failed', { code: 'NETWORK_ERROR', url: safeRequestUrl });
}

export async function requestJsonConditional(url, options = {}) {
  return requestJson(url, { ...options, allowNotModified: true });
}

export async function requestText(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  query,
  allowedSensitiveQueryNames = [],
  timeoutMs = 30000,
  maxAttempts = 3,
} = {}) {
  const allowedSensitiveNames = new Set(allowedSensitiveQueryNames.map((name) => String(name).toLowerCase()));
  const requestUrl = urlWithQuery(url, query, allowedSensitiveNames);
  const safeRequestUrl = urlWithQuery(url, query);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError('maxAttempts must be positive');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const responseHeaders = safeResponseHeaders(response.headers);
      if (!response || typeof response.status !== 'number') {
        throw new SourceRequestError('source response has no HTTP status', {
          code: 'INVALID_RESPONSE',
          url: safeRequestUrl,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new SourceRequestError(`source returned HTTP ${response.status}`, {
          code: 'HTTP_ERROR',
          status: response.status,
          url: safeRequestUrl,
        });
        if (attempt === maxAttempts || !shouldRetryStatus(response.status)) throw error;
        lastError = error;
        await wait(Math.min(250 * 2 ** (attempt - 1), 2000));
        continue;
      }
      let body;
      try {
        body = await response.text();
      } catch (error) {
        throw new SourceRequestError('source returned an unreadable text body', {
          code: 'INVALID_BODY',
          status: response.status,
          url: safeRequestUrl,
          cause: error,
        });
      }
      if (typeof body !== 'string') {
        throw new SourceRequestError('source text body is not a string', {
          code: 'INVALID_BODY',
          status: response.status,
          url: safeRequestUrl,
        });
      }
      return { status: response.status, headers: responseHeaders, body };
    } catch (error) {
      if (error instanceof SourceRequestError) {
        if (error.code !== 'HTTP_ERROR' || attempt === maxAttempts || !shouldRetryStatus(error.status)) throw error;
        lastError = error;
      } else {
        lastError = new SourceRequestError('source request failed', {
          code: 'NETWORK_ERROR',
          url: safeRequestUrl,
          cause: error,
        });
        if (attempt === maxAttempts) throw lastError;
      }
      if (attempt < maxAttempts) await wait(Math.min(250 * 2 ** (attempt - 1), 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new SourceRequestError('source request failed', { code: 'NETWORK_ERROR', url: safeRequestUrl });
}

/**
 * Fetch a binary public resource while retaining the same retry, timeout and
 * secret-free URL/header handling as requestJson/requestText. This is used by
 * the MOHW ODS medical master, which is a ZIP container rather than JSON/CSV.
 */
export async function requestBytes(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  query,
  allowedSensitiveQueryNames = [],
  timeoutMs = 30000,
  maxAttempts = 3,
} = {}) {
  const allowedSensitiveNames = new Set(allowedSensitiveQueryNames.map((name) => String(name).toLowerCase()));
  const requestUrl = urlWithQuery(url, query, allowedSensitiveNames);
  const safeRequestUrl = urlWithQuery(url, query);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError('maxAttempts must be positive');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const responseHeaders = safeResponseHeaders(response.headers);
      if (!response || typeof response.status !== 'number') {
        throw new SourceRequestError('source response has no HTTP status', {
          code: 'INVALID_RESPONSE',
          url: safeRequestUrl,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new SourceRequestError(`source returned HTTP ${response.status}`, {
          code: 'HTTP_ERROR',
          status: response.status,
          url: safeRequestUrl,
        });
        if (attempt === maxAttempts || !shouldRetryStatus(response.status)) throw error;
        lastError = error;
        await wait(Math.min(250 * 2 ** (attempt - 1), 2000));
        continue;
      }
      let body;
      try {
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new SourceRequestError('source returned an unreadable binary body', {
          code: 'INVALID_BODY',
          status: response.status,
          url: safeRequestUrl,
          cause: error,
        });
      }
      return { status: response.status, headers: responseHeaders, body };
    } catch (error) {
      if (error instanceof SourceRequestError) {
        if (error.code !== 'HTTP_ERROR' || attempt === maxAttempts || !shouldRetryStatus(error.status)) throw error;
        lastError = error;
      } else {
        lastError = new SourceRequestError('source request failed', {
          code: 'NETWORK_ERROR',
          url: safeRequestUrl,
          cause: error,
        });
        if (attempt === maxAttempts) throw lastError;
      }
      if (attempt < maxAttempts) await wait(Math.min(250 * 2 ** (attempt - 1), 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new SourceRequestError('source request failed', { code: 'NETWORK_ERROR', url: safeRequestUrl });
}
