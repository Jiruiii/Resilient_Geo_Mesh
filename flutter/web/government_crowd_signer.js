(function installGovernmentCrowdSigner(global) {
  'use strict';

  const databaseName = 'resilientgeo-crowd-device-key-v1';
  const storeName = 'keys';
  const keyName = 'device';
  const severities = Object.freeze({
    ROAD_BLOCKAGE: 'MEDIUM', FLOOD: 'HIGH', FIRE_SMOKE: 'HIGH', TRAPPED_INJURED: 'CRITICAL', OTHER: 'LOW',
  });
  const encoder = new TextEncoder();

  function compareUtf8(left, right) {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  }

  function canonical(value) {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (!value || typeof value !== 'object') throw new TypeError('unsupported canonical JSON value');
    return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }

  function toHex(bytes) { return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join(''); }
  function toBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
  async function sha256Bytes(bytes) { return toHex(await crypto.subtle.digest('SHA-256', bytes)); }
  async function sha256(value) { return sha256Bytes(encoder.encode(value)); }

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error('瀏覽器不支援裝置金鑰保存'));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('無法開啟裝置金鑰儲存區'));
    });
  }

  async function keyPair() {
    const database = await openDatabase();
    try {
      const stored = await new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(keyName);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('無法讀取裝置金鑰'));
      });
      if (stored) return stored;
    } finally { database.close(); }

    if (!global.crypto?.subtle || !global.crypto.randomUUID) throw new Error('此瀏覽器不支援安全裝置簽章');
    const pair = await global.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const spki = await global.crypto.subtle.exportKey('spki', pair.publicKey);
    const publicKey = toBase64(spki);
    const keyId = `device:${(await sha256Bytes(spki)).slice(0, 32)}`;
    const writeDatabase = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = writeDatabase.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put({ privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeySpki: publicKey, keyId }, keyName);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('無法保存裝置金鑰'));
        transaction.onabort = () => reject(transaction.error || new Error('裝置金鑰保存中斷'));
      });
      return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeySpki: publicKey, keyId };
    } finally { writeDatabase.close(); }
  }

  async function sign(input) {
    if (!global.isSecureContext) throw new Error('裝置簽章需要安全連線');
    const draft = JSON.parse(input);
    const location = draft.location;
    if (!location || !Number.isFinite(location.lon) || !Number.isFinite(location.lat)) throw new Error('回報位置無效');
    const keys = await keyPair();
    const issued = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const expires = new Date(Date.parse(issued) + 6 * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
    const attributes = {
      category: draft.category,
      description: String(draft.description || '').trim(),
      location_source: location.source,
      area_id: 'crowd',
      theme: 'report',
    };
    if (draft.location_hint) attributes.location_hint = draft.location_hint;
    const event = {
      schema_version: 'event-v0',
      namespace: 'crowd.reports',
      event_id: `report:${keys.keyId.slice(-8)}:${global.crypto.randomUUID().toLowerCase()}`,
      event_type: 'CROWD_REPORT',
      geometry: { type: 'Point', coordinates: [Number(location.lon.toFixed(6)), Number(location.lat.toFixed(6))] },
      severity: severities[draft.category],
      source: 'CROWD',
      source_version: 'crowd-report-v0',
      event_version: 1,
      issued_at: issued,
      expires_at: expires,
      attributes,
      signing_key_id: keys.keyId,
      signer_public_key: keys.publicKeySpki,
      provenance: { original_source: 'crowd-app', received_at: issued, transport_source: { kind: 'local_report' } },
    };
    const payloadFields = ['namespace', 'event_id', 'event_type', 'geometry', 'severity', 'source', 'source_version',
      'event_version', 'issued_at', 'expires_at', 'attributes'];
    const payload = Object.fromEntries(payloadFields.map((field) => [field, event[field]]));
    event.payload_hash = `sha256:${await sha256(canonical(payload))}`;
    event.signature_algorithm = 'Ed25519';
    const signatureInput = { ...payload, payload_hash: event.payload_hash };
    event.signature = toBase64(await global.crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey,
      encoder.encode(canonical(signatureInput))));
    return JSON.stringify(event);
  }

  global.ResilientGeoCrowdSigner = Object.freeze({ sign });
})(globalThis);
