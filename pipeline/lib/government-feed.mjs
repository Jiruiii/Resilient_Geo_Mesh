import { signCanonical, verifyCanonical } from './crypto.mjs';
import { sha256Canonical, eventPayload } from './canonical.mjs';
import { signEvent, verifyBundle } from './contract.mjs';
import { buildBundle } from './bundle.mjs';

export const FEED_KEY_ID = 'government-feed-2026';
function distributable(event, now) {
  return Date.parse(event.expires_at) > now.getTime() || event.attributes?.publication_retracted === true &&
    Date.parse(event.attributes.retraction_issued_at) + 86400000 > now.getTime();
}
function isPublicEvent(result, event) {
  const isNcdr = result.id === 'ncdr' || result.feedId === 'ncdr' || result.sourceId === 'ncdr-hazard-events';
  return !isNcdr || event.attributes?.operational_relevance !== 'BACKGROUND';
}
export function feedInput(feed) {
  const { signature, ...input } = feed;
  return input;
}
export function verifyFeed(feed, publicKey, { signingKeyId = FEED_KEY_ID } = {}) {
  if (feed?.schema_version !== 'government-feed-v1' || feed.signing_key_id !== signingKeyId ||
      !Number.isSafeInteger(feed.revision) || feed.revision < 1 ||
      !verifyCanonical(feedInput(feed), feed.signature, publicKey)) throw new Error('Invalid signed government feed');
  return feed;
}

// Versions survive restarts in the signed public ledger. Missing records are not
// interpreted as "reopened": retain the last signed event until its own TTL.
// Never publish a raw response, request URL, credential or exception message.
export function buildGovernmentFeed({ previous, previousEvents = {}, results, privateKey, publicKey,
  signingKeyId = FEED_KEY_ID, now = new Date() }) {
  if (previous) verifyFeed(previous, publicKey, { signingKeyId });
  const revision = (previous?.revision ?? 0) + 1;
  const createdAt = now.toISOString();
  const ledger = structuredClone(previous?.event_versions ?? {});
  const files = new Map();
  const datasets = [];
  const sources = [];
  for (const result of results) {
    const id = result.id;
    if (!/^[a-z][a-z0-9-]+$/.test(id)) throw new Error('Invalid source id');
    const oldSource = previous?.sources.find(source => source.id === id);
    const current = new Map((previousEvents[id] ?? [])
      .filter(event => isPublicEvent(result, event) && distributable(event, now))
      .map(event => [event.event_id, event]));
    const namespace = `official.live.${id}`;
    if (result.events) {
      for (const eventId of result.cancelledEventIds ?? []) {
        const existing = current.get(eventId);
        if (!existing || existing.attributes.publication_retracted) continue;
        const retraction = structuredClone(existing);
        retraction.expires_at = createdAt;
        retraction.attributes.publication_retracted = true;
        retraction.attributes.retraction_issued_at = createdAt;
        retraction.event_version++;
        if (retraction.event_version > 2147483647) throw new Error('Event version exhausted');
        const identity = `${namespace}/${eventId}`;
        const payload = eventPayload(retraction); delete payload.event_version;
        ledger[identity] = { version: retraction.event_version, fingerprint: sha256Canonical(payload) };
        current.set(eventId, signEvent(retraction, privateKey));
      }
      for (const input of result.events.filter((event) => isPublicEvent(result, event))) {
        if (result.cancelledEventIds?.includes(input.event_id)) continue;
        const event = structuredClone(input);
        if (Date.parse(event.expires_at) <= now.getTime()) {
          const existing = current.get(event.event_id);
          if (!existing || existing.attributes.publication_retracted) continue;
          event.attributes.publication_retracted = true;
          event.attributes.retraction_issued_at = createdAt;
        }
        event.namespace = namespace;
        event.signing_key_id = signingKeyId;
        // URL provenance may contain an API key; only the public source name is
        // distributed. The source payload is included only after normalization.
        event.provenance = { original_source: id, received_at: createdAt,
          transport_source: { kind: 'server', node_id: 'government-collector' } };
        const identity = `${namespace}/${event.event_id}`;
        const payload = eventPayload(event);
        delete payload.event_version;
        const fingerprint = sha256Canonical(payload);
        const old = ledger[identity];
        event.event_version = old?.fingerprint === fingerprint ? old.version : (old?.version ?? 0) + 1;
        if (event.event_version > 2147483647) throw new Error('Event version exhausted');
        ledger[identity] = { version: event.event_version, fingerprint };
        const existing = current.get(event.event_id);
        current.set(event.event_id, old?.fingerprint === fingerprint && existing?.event_version === event.event_version
          ? existing : signEvent(event, privateKey));
      }
    }
    const events = [...current.values()].filter(event => distributable(event, now))
      .sort((a, b) => a.event_id.localeCompare(b.event_id));
    sources.push({ id, status: result.status, event_count: events.length,
      last_success_at: result.events ? result.retrievedAt ?? createdAt : oldSource?.last_success_at ?? null,
      checked_at: createdAt, unresolved_count: result.unresolvedCount ?? 0 });
    if (!events.length) continue;
    const priorDataset = previous?.datasets.find(dataset => dataset.source_id === id);
    if (priorDataset && sha256Canonical(events) === sha256Canonical(previousEvents[id] ?? [])) {
      datasets.push(priorDataset);
      for (const name of priorDataset.chunk_paths) {
        const chunk = previousEvents.chunks?.get(name);
        if (!chunk) throw new Error('Missing prior immutable chunk');
        files.set(name, chunk);
      }
      continue;
    }
    const bundle = buildBundle(events, { datasetId: `government-${id}`, namespace,
      datasetVersion: revision, source: id, sourceVersion: createdAt, createdAt,
      expiresAt: new Date(Math.max(...events.map(event => Date.parse(event.expires_at)))).toISOString(),
      signingKeyId, privateKey });
    const prefix = `releases/${revision}/${id}`;
    datasets.push({ source_id: id, manifest: bundle.manifest,
      chunk_paths: bundle.chunks.map((chunk, index) => `${prefix}/${index}.json`) });
    bundle.chunks.forEach((chunk, index) => files.set(`${prefix}/${index}.json`, chunk));
  }
  const unsigned = { schema_version: 'government-feed-v1', revision, created_at: createdAt,
    expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    signing_key_id: signingKeyId, signature_algorithm: 'Ed25519', sources, datasets, event_versions: ledger };
  return { feed: { ...unsigned, signature: signCanonical(unsigned, privateKey) }, files };
}

export async function readPreviousEvents(feed, readChunk, publicKey) {
  verifyFeed(feed, publicKey, { signingKeyId: feed?.signing_key_id });
  const output = {};
  Object.defineProperty(output, 'chunks', { value: new Map() });
  for (const dataset of feed.datasets) {
    for (const name of dataset.chunk_paths) {
      if (!/^releases\/[0-9]+\/[a-z][a-z0-9-]+\/[0-9]+\.json$/.test(name)) throw new Error('Unsafe chunk path');
    }
    const chunks = new Array(dataset.chunk_paths.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const index = next++;
        const name = dataset.chunk_paths[index];
        const chunk = await readChunk(name);
        chunks[index] = chunk;
        output.chunks.set(name, chunk);
      }
    }));
    const verified = verifyBundle({ manifest: dataset.manifest, chunks }, publicKey, {
      trustedKeyIds: [feed.signing_key_id],
    });
    if (!verified.valid) throw new Error('Previous bundle failed verification');
    output[dataset.source_id] = chunks.flatMap(chunk => chunk.events);
  }
  return output;
}
