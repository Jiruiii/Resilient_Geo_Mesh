import { createHash } from 'node:crypto';

/**
 * Serialize JSON values deterministically.
 *
 * Objects are sorted by UTF-16 property name, arrays keep their order, and
 * there is no insignificant whitespace. This is the v0 signing boundary.
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot contain non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalize(value), 'utf8'));
}

const EVENT_PAYLOAD_FIELDS = [
  'namespace',
  'event_id',
  'event_type',
  'geometry',
  'severity',
  'source',
  'source_version',
  'event_version',
  'issued_at',
  'expires_at',
  'attributes',
];

export function eventPayload(event) {
  return Object.fromEntries(
    EVENT_PAYLOAD_FIELDS
      .filter((field) => event[field] !== undefined)
      .map((field) => [field, event[field]]),
  );
}

export function eventSignatureInput(event) {
  return {
    ...eventPayload(event),
    payload_hash: event.payload_hash,
  };
}

export function manifestHashInput(manifest) {
  const { manifest_hash: _manifestHash, signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function manifestSignatureInput(manifest) {
  const { signature: _signature, ...signedContent } = manifest;
  return signedContent;
}

export function chunkContent(chunk) {
  return {
    dataset_id: chunk.dataset_id,
    namespace: chunk.namespace,
    dataset_version: chunk.dataset_version,
    sequence: chunk.sequence,
    priority: chunk.priority,
    area_id: chunk.area_id,
    theme: chunk.theme,
    bbox: chunk.bbox,
    content_type: chunk.content_type,
    content_encoding: chunk.content_encoding,
    events: chunk.events,
  };
}

/**
 * The category an NCDR event is chunked under. Bundling and verification must
 * agree, so an NCDR event without a code is grouped and checked as 'other';
 * events from other sources have no category.
 */
export function ncdrChunkCategoryCode(event) {
  if (event?.source?.toUpperCase() !== 'NCDR') return null;
  return event?.attributes?.ncdr_category_code ?? 'other';
}

export function chunkPayloadBytes(chunk) {
  return Buffer.from(canonicalize(chunkContent(chunk)), 'utf8');
}

export function chunkSignatureInput(chunk) {
  const { signature: _signature, ...signedContent } = chunk;
  return signedContent;
}
