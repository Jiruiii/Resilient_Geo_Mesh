(function installNLSCGovernmentFeed(global) {
  const helper = () => {
    const value = global.ResilientGeoNLSCStatic;
    if (!value) throw new Error('告警驗證模組尚未載入');
    return value;
  };
  const feedKeyIds = new Set(['government-feed-2026', 'central-server-2026']);
  const supportedDatasetIds = new Set([
    'ncdr', 'cwa-earthquake', 'cwa-warning', 'cwa-typhoon',
  ]);
  const eventPayloadFields = [
    'namespace', 'event_id', 'event_type', 'geometry', 'severity', 'source',
    'source_version', 'event_version', 'issued_at', 'expires_at', 'attributes',
  ];
  const chunkContentFields = [
    'dataset_id', 'namespace', 'dataset_version', 'sequence', 'priority',
    'area_id', 'theme', 'bbox', 'content_type', 'content_encoding', 'events',
  ];
  const databaseName = 'resilientgeo-government-feed-v1';
  const storeName = 'releases';
  const cacheKey = 'current';
  let cachePruneTimer = null;

  function omit(value, fields) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
  }

  function select(value, fields) {
    return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, value[field]]));
  }

  function requiredText(value, field) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`告警資料欄位無效：${field}`);
  }

  function isNcdrEvent(event) {
    return event?.source === 'NCDR' &&
      (event.namespace === 'official.live.ncdr' || event.namespace === 'official.ncdr');
  }

  function isCwaEvent(event) {
    const namespace = event?.namespace;
    return event?.source === 'CWA' && typeof namespace === 'string' && (
      namespace === 'official.cwa' || namespace.startsWith('official.cwa.') ||
      ['cwa-earthquake', 'cwa-warning', 'cwa-typhoon']
        .some((sourceId) => namespace === `official.live.${sourceId}`)
    );
  }

  function isSupportedEvent(event) {
    return isNcdrEvent(event) || isCwaEvent(event);
  }

  function isSafeChunkPath(path) {
    return /^releases\/\d+\/(?:ncdr|cwa-earthquake|cwa-warning|cwa-typhoon)\/\d+\.json$/u.test(path);
  }

  function timestamp(value, field) {
    const parsed = Date.parse(value);
    if (typeof value !== 'string' || !Number.isFinite(parsed)) throw new Error(`告警資料時間欄位無效：${field}`);
    return parsed;
  }

  async function assertSignature(value, keyId, signature, description) {
    if (!await helper().verifySigned(value, keyId, signature)) throw new Error(`${description}簽章驗證失敗`);
  }

  async function verifyFeedMetadata(feed, { now = Date.now(), allowExpired = false } = {}) {
    if (!feed || typeof feed !== 'object' || Array.isArray(feed) ||
        feed.schema_version !== 'government-feed-v1' || !Number.isSafeInteger(feed.revision) ||
        feed.revision < 1 || !Array.isArray(feed.sources) || !Array.isArray(feed.datasets) ||
        feed.datasets.length > 6 || !feed.event_versions || typeof feed.event_versions !== 'object' ||
        Array.isArray(feed.event_versions) || feed.signature_algorithm !== 'Ed25519' ||
        typeof feed.signature !== 'string' || !feedKeyIds.has(feed.signing_key_id)) {
      throw new Error('告警 feed 契約不符');
    }
    await assertSignature(omit(feed, ['signature']), feed.signing_key_id, feed.signature, '告警 feed');

    const createdAt = timestamp(feed.created_at, 'created_at');
    const expiresAt = timestamp(feed.expires_at, 'expires_at');
    if (createdAt > now + 300_000 || expiresAt <= createdAt || expiresAt > createdAt + 86_400_000 ||
        !allowExpired && expiresAt <= now) {
      throw new Error('告警 feed 已過期或時間不正確');
    }

    const seenSources = new Set();
    const manifests = [];
    let totalChunks = 0;
    let totalBytes = 0;
    for (const dataset of feed.datasets) {
      const source = dataset?.source_id;
      if (typeof source !== 'string' || source.length === 0 || seenSources.has(source)) {
        throw new Error('告警來源不受支援或重複');
      }
      seenSources.add(source);
      // Ignore unsupported signed datasets before validating or downloading
      // their manifests/chunks. NCDR and all three CWA event feeds are shown.
      if (!supportedDatasetIds.has(source)) continue;
      const manifest = dataset.manifest;
      if (!manifest || manifest.schema_version !== 'manifest-v0' ||
          manifest.dataset_id !== `government-${source}` ||
          manifest.namespace !== `official.live.${source}` ||
          !Number.isSafeInteger(manifest.dataset_version) || manifest.dataset_version < 1 ||
          manifest.dataset_version > feed.revision || manifest.signing_key_id !== feed.signing_key_id ||
          manifest.signature_algorithm !== 'Ed25519' || !Array.isArray(manifest.chunks) ||
          !Array.isArray(dataset.chunk_paths) || manifest.chunks.length === 0 ||
          manifest.chunks.length !== dataset.chunk_paths.length) {
        throw new Error('告警資料清單契約不符');
      }
      const metadataHash = await helper().sha256(helper().canonicalize(omit(manifest, ['signature', 'manifest_hash'])));
      if (metadataHash !== manifest.manifest_hash) throw new Error('告警資料清單雜湊驗證失敗');
      await assertSignature(omit(manifest, ['signature']), manifest.signing_key_id, manifest.signature, '告警資料清單');

      totalChunks += manifest.chunks.length;
      totalBytes += manifest.total_size_bytes;
      if (!Number.isSafeInteger(manifest.total_size_bytes) || manifest.total_size_bytes < 1 ||
          totalChunks > 4096 || totalBytes > 24 * 1024 * 1024) {
        throw new Error('告警資料超出允許大小');
      }
      for (let index = 0; index < manifest.chunks.length; index += 1) {
        const path = dataset.chunk_paths[index];
        if (path !== `releases/${manifest.dataset_version}/${source}/${index}.json`) {
          throw new Error('告警分塊路徑不安全');
        }
      }
      manifests.push({ source, manifest, paths: dataset.chunk_paths });
    }
    return { manifests, hash: await helper().sha256(helper().canonicalize(feed)) };
  }

  async function verifyEvent(event, namespace, signingKeyId) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.schema_version !== 'event-v0') {
      throw new Error('告警事件格式不符');
    }
    for (const field of ['namespace', 'event_id', 'event_type', 'source', 'source_version', 'signing_key_id']) {
      requiredText(event[field], field);
    }
    if (event.namespace !== namespace || event.signing_key_id !== signingKeyId ||
        !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'].includes(event.severity) ||
        !Number.isSafeInteger(event.event_version) || event.event_version < 1 ||
        !event.geometry || typeof event.geometry !== 'object' || typeof event.geometry.type !== 'string' ||
        event.geometry.type !== 'GeometryCollection' && !Array.isArray(event.geometry.coordinates) ||
        event.geometry.type === 'GeometryCollection' && !Array.isArray(event.geometry.geometries) ||
        !event.attributes || typeof event.attributes !== 'object' || Array.isArray(event.attributes) ||
        !event.provenance || typeof event.provenance !== 'object' ||
        typeof event.provenance.original_source !== 'string' || !event.provenance.original_source ||
        !event.provenance.transport_source || typeof event.provenance.transport_source.kind !== 'string' ||
        !event.provenance.transport_source.kind || event.signature_algorithm !== 'Ed25519' ||
        typeof event.payload_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(event.payload_hash) ||
        typeof event.signature !== 'string') {
      throw new Error('告警事件欄位不符');
    }
    const issuedAt = timestamp(event.issued_at, 'issued_at');
    const expiresAt = timestamp(event.expires_at, 'expires_at');
    timestamp(event.provenance.received_at, 'provenance.received_at');
    if (expiresAt < issuedAt) throw new Error('告警事件期限不正確');

    const payload = select(event, eventPayloadFields);
    if (await helper().sha256(helper().canonicalize(payload)) !== event.payload_hash) {
      throw new Error('告警事件雜湊驗證失敗');
    }
    await assertSignature({ ...payload, payload_hash: event.payload_hash }, event.signing_key_id, event.signature, '告警事件');
    return payload;
  }

  async function verifyGovernmentFeedRelease(feed, documents, options = {}) {
    const metadata = await verifyFeedMetadata(feed, options);
    if (!Array.isArray(documents)) throw new Error('告警分塊格式不符');
    const byPath = new Map(documents.map((document) => [document.path, document.chunk]));
    const expectedPaths = metadata.manifests.flatMap(({ paths }) => paths);
    if (byPath.size !== expectedPaths.length || documents.length !== expectedPaths.length) {
      throw new Error('告警分塊數量不符');
    }

    const events = [];
    for (const { source, manifest, paths } of metadata.manifests) {
      let datasetBytes = 0;
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        const chunk = byPath.get(path);
        const expected = manifest.chunks[index];
        if (!chunk || chunk.schema_version !== 'chunk-v0' || chunk.sequence !== index ||
            chunk.dataset_id !== manifest.dataset_id || chunk.namespace !== manifest.namespace ||
            chunk.dataset_version !== manifest.dataset_version || chunk.manifest_id !== manifest.manifest_id ||
            chunk.manifest_hash !== manifest.manifest_hash || chunk.chunk_id !== expected.chunk_id ||
            chunk.chunk_hash !== expected.chunk_hash || chunk.event_count !== expected.event_count ||
            chunk.area_id !== expected.area_id || chunk.theme !== expected.theme ||
            chunk.priority !== expected.priority || chunk.signing_key_id !== manifest.signing_key_id ||
            chunk.signature_algorithm !== 'Ed25519' || !Array.isArray(chunk.events) ||
            chunk.events.length !== expected.event_count || chunk.byte_length !== expected.size_bytes ||
            !Array.isArray(expected.event_ids) || expected.event_ids.length !== chunk.events.length) {
          throw new Error('告警分塊與簽章清單不一致');
        }
        const content = select(chunk, chunkContentFields);
        const contentText = helper().canonicalize(content);
        const contentBytes = new TextEncoder().encode(contentText).length;
        if (await helper().sha256(contentText) !== chunk.chunk_hash || contentBytes !== chunk.byte_length) {
          throw new Error('告警分塊雜湊或大小驗證失敗');
        }
        await assertSignature(omit(chunk, ['signature']), chunk.signing_key_id, chunk.signature, '告警分塊');
        for (let eventIndex = 0; eventIndex < chunk.events.length; eventIndex += 1) {
          const event = chunk.events[eventIndex];
          if (event.event_id !== expected.event_ids[eventIndex]) throw new Error('告警事件 ID 與清單不一致');
          await verifyEvent(event, manifest.namespace, manifest.signing_key_id);
          const expectedSource = source === 'ncdr' ? 'NCDR' : 'CWA';
          if (event.source !== expectedSource) throw new Error('官方告警來源不一致');
          events.push(event);
        }
        datasetBytes += chunk.byte_length;
      }
      if (datasetBytes !== manifest.total_size_bytes) throw new Error('告警資料總大小不一致');
    }
    const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    const currentEvents = events.filter((event) => event.attributes.publication_retracted !== true &&
      timestamp(event.expires_at, 'expires_at') > now);
    return { revision: feed.revision, hash: metadata.hash, feed, documents, events: currentEvents, allEvents: events };
  }

  async function verifyCachedRelease(stored) {
    const metadata = await verifyFeedMetadata(stored?.feed, { allowExpired: true });
    if (stored.revision !== stored.feed.revision || stored.hash !== metadata.hash || !Array.isArray(stored.events)) {
      throw new Error('告警快取版本不一致');
    }
    const knownEvents = new Map();
    for (const { manifest } of metadata.manifests) {
      for (const entry of manifest.chunks) {
        for (const eventId of entry.event_ids ?? []) {
          knownEvents.set(`${manifest.namespace}/${eventId}`, manifest.namespace);
        }
      }
    }
    const now = Date.now();
    const events = [];
    const seen = new Set();
    for (const event of stored.events) {
      // Drop unsupported records from older browser caches while preserving
      // valid NCDR and CWA events for offline use.
      if (!isSupportedEvent(event)) continue;
      const identity = `${event?.namespace}/${event?.event_id}`;
      const namespace = knownEvents.get(identity);
      if (!namespace || seen.has(identity)) throw new Error('告警快取內容與簽章清單不符');
      seen.add(identity);
      const payload = await verifyEvent(event, namespace, stored.feed.signing_key_id);
      const version = stored.feed.event_versions[identity];
      const fingerprintPayload = { ...payload };
      delete fingerprintPayload.event_version;
      if (!version || version.version !== event.event_version ||
          version.fingerprint !== await helper().sha256(helper().canonicalize(fingerprintPayload))) {
        throw new Error('告警快取版本記錄不符');
      }
      if (event.attributes.publication_retracted !== true && timestamp(event.expires_at, 'expires_at') > now) {
        events.push(event);
      }
    }
    return { revision: stored.revision, hash: stored.hash, feed: stored.feed, events };
  }

  function requestJson(path, maximumBytes) {
    const url = new URL(path, global.location.origin);
    if (url.origin !== global.location.origin || url.username || url.password || url.search || url.hash) {
      throw new Error('告警資料 URL 不安全');
    }
    return global.fetch(url.href, {
      method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    }).then(async (response) => {
      if (!response.ok) throw new Error('告警更新伺服器暫時無法使用');
      const text = await response.text();
      if (new TextEncoder().encode(text).length > maximumBytes) throw new Error('告警資料超出允許大小');
      try { return JSON.parse(text); } catch { throw new Error('告警資料不是有效 JSON'); }
    });
  }

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error('瀏覽器不支援本機告警快取'));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('無法開啟告警快取'));
    });
  }

  async function readCachedRelease() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(cacheKey);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('無法讀取告警快取'));
      });
    } finally {
      database.close();
    }
  }

  async function writeCachedRelease(value) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value, cacheKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('無法保存告警快取'));
        transaction.onabort = () => reject(transaction.error || new Error('告警快取寫入中斷'));
      });
    } finally {
      database.close();
    }
  }

  async function clearCachedRelease() {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).delete(cacheKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('無法清除告警快取'));
        transaction.onabort = () => reject(transaction.error || new Error('告警快取清除中斷'));
      });
    } finally {
      database.close();
    }
  }

  async function pruneCachedEvents() {
    try {
      const stored = await readCachedRelease();
      if (!stored) return;
      const verified = await verifyCachedRelease(stored);
      if (verified.events.length !== stored.events.length) {
        await writeCachedRelease({
          revision: verified.revision,
          hash: verified.hash,
          feed: verified.feed,
          events: verified.events,
        });
      }
      scheduleCachePrune(verified.events);
    } catch (_) {
      try { await clearCachedRelease(); } catch (_) { /* Storage may be unavailable. */ }
    }
  }

  function scheduleCachePrune(events) {
    if (cachePruneTimer !== null && global.clearTimeout) global.clearTimeout(cachePruneTimer);
    cachePruneTimer = null;
    if (!global.setTimeout) return;
    const nextExpiry = events.map((event) => timestamp(event.expires_at, 'expires_at'))
      .filter((value) => value > Date.now()).sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const delay = Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_483_647);
    cachePruneTimer = global.setTimeout(() => { void pruneCachedEvents(); }, delay);
  }

  async function downloadRelease(feed) {
    const metadata = await verifyFeedMetadata(feed);
    const paths = metadata.manifests.flatMap(({ paths: datasetPaths }) => datasetPaths);
    const documents = new Array(paths.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex++;
        if (!isSafeChunkPath(paths[index])) {
          throw new Error('告警分塊路徑不安全');
        }
        documents[index] = { path: paths[index], chunk: await requestJson(`/${paths[index]}`, 8 * 1024 * 1024) };
      }
    }));
    return verifyGovernmentFeedRelease(feed, documents);
  }

  async function loadNLSCGovernmentFeed() {
    let cached = null;
    try {
      const stored = await readCachedRelease();
      if (stored) {
        const verified = await verifyCachedRelease(stored);
        cached = verified;
        if (verified.events.length !== stored.events.length) {
          await writeCachedRelease({
            revision: verified.revision,
            hash: verified.hash,
            feed: verified.feed,
            events: verified.events,
          });
        }
      }
    } catch (_) {
      cached = null;
      try { await clearCachedRelease(); } catch (_) { /* Storage may be unavailable. */ }
    }

    try {
      const feed = await requestJson('/feed.json', 8 * 1024 * 1024);
      const release = await downloadRelease(feed);
      if (cached && (release.revision < cached.revision ||
          release.revision === cached.revision && release.hash !== cached.hash)) {
        throw new Error('告警 feed 版本回退或衝突');
      }
      try {
        await writeCachedRelease({
          revision: release.revision,
          hash: release.hash,
          feed: release.feed,
          events: release.events,
        });
      } catch (_) {
        // Verified online alerts remain usable when browser storage is full or disabled.
      }
      scheduleCachePrune(release.events);
      return JSON.stringify({ revision: release.revision, stale: false, warning: null, events: release.events });
    } catch (_) {
      if (cached) {
        scheduleCachePrune(cached.events);
        return JSON.stringify({
          revision: cached.revision,
          stale: true,
          warning: '告警更新暫不可用，顯示上次驗證且尚未到期的資料。',
          events: cached.events,
        });
      }
      throw new Error('目前無法取得已驗簽的告警資料');
    }
  }

  global.ResilientGeoGovernmentFeed = {
    verifyFeedMetadata,
    verifyGovernmentFeedRelease,
  };
  global.loadNLSCGovernmentFeed = loadNLSCGovernmentFeed;
})(globalThis);
