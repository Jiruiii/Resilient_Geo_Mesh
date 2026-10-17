(function installRescueOutbox(global) {
  // Mirror of pipeline/lib/rescue-contract.mjs + rescue-request.mjs for the
  // browser. pipeline/test/rescue-outbox-web.test.mjs replays the shared
  // fixture against this file, so error codes and canonical bytes must match.
  const encoder = new TextEncoder();
  const helper = () => {
    const value = global.ResilientGeoNLSCStatic;
    if (!value) throw new Error('rescue_helper_missing');
    return value;
  };

  const NAMESPACE = 'crowd.rescue';
  const EVENT_TYPE = 'RESCUE_REQUEST';
  const SOURCE = 'CROWD';
  const SOURCE_VERSION = 'rescue-request-v0';
  const TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
  const MAX_EVENT_VERSION = 200;
  const PEOPLE_MAX = 50;
  const DESCRIPTION_MAX = 160;
  const HINT_TEXT_MAX = 80;
  const COOLDOWN_MS = 30 * 1000;
  const REQUEST_TYPES = ['FIRST_AID_NEEDED', 'IMMOBILE', 'TRAPPED', 'TRAPPED_DEBRIS', 'OTHER_RESCUE'];
  const STATUSES = ['ACTIVE', 'RESOLVED', 'CANCELLED'];
  const SUBJECTS = ['SELF', 'OTHERS'];
  const TRIAGE_FIELDS = ['immobile', 'breathing_difficulty', 'severe_bleeding', 'conscious'];
  const TRIAGE_ANSWERS = ['YES', 'NO', 'UNKNOWN'];
  const LOCATION_SOURCES = ['CURRENT_LOCATION', 'MAP_PICK'];
  const HINT_KINDS = ['COUNTY', 'DISTRICT', 'VILLAGE', 'ROAD', 'FACILITY'];
  const HINT_PRECISIONS = ['AREA', 'ROAD', 'POINT'];
  const BOUNDS = [116.5, 20.5, 122.5, 26.8];
  const ATTRIBUTE_KEYS = new Set([
    'request_type', 'status', 'subject', 'people_count', 'triage', 'description',
    'location_source', 'location_hint', 'first_issued_at', 'area_id', 'theme',
  ]);
  const EVENT_ID_RE = /^rescue:([0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const PAYLOAD_FIELDS = [
    'namespace', 'event_id', 'event_type', 'geometry', 'severity', 'source',
    'source_version', 'event_version', 'issued_at', 'expires_at', 'attributes',
  ];
  const DATABASE = 'resilientgeo-rescue-v1';
  const KEY_STORE = 'keys';
  const SESSION_STORE = 'sessions';
  const ENDPOINT = '/v1/crowd/rescue-events';

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const codePoints = (value) => [...value].length;
  const roundCoordinate = (value) => Number(value.toFixed(6));
  const isoSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const isTerminal = (status) => status === 'RESOLVED' || status === 'CANCELLED';

  function deriveUrgency(requestType, triage) {
    if (requestType === 'TRAPPED_DEBRIS') return 'CRITICAL';
    if (triage?.breathing_difficulty === 'YES' || triage?.severe_bleeding === 'YES' || triage?.conscious === 'NO') return 'CRITICAL';
    if (requestType === 'TRAPPED' || requestType === 'IMMOBILE' || triage?.immobile === 'YES') return 'HIGH';
    return 'MEDIUM';
  }

  function hintValid(hint) {
    if (hint === undefined || hint === null) return true;
    if (!isObject(hint)) return false;
    return hint.method === 'ADDRESS' && HINT_KINDS.includes(hint.kind) && HINT_PRECISIONS.includes(hint.precision)
      && ['query', 'label'].every((field) => typeof hint[field] === 'string' && codePoints(hint[field]) <= HINT_TEXT_MAX);
  }

  function triageValid(triage, subject) {
    if (!isObject(triage)) return false;
    const keys = Object.keys(triage);
    if (keys.length !== TRIAGE_FIELDS.length || !TRIAGE_FIELDS.every((field) => keys.includes(field))) return false;
    if (!TRIAGE_FIELDS.every((field) => TRIAGE_ANSWERS.includes(triage[field]))) return false;
    return subject !== 'SELF' || triage.conscious === 'YES';
  }

  function coordinatesValid(lon, lat) {
    return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat)
      && lon >= BOUNDS[0] && lon <= BOUNDS[2] && lat >= BOUNDS[1] && lat <= BOUNDS[3];
  }

  function fieldErrors({ requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint }) {
    const errors = [];
    if (!REQUEST_TYPES.includes(requestType)) errors.push('rescue_field_invalid:request_type');
    if (!SUBJECTS.includes(subject)) errors.push('rescue_field_invalid:subject');
    if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > PEOPLE_MAX) errors.push('rescue_field_invalid:people_count');
    if (!triageValid(triage, subject)) errors.push('rescue_field_invalid:triage');
    if (typeof description !== 'string' || codePoints(description.trim()) > DESCRIPTION_MAX) errors.push('rescue_field_invalid:description');
    if (!LOCATION_SOURCES.includes(locationSource)) errors.push('rescue_field_invalid:location_source');
    if (!hintValid(locationHint)) errors.push('rescue_field_invalid:location_hint');
    if (!coordinatesValid(lon, lat)) errors.push('rescue_geometry_invalid');
    return errors;
  }

  function eventErrors(event) {
    const attributes = isObject(event.attributes) ? event.attributes : {};
    if (event.namespace !== NAMESPACE || event.event_type !== EVENT_TYPE || event.source !== SOURCE
      || event.source_version !== SOURCE_VERSION || attributes.area_id !== 'crowd' || attributes.theme !== 'rescue') {
      return ['rescue_identity_invalid'];
    }
    const match = EVENT_ID_RE.exec(event.event_id);
    if (!match || `device:${match[1]}` !== event.signing_key_id) return ['rescue_event_id_unbound'];
    const geometry = event.geometry;
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
      return ['rescue_geometry_invalid'];
    }
    if (Object.keys(attributes).some((key) => !ATTRIBUTE_KEYS.has(key))) return ['rescue_attributes_unknown'];
    const errors = fieldErrors({
      requestType: attributes.request_type,
      subject: attributes.subject,
      peopleCount: attributes.people_count,
      triage: attributes.triage,
      description: attributes.description,
      lon: geometry.coordinates[0],
      lat: geometry.coordinates[1],
      locationSource: attributes.location_source,
      locationHint: attributes.location_hint,
    });
    if (errors.length > 0) return [errors[0]];
    if (!STATUSES.includes(attributes.status)) return ['rescue_field_invalid:status'];
    if (event.severity !== deriveUrgency(attributes.request_type, attributes.triage)) return ['rescue_severity_mismatch'];
    if (event.event_version > MAX_EVENT_VERSION) return ['rescue_version_too_high'];
    const issued = Date.parse(event.issued_at);
    const expires = Date.parse(event.expires_at);
    const first = Date.parse(attributes.first_issued_at);
    if ([issued, expires, first].some(Number.isNaN) || first > issued || expires <= issued
      || (event.event_version === 1 && first !== issued)) {
      return ['rescue_time_invalid'];
    }
    if (expires - issued > TTL_MS) return ['rescue_ttl_too_long'];
    if (expires > first + MAX_LIFETIME_MS) return ['rescue_lifetime_exceeded'];
    return [];
  }

  function transitionErrors(stored, incoming) {
    if (stored.signing_key_id !== incoming.signing_key_id) return ['signer_mismatch'];
    if (isTerminal(stored.attributes?.status)) return ['rescue_terminal'];
    if (isTerminal(incoming.attributes?.status) && incoming.expires_at !== stored.expires_at) return ['rescue_terminal_expiry_changed'];
    if (incoming.attributes?.first_issued_at !== stored.attributes?.first_issued_at) return ['rescue_first_issued_changed'];
    return [];
  }

  function toBase64(buffer) {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const keyIdForSpki = async (spkiBytes) => `device:${(await sha256Hex(spkiBytes)).slice(0, 32)}`;

  function payloadOf(event) {
    return Object.fromEntries(PAYLOAD_FIELDS.filter((field) => event[field] !== undefined).map((field) => [field, event[field]]));
  }

  async function signEvent(event, privateKey) {
    const { canonicalize, sha256 } = helper();
    const payload = payloadOf(event);
    const payloadHash = await sha256(canonicalize(payload));
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      encoder.encode(canonicalize({ ...payload, payload_hash: payloadHash })),
    );
    return { ...event, payload_hash: payloadHash, signature_algorithm: 'Ed25519', signature: toBase64(signature) };
  }

  function normalizedTriage(subject, triage = {}) {
    return {
      immobile: triage.immobile,
      breathing_difficulty: triage.breathing_difficulty,
      severe_bleeding: triage.severe_bleeding,
      conscious: subject === 'SELF' ? 'YES' : triage.conscious,
    };
  }

  async function assemble({ input, eventId, version, issued, expires, status, firstIssuedAt, keyPair }) {
    const triage = normalizedTriage(input.subject, input.triage);
    const errors = fieldErrors({ ...input, triage });
    if (errors.length > 0) throw new Error(errors.join('; '));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const attributes = {
      request_type: input.requestType,
      status,
      subject: input.subject,
      people_count: input.peopleCount,
      triage,
      description: input.description.trim(),
      location_source: input.locationSource,
      first_issued_at: firstIssuedAt,
      area_id: 'crowd',
      theme: 'rescue',
    };
    if (input.locationHint) {
      const hint = input.locationHint;
      attributes.location_hint = { method: hint.method, query: hint.query, label: hint.label, kind: hint.kind, precision: hint.precision };
    }
    const event = {
      schema_version: 'event-v0',
      namespace: NAMESPACE,
      event_id: eventId,
      event_type: EVENT_TYPE,
      geometry: { type: 'Point', coordinates: [roundCoordinate(input.lon), roundCoordinate(input.lat)] },
      severity: deriveUrgency(attributes.request_type, triage),
      source: SOURCE,
      source_version: SOURCE_VERSION,
      event_version: version,
      issued_at: issued,
      expires_at: expires,
      attributes,
      signing_key_id: await keyIdForSpki(spki),
      signer_public_key: toBase64(spki),
      provenance: { original_source: 'crowd-app', received_at: issued, transport_source: { kind: 'local_report' } },
    };
    return signEvent(event, keyPair.privateKey);
  }

  async function buildRequest(input, { issuedAt, requestUuid, keyPair }) {
    const issued = isoSeconds(issuedAt);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const keyId = await keyIdForSpki(spki);
    return assemble({
      input,
      eventId: `rescue:${keyId.slice('device:'.length)}:${requestUuid.toLowerCase()}`,
      version: 1,
      issued,
      expires: isoSeconds(Date.parse(issued) + TTL_MS),
      status: 'ACTIVE',
      firstIssuedAt: issued,
      keyPair,
    });
  }

  function inputFromEvent(event) {
    const attributes = event.attributes;
    return {
      requestType: attributes.request_type,
      subject: attributes.subject,
      peopleCount: attributes.people_count,
      triage: { ...attributes.triage },
      description: attributes.description,
      lon: event.geometry.coordinates[0],
      lat: event.geometry.coordinates[1],
      locationSource: attributes.location_source,
      locationHint: attributes.location_hint ? { ...attributes.location_hint } : undefined,
    };
  }

  function inputFromArguments(args) {
    if (!isObject(args) || !isObject(args.location)) throw new Error('rescue_field_invalid:request_type');
    return {
      requestType: args.request_type,
      subject: args.subject,
      peopleCount: args.people_count,
      triage: isObject(args.triage) ? { ...args.triage } : args.triage,
      description: typeof args.description === 'string' ? args.description : '',
      lon: args.location.lon,
      lat: args.location.lat,
      locationSource: args.location.source,
      locationHint: args.location_hint ?? undefined,
    };
  }

  async function buildRevision(previous, { action, input, issuedAt, keyPair }) {
    if (!['UPDATE', 'EXTEND', 'RESOLVE', 'CANCEL'].includes(action)) throw new Error('rescue_action_invalid');
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    if (await keyIdForSpki(spki) !== previous.signing_key_id) throw new Error('rescue_revision_wrong_device');
    if (isTerminal(previous.attributes.status)) throw new Error('rescue_revision_terminal');
    const issued = isoSeconds(issuedAt);
    const issuedMs = Date.parse(issued);
    const previousExpires = Date.parse(previous.expires_at);
    if (issuedMs >= previousExpires) throw new Error('rescue_revision_expired');
    const firstIssuedAt = previous.attributes.first_issued_at;
    let expires = previous.expires_at;
    if (action === 'EXTEND') {
      const extended = Math.min(issuedMs + TTL_MS, Date.parse(firstIssuedAt) + MAX_LIFETIME_MS);
      if (extended <= previousExpires) throw new Error('rescue_extend_not_later');
      expires = isoSeconds(extended);
    }
    if (action === 'UPDATE' && !input) throw new Error('rescue_action_invalid');
    return assemble({
      input: action === 'UPDATE' ? input : inputFromEvent(previous),
      eventId: previous.event_id,
      version: previous.event_version + 1,
      issued,
      expires,
      status: action === 'RESOLVE' ? 'RESOLVED' : action === 'CANCEL' ? 'CANCELLED' : 'ACTIVE',
      firstIssuedAt,
      keyPair,
    });
  }

  const CHUNK_CONTENT_FIELDS = [
    'dataset_id', 'namespace', 'dataset_version', 'sequence', 'priority',
    'area_id', 'theme', 'bbox', 'content_type', 'content_encoding', 'events',
  ];

  /** Same envelope as buildCrowdChunk() in crowd-report.mjs for the crowd-rescue profile. */
  async function buildChunk(event, privateKey) {
    const { canonicalize, sha256 } = helper();
    const [lon, lat] = event.geometry.coordinates;
    const content = {
      schema_version: 'chunk-v0',
      chunk_id: `crowd-rescue:${event.event_id}`,
      manifest_id: 'crowd-rescue:none',
      manifest_hash: event.payload_hash,
      dataset_id: 'crowd-rescue',
      namespace: NAMESPACE,
      dataset_version: 1,
      sequence: 0,
      priority: event.severity === 'CRITICAL' || event.severity === 'HIGH' ? 'HIGH' : 'NORMAL',
      area_id: 'crowd',
      theme: 'rescue',
      bbox: [roundCoordinate(lon), roundCoordinate(lat), roundCoordinate(lon), roundCoordinate(lat)],
      created_at: event.issued_at,
      content_type: 'application/json',
      content_encoding: 'identity',
      event_count: 1,
      events: [event],
      signature_algorithm: 'Ed25519',
      signing_key_id: event.signing_key_id,
    };
    const payload = encoder.encode(canonicalize(Object.fromEntries(CHUNK_CONTENT_FIELDS.map((field) => [field, content[field]]))));
    const unsigned = { ...content, byte_length: payload.length, chunk_hash: await sha256(payload) };
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, encoder.encode(canonicalize(unsigned)));
    return { ...unsigned, signature: toBase64(signature) };
  }

  function shapeValid(event) {
    return isObject(event) && event.schema_version === 'event-v0'
      && ['namespace', 'event_id', 'event_type', 'source', 'source_version', 'signing_key_id', 'signer_public_key', 'signature']
        .every((field) => typeof event[field] === 'string' && event[field].length > 0)
      && Number.isInteger(event.event_version) && event.event_version >= 1
      && !Number.isNaN(Date.parse(event.issued_at)) && !Number.isNaN(Date.parse(event.expires_at))
      && isObject(event.geometry) && isObject(event.attributes) && isObject(event.provenance)
      && typeof event.payload_hash === 'string' && /^sha256:[0-9a-f]{64}$/i.test(event.payload_hash)
      && event.signature_algorithm === 'Ed25519';
  }

  /** Same stages as verifyEvent() in contract.mjs, restricted to device-signed crowd.* events. */
  async function verifyEvent(event, nowMs) {
    if (!shapeValid(event)) return { valid: false, stage: 'schema', errors: ['event_shape_invalid'] };
    if (!event.signing_key_id.startsWith('device:') || !event.namespace.startsWith('crowd.')) {
      return { valid: false, stage: 'trust', errors: ['device keys may only sign crowd.* events'] };
    }
    let publicKey;
    try {
      const spki = fromBase64(event.signer_public_key);
      if (await keyIdForSpki(spki) !== event.signing_key_id) {
        return { valid: false, stage: 'trust', errors: ['signing_key_id does not match signer_public_key fingerprint'] };
      }
      publicKey = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      return { valid: false, stage: 'trust', errors: ['signer_public_key is not an Ed25519 SPKI key'] };
    }
    const { canonicalize, sha256 } = helper();
    const payload = payloadOf(event);
    if (await sha256(canonicalize(payload)) !== event.payload_hash) {
      return { valid: false, stage: 'integrity', errors: ['payload_hash_mismatch'] };
    }
    const signed = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      fromBase64(event.signature),
      encoder.encode(canonicalize({ ...payload, payload_hash: event.payload_hash })),
    ).catch(() => false);
    if (!signed) return { valid: false, stage: 'signature', errors: ['signature_invalid'] };
    if (event.namespace === NAMESPACE) {
      const errors = eventErrors(event);
      if (errors.length > 0) return { valid: false, stage: 'contract', errors };
    }
    return { valid: true, expired: nowMs >= Date.parse(event.expires_at), errors: [] };
  }

  // ---- IndexedDB ---------------------------------------------------------

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error('storage_unavailable'));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
        if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('storage_unavailable'));
    });
  }

  async function storeRequest(storeName, run) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = run(database.transaction(storeName, 'readonly').objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('storage_unavailable'));
      });
    } finally {
      database.close();
    }
  }

  async function storePut(storeName, key, value) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('storage_unavailable'));
      });
    } finally {
      database.close();
    }
  }

  const allSessions = () => storeRequest(SESSION_STORE, (store) => store.getAll());

  async function deviceKey() {
    const existing = await storeRequest(KEY_STORE, (store) => store.get('device'));
    if (existing) return existing;
    let pair;
    try {
      // The private key is non-extractable: it can sign but never leaves the browser.
      pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    } catch {
      throw new Error('signing_unsupported');
    }
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const record = { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId: await keyIdForSpki(spki) };
    await storePut(KEY_STORE, 'device', record);
    return record;
  }

  function sessionView(record, nowMs) {
    const expired = nowMs >= Date.parse(record.request.expires_at);
    return {
      request: { ...record.request, apply_state: expired ? 'EXPIRED' : 'UNVERIFIED' },
      delivery_state: record.delivery_state,
      reason: record.reason ?? null,
    };
  }

  async function saveSession(event, chunk, deliveryState, reason) {
    const record = { request: event, chunk, delivery_state: deliveryState, reason, updated_at: Date.now() };
    await storePut(SESSION_STORE, event.event_id, record);
    return record;
  }

  /** Signs the event's chunk with the same device key and stores both as waiting for upload. */
  async function saveSigned(event, key) {
    return saveSession(event, await buildChunk(event, key.privateKey), 'WAITING_UPLOAD', null);
  }

  async function upload(record) {
    const state = (deliveryState, reason) => saveSession(record.request, record.chunk, deliveryState, reason);
    await state('UPLOADING', null);
    let response;
    try {
      response = await global.fetch(new URL(ENDPOINT, global.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record.chunk),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      return state('WAITING_UPLOAD', 'network_unavailable');
    }
    if (response.status === 200 || response.status === 201) return state('ACCEPTED', null);
    const body = await response.json().catch(() => ({}));
    if ([400, 409, 413].includes(response.status)) {
      return state('REJECTED', body.reason ?? body.error ?? `http_${response.status}`);
    }
    if (response.status === 404) return state('WAITING_UPLOAD', 'server_unavailable');
    if (response.status === 429) return state('WAITING_UPLOAD', 'rate_limited');
    return state('WAITING_UPLOAD', 'network_unavailable');
  }

  function guardLimits(sessions, key, nowMs, { creating }) {
    const own = sessions.filter((session) => session.request.signing_key_id === key.keyId);
    if (creating && own.some((session) => session.request.attributes.status === 'ACTIVE' && Date.parse(session.request.expires_at) > nowMs)) {
      throw new Error('rescue_active_exists');
    }
    const latest = Math.max(0, ...own.map((session) => Date.parse(session.request.issued_at)));
    const remaining = Math.ceil((latest + COOLDOWN_MS - nowMs) / 1000);
    if (remaining > 0) throw new Error(`rate_limited:${remaining}`);
  }

  async function rescueCapabilities() {
    let signing = false;
    let verifying = false;
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      signing = true;
      verifying = Boolean(pair.publicKey);
    } catch {
      signing = false;
    }
    return { signing, verifying, storage: Boolean(global.indexedDB) };
  }

  async function rescueSubmit(argsJson) {
    const input = inputFromArguments(JSON.parse(argsJson));
    const key = await deviceKey();
    const nowMs = Date.now();
    guardLimits(await allSessions(), key, nowMs, { creating: true });
    const event = await buildRequest(input, { issuedAt: nowMs, requestUuid: crypto.randomUUID(), keyPair: key });
    const saved = await saveSigned(event, key);
    return sessionView(await upload(saved), Date.now());
  }

  async function rescueRevise(eventId, action, argsJson) {
    const key = await deviceKey();
    const sessions = await allSessions();
    const current = sessions.find((session) => session.request.event_id === eventId);
    if (!current) throw new Error('rescue_not_found');
    const nowMs = Date.now();
    guardLimits(sessions, key, nowMs, { creating: false });
    const input = argsJson ? inputFromArguments(JSON.parse(argsJson)) : null;
    const event = await buildRevision(current.request, { action, input, issuedAt: nowMs, keyPair: key });
    const saved = await saveSigned(event, key);
    return sessionView(await upload(saved), Date.now());
  }

  async function rescueOwnSessions() {
    const nowMs = Date.now();
    return (await allSessions()).map((record) => sessionView(record, nowMs));
  }

  let flushing = null;
  async function rescueFlush() {
    if (!flushing) {
      flushing = (async () => {
        for (const record of await allSessions()) {
          if (record.delivery_state === 'WAITING_UPLOAD' || record.delivery_state === 'UPLOADING') {
            if (Date.now() < Date.parse(record.request.expires_at)) await upload(record);
          }
        }
      })().finally(() => { flushing = null; });
    }
    await flushing;
    return rescueOwnSessions();
  }

  async function rescueNearby(bboxJson) {
    const bbox = JSON.parse(bboxJson);
    const url = new URL(ENDPOINT, global.location.origin);
    url.searchParams.set('bbox', bbox.join(','));
    const response = await global.fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(response.status === 404 ? 'server_unavailable' : `http_${response.status}`);
    const body = await response.json();
    const nowMs = Date.now();
    const events = [];
    for (const chunk of Array.isArray(body?.chunks) ? body.chunks : []) {
      const event = Array.isArray(chunk?.events) && chunk.events.length === 1 ? chunk.events[0] : null;
      if (!event) continue;
      const result = await verifyEvent(event, nowMs);
      if (!result.valid || result.expired || event.namespace !== NAMESPACE || event.attributes.status !== 'ACTIVE') continue;
      events.push({ ...event, apply_state: 'UNVERIFIED' });
    }
    return { events };
  }

  /** Dart reads `{ ok, value | error }` instead of catching a JS rejection. */
  const exported = (run) => async (...args) => {
    try {
      return JSON.stringify({ ok: true, value: await run(...args) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
    }
  };

  global.ResilientGeoRescue = {
    deriveUrgency, fieldErrors, eventErrors, transitionErrors, verifyEvent,
    buildRequest, buildRevision, buildChunk, inputFromEvent, inputFromArguments,
  };
  global.rescueCapabilities = exported(rescueCapabilities);
  global.rescueSubmit = exported(rescueSubmit);
  global.rescueRevise = exported(rescueRevise);
  global.rescueOwnSessions = exported(rescueOwnSessions);
  global.rescueFlush = exported(rescueFlush);
  global.rescueNearby = exported(rescueNearby);
  global.addEventListener?.('online', () => { void rescueFlush().catch(() => {}); });
})(globalThis);
