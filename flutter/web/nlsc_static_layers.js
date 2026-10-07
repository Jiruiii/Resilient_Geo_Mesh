(function installNLSCStaticLayers(global) {
  const encoder = new TextEncoder();
  const payloadFields = [
    'namespace', 'dataset_id', 'layer_id', 'feature_id', 'feature_type',
    'geometry', 'properties', 'source', 'source_version', 'issued_at', 'expires_at',
  ];
  const chunkFields = [
    'dataset_id', 'layer_id', 'namespace', 'dataset_version', 'sequence',
    'priority', 'created_at', 'content_type', 'content_encoding', 'features',
  ];
  const layerIds = ['taiwan-shelter', 'taiwan-medical', 'taiwan-medical-directory'];
  const requiredLayerIds = ['taiwan-shelter', 'taiwan-medical'];
  let trustedKeysPromise;

  function utf8Compare(left, right) {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  }

  function canonicalize(value) {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite signed value');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(utf8Compare);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
    }
    throw new TypeError('unsupported signed value');
  }

  function hex(bytes) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    return `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`;
  }

  function fromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function publicKey(keyId) {
    const trusted = await trustedKeys();
    const encoded = trusted[keyId];
    if (!encoded) throw new Error(`未信任的靜態資料簽章金鑰：${keyId}`);
    return crypto.subtle.importKey('spki', fromBase64(encoded), { name: 'Ed25519' }, false, ['verify']);
  }

  async function trustedKeys() {
    if (!trustedKeysPromise) {
      trustedKeysPromise = fetch(new URL('/assets/assets/data/trusted-keys.json', global.location.origin), {
        cache: 'force-cache',
      }).then(async (response) => {
        if (!response.ok) throw new Error('無法載入靜態資料信任金鑰');
        const keys = await response.json();
        if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('靜態資料信任金鑰格式錯誤');
        return keys;
      });
    }
    return trustedKeysPromise;
  }

  async function verifySigned(value, keyId, signature) {
    const key = await publicKey(keyId);
    return crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64(signature),
      encoder.encode(canonicalize(value)),
    );
  }

  function omit(value, fields) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
  }

  function selectFields(value, fields) {
    return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
  }

  async function verifyFeature(feature) {
    const directoryEntry = feature?.layer_id === 'taiwan-medical-directory' &&
      feature?.feature_type === 'MEDICAL_DIRECTORY_ENTRY';
    if (!feature || feature.schema_version !== 'feature-v0' ||
        (!directoryEntry && (!feature.geometry || typeof feature.geometry !== 'object')) ||
        (directoryEntry && (feature.geometry !== null ||
          !['located', 'unresolved', 'excluded'].includes(feature.properties?.geometry_status) ||
          (feature.properties.geometry_status === 'located' && typeof feature.properties.point_feature_id !== 'string') ||
          (feature.properties.geometry_status !== 'located' && feature.properties.point_feature_id !== null))) ||
        !feature.properties || typeof feature.properties !== 'object' ||
        feature.signature_algorithm !== 'Ed25519' || typeof feature.payload_hash !== 'string') {
      throw new Error('靜態圖層內含無效圖徵');
    }
    const payload = selectFields(feature, payloadFields);
    if (await sha256(canonicalize(payload)) !== feature.payload_hash) throw new Error('圖徵雜湊驗證失敗');
    if (!await verifySigned({ ...payload, payload_hash: feature.payload_hash }, feature.signing_key_id, feature.signature)) {
      throw new Error('圖徵簽章驗證失敗');
    }
    return payload;
  }

  async function verifyLayerBundle(bundle, expectedLayerId) {
    const manifest = bundle?.manifest;
    const chunks = bundle?.chunks;
    if (!manifest || manifest.schema_version !== 'layer-manifest-v0' || manifest.layer_id !== expectedLayerId ||
        !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 ||
        !Array.isArray(chunks) || chunks.length !== manifest.chunks.length ||
        manifest.signature_algorithm !== 'Ed25519') {
      throw new Error(`靜態圖層 ${expectedLayerId} 契約不符`);
    }
    if (await sha256(canonicalize(omit(manifest, ['manifest_hash', 'signature']))) !== manifest.manifest_hash) {
      throw new Error('圖層清單雜湊驗證失敗');
    }
    if (!await verifySigned(omit(manifest, ['signature']), manifest.signing_key_id, manifest.signature)) {
      throw new Error('圖層清單簽章驗證失敗');
    }

    const allPayloads = [];
    const allFeatures = [];
    let totalSize = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const expected = manifest.chunks[index];
      if (!chunk || chunk.schema_version !== 'layer-chunk-v0' || chunk.sequence !== index ||
          chunk.layer_id !== expectedLayerId || chunk.manifest_id !== manifest.manifest_id ||
          chunk.manifest_hash !== manifest.manifest_hash || !Array.isArray(chunk.features) ||
          chunk.feature_count !== chunk.features.length || chunk.chunk_id !== expected.chunk_id ||
          chunk.chunk_hash !== expected.chunk_hash || chunk.feature_count !== expected.feature_count) {
        throw new Error('靜態圖層分塊與簽章清單不一致');
      }
      const content = selectFields(chunk, chunkFields);
      const contentText = canonicalize(content);
      const contentBytes = encoder.encode(contentText);
      if (await sha256(contentText) !== chunk.chunk_hash || contentBytes.length !== chunk.byte_length) {
        throw new Error('靜態圖層分塊雜湊或大小驗證失敗');
      }
      if (!await verifySigned(omit(chunk, ['signature']), chunk.signing_key_id, chunk.signature)) {
        throw new Error('靜態圖層分塊簽章驗證失敗');
      }
      const payloads = [];
      for (const feature of chunk.features) {
        if (feature.layer_id !== expectedLayerId || feature.dataset_id !== manifest.dataset_id) {
          throw new Error('靜態圖徵與所屬圖層不符');
        }
        const payload = await verifyFeature(feature);
        payloads.push(payload);
        allPayloads.push(payload);
        allFeatures.push(feature);
      }
      if (JSON.stringify(expected.feature_ids) !== JSON.stringify(chunk.features.map((feature) => feature.feature_id))) {
        throw new Error('靜態圖徵 ID 與清單不一致');
      }
      totalSize += chunk.byte_length;
    }
    if (allFeatures.length !== manifest.total_feature_count || totalSize !== manifest.total_size_bytes ||
        await sha256(canonicalize(allPayloads)) !== manifest.content_hash) {
      throw new Error('靜態圖層總筆數或內容雜湊驗證失敗');
    }
    return { manifest, chunks, features: allFeatures };
  }

  function mapFeature(feature) {
    const isMedicalPoint = feature.layer_id === 'taiwan-medical' ||
      feature.layer_id === 'medical' ||
      ['HOSPITAL', 'CLINIC', 'MEDICAL_FACILITY'].includes(feature.feature_type);
    const kind = feature.feature_type === 'SHELTER' ? 'shelter' :
      feature.feature_type === 'MEDICAL_DIRECTORY_ENTRY' ? 'medical-directory' :
      isMedicalPoint ? 'medical' : 'poi';
    return {
      id: feature.feature_id,
      kind,
      geometry: feature.geometry,
      properties: feature.properties,
      name: feature.properties.name ?? null,
      address: feature.properties.address ?? null,
      phone: feature.properties.phone ?? null,
      departments: feature.properties.departments ?? null,
      capacity: feature.properties.capacity ?? null,
      disaster_types: feature.properties.disaster_types ?? null,
      administrative_area: feature.properties.administrative_area ?? null,
      facility_type: feature.properties.facility_type ?? null,
      coordinate_source: feature.properties.coordinate_source ?? null,
      county_code: feature.properties.county_code ?? null,
      town_code: feature.properties.town_code ?? null,
      coverage: feature.properties.coverage ?? null,
    };
  }

  function linkDirectoryPoints(features) {
    const medicalPoints = new Map(features
      .filter((feature) => feature.kind === 'medical' && feature.id && feature.geometry?.type === 'Point')
      .map((feature) => [feature.id, feature.geometry]));
    for (const feature of features) {
      if (feature.kind !== 'medical-directory') continue;
      const properties = feature.properties ?? {};
      feature.geometry = properties.geometry_status === 'located'
        ? medicalPoints.get(properties.point_feature_id) ?? null
        : null;
    }
    return features;
  }

  async function readJson(directory, name) {
    try {
      const handle = await directory.getFileHandle(name);
      return JSON.parse(await (await handle.getFile()).text());
    } catch {
      return null;
    }
  }

  async function writeBytes(directory, name, bytes) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    await writer.write(bytes);
    await writer.close();
  }

  async function readCachedBundle(directory, pointerEntry, layerId) {
    if (!pointerEntry || typeof pointerEntry.filename !== 'string') return null;
    const saved = await readJson(directory, pointerEntry.filename);
    if (!saved?.bundle || await sha256(canonicalize(saved.bundle)) !== pointerEntry.sha256) return null;
    return verifyLayerBundle(saved.bundle, layerId);
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`靜態資料更新失敗 (${response.status})`);
    return response.json();
  }

  const addressProgress = new Map();
  const addressCountyCodePattern = /^\d{5}$/u;
  const addressFilePattern = /^address-\d{5}-[a-f0-9]{16}\.ndjson\.gz$/u;

  async function addressDirectory() {
    if (!global.isSecureContext || !global.navigator?.storage?.getDirectory) {
      throw new Error('此瀏覽器不支援可離線保存門牌索引的 OPFS');
    }
    const root = await global.navigator.storage.getDirectory();
    return root.getDirectoryHandle('resilientgeo-address-packs', { create: true });
  }

  function validateAddressCatalog(catalog) {
    if (!catalog || catalog.schema_version !== 'address-pack-catalog-v1' ||
        catalog.signature_algorithm !== 'Ed25519' || !Array.isArray(catalog.counties) ||
        catalog.counties.length !== 22 || typeof catalog.signing_key_id !== 'string' ||
        typeof catalog.signature !== 'string') {
      throw new Error('門牌索引目錄格式無效');
    }
    const seen = new Set();
    for (const county of catalog.counties) {
      if (!county || !addressCountyCodePattern.test(county.county_code ?? '') ||
          typeof county.county_name !== 'string' || seen.has(county.county_code) ||
          !['complete', 'partial', 'unavailable'].includes(county.coverage_status)) {
        throw new Error('門牌索引目錄縣市清單無效');
      }
      seen.add(county.county_code);
      if (county.coverage_status === 'unavailable') {
        if (county.manifest_url != null || county.manifest_sha256 != null) {
          throw new Error('未涵蓋縣市不能刊登門牌資料包');
        }
      } else if (typeof county.manifest_url !== 'string' ||
          !county.manifest_url.startsWith('/address-packs/') ||
          !/^sha256:[a-f0-9]{64}$/u.test(county.manifest_sha256 ?? '')) {
        throw new Error('已涵蓋縣市缺少已簽章的門牌資料清單');
      }
    }
    return catalog;
  }

  async function verifyAddressCatalog(catalog) {
    validateAddressCatalog(catalog);
    if (!await verifySigned(omit(catalog, ['signature']), catalog.signing_key_id, catalog.signature)) {
      throw new Error('門牌索引目錄簽章驗證失敗');
    }
    return catalog;
  }

  async function loadNLSCAddressCatalog() {
    const directory = await addressDirectory();
    const cached = await readJson(directory, 'current.json');
    try {
      const catalog = await fetchJson(new URL('/address-packs/catalog.json', global.location.origin));
      await verifyAddressCatalog(catalog);
      const next = { ...(cached || {}), catalog, updated_at: new Date().toISOString() };
      await writeBytes(directory, 'current.json', encoder.encode(JSON.stringify(next)));
      return JSON.stringify(catalog);
    } catch (networkOrTrustError) {
      if (!cached?.catalog) throw networkOrTrustError;
      await verifyAddressCatalog(cached.catalog);
      return JSON.stringify(cached.catalog);
    }
  }

  async function verifyAddressManifest(manifest, county, pinnedHash) {
    if (!manifest || manifest.schema_version !== 'address-pack-manifest-v1' ||
        manifest.county_code !== county.county_code || manifest.coverage_status !== county.coverage_status ||
        manifest.signature_algorithm !== 'Ed25519' || typeof manifest.signing_key_id !== 'string' ||
        manifest.data_format !== 'application/x-ndjson' ||
        !addressFilePattern.test(manifest.data_file ?? '') || !Number.isSafeInteger(manifest.size_bytes) ||
        manifest.size_bytes <= 0 || !/^sha256:[a-f0-9]{64}$/u.test(manifest.sha256 ?? '') ||
        manifest.source_count !== county.source_count || manifest.located_count !== county.located_count ||
        manifest.unlocated_count !== county.unlocated_count || manifest.excluded_count !== county.excluded_count ||
        manifest.source_count !== manifest.located_count + manifest.unlocated_count + manifest.excluded_count) {
      throw new Error('門牌資料清單與簽章目錄不一致');
    }
    if (await sha256(canonicalize(manifest)) !== pinnedHash) throw new Error('門牌資料清單雜湊驗證失敗');
    if (!await verifySigned(omit(manifest, ['signature']), manifest.signing_key_id, manifest.signature)) {
      throw new Error('門牌資料清單簽章驗證失敗');
    }
    return manifest;
  }

  async function fetchAddressData(url, partialHandle, expectedSize, onProgress) {
    const partialFile = await partialHandle.getFile();
    if (partialFile.size === expectedSize) return new Uint8Array(await partialFile.arrayBuffer());
    let start = Math.min(partialFile.size, expectedSize);
    if (partialFile.size > expectedSize) start = 0;
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    let response = await fetch(url, { headers, cache: 'no-store' });
    let append = false;
    if (start > 0 && response.status === 206 &&
        response.headers.get('Content-Range')?.startsWith(`bytes ${start}-`)) {
      append = true;
    } else if (response.status === 200) {
      start = 0;
    } else if (!response.ok) {
      throw new Error(`門牌資料下載失敗 (${response.status})`);
    } else {
      throw new Error('門牌資料伺服器未正確回應續傳範圍');
    }
    const writer = await partialHandle.createWritable({ keepExistingData: append });
    if (append) await writer.seek(start);
    else await writer.truncate(0);
    let loaded = start;
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      await writer.write(buffer);
      loaded += buffer.byteLength;
      onProgress?.(loaded, expectedSize);
    } else {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await writer.write(value);
          loaded += value.byteLength;
          addressProgress.set(url.countyCode, { state: 'downloading', loaded, total: expectedSize });
          onProgress?.(loaded, expectedSize);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await writer.close();
    const file = await partialHandle.getFile();
    if (file.size !== expectedSize) throw new Error(`門牌資料大小不符：收到 ${file.size}，預期 ${expectedSize}`);
    return new Uint8Array(await file.arrayBuffer());
  }

  async function* addressLines(source) {
    const compressed = source instanceof Blob ? source : new Blob([source]);
    const stream = compressed.stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        let separator;
        while ((separator = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, separator).replace(/\r$/u, '');
          pending = pending.slice(separator + 1);
          if (line.trim()) yield line;
        }
        if (done) break;
      }
      if (pending.trim()) yield pending;
    } finally {
      reader.releaseLock();
    }
  }

  async function decodeAddressPack(bytes, manifest, { verifyHash = true, onRecord } = {}) {
    if (verifyHash) {
      const compressed = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
      if (await sha256(compressed) !== manifest.sha256) throw new Error('門牌資料 SHA-256 驗證失敗');
    }
    let header;
    let count = 0;
    for await (const line of addressLines(bytes)) {
      const record = JSON.parse(line);
      if (!header) {
        header = record;
        if (header.schema_version !== 'address-pack-ndjson-v1' || header.county_code !== manifest.county_code ||
            header.summary?.located_count !== manifest.located_count) {
          throw new Error('門牌資料內容與簽章清單不一致');
        }
        continue;
      }
      const coordinate = record.coordinate;
      if (record.county_code !== manifest.county_code || !Array.isArray(coordinate) || coordinate.length !== 2 ||
          !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
          coordinate[0] < 118 || coordinate[0] > 122.2 || coordinate[1] < 21.8 || coordinate[1] > 26.5) {
        throw new Error('門牌資料包含無效縣市或台灣範圍外的座標');
      }
      count += 1;
      onRecord?.(record);
    }
    if (!header || count !== manifest.located_count) throw new Error('門牌資料筆數與簽章清單不一致');
    return header;
  }

  async function readInstalledAddressPacks() {
    const directory = await addressDirectory();
    const current = await readJson(directory, 'current.json');
    const catalog = current?.catalog;
    if (!catalog || !current.counties) return JSON.stringify({ counties: [], records: [] });
    await verifyAddressCatalog(catalog);
    const counties = [];
    for (const [countyCode, entry] of Object.entries(current.counties)) {
      try {
        const county = catalog.counties.find((item) => item.county_code === countyCode);
        if (!county || county.coverage_status === 'unavailable') continue;
        const manifest = entry.manifest;
        await verifyAddressManifest(manifest, county, county.manifest_sha256);
        if (entry.filename !== manifest.data_file) continue;
        const file = await (await directory.getFileHandle(entry.filename)).getFile();
        if (file.size !== manifest.size_bytes) continue;
        counties.push(countyCode);
      } catch (_) {
        // A damaged cache is ignored. A later download can replace it atomically.
      }
    }
    return JSON.stringify({ counties });
  }

  async function downloadNLSCAddressPack(countyCode) {
    addressProgress.set(countyCode, { state: 'checking', loaded: 0, total: 0 });
    try {
      const directory = await addressDirectory();
      await loadNLSCAddressCatalog();
      const current = await readJson(directory, 'current.json') || {};
      const catalog = current.catalog;
      const county = catalog?.counties?.find((item) => item.county_code === countyCode);
      if (!county) throw new Error('找不到該縣市的門牌資料目錄');
      if (county.coverage_status === 'unavailable') throw new Error(`${county.county_name} 尚無可下載的門牌索引`);
      const manifestUrl = new URL(county.manifest_url, global.location.origin);
      if (manifestUrl.origin !== global.location.origin) throw new Error('門牌清單必須來自同一個可信服務');
      const manifest = await fetchJson(manifestUrl);
      await verifyAddressManifest(manifest, county, county.manifest_sha256);
      const dataUrl = new URL(`/address-packs/${manifest.data_file}`, global.location.origin);
      const partial = await directory.getFileHandle(`${manifest.data_file}.partial`, { create: true });
      const bytes = await fetchAddressData(dataUrl, partial, manifest.size_bytes,
        (loaded, total) => addressProgress.set(countyCode, { state: 'downloading', loaded, total }));
      addressProgress.set(countyCode, { state: 'verifying', loaded: bytes.byteLength, total: bytes.byteLength });
      try {
        await decodeAddressPack(bytes, manifest);
      } catch (error) {
        await directory.removeEntry(`${manifest.data_file}.partial`).catch(() => {});
        throw error;
      }
      const finalFile = await directory.getFileHandle(manifest.data_file, { create: true });
      const writer = await finalFile.createWritable({ keepExistingData: false });
      await writer.write(bytes);
      await writer.close();
      await directory.removeEntry(`${manifest.data_file}.partial`).catch(() => {});
      const next = {
        ...current,
        counties: { ...(current.counties || {}), [countyCode]: { filename: manifest.data_file, manifest } },
        updated_at: new Date().toISOString(),
      };
      await writeBytes(directory, 'current.json', encoder.encode(JSON.stringify(next)));
      addressProgress.set(countyCode, { state: 'ready', loaded: bytes.byteLength, total: bytes.byteLength });
      return JSON.stringify({ status: 'ready', county_code: countyCode });
    } catch (error) {
      addressProgress.set(countyCode, { state: 'failed', loaded: 0, total: 0, message: error.message });
      throw error;
    }
  }

  const verifiedAddressFiles = new Set();
  async function searchNLSCAddressPacks(query) {
    const normalized = String(query || '').normalize('NFKC').replaceAll('台', '臺')
      .replace(/[\s\u3000，,、]/gu, '').toLowerCase();
    if (normalized.length < 2) return JSON.stringify({ results: [] });
    const directory = await addressDirectory();
    const current = await readJson(directory, 'current.json');
    const catalog = current?.catalog;
    if (!catalog || !current.counties) return JSON.stringify({ results: [] });
    await verifyAddressCatalog(catalog);
    const results = new Map();
    for (const [countyCode, entry] of Object.entries(current.counties)) {
      const county = catalog.counties.find((item) => item.county_code === countyCode);
      if (!county || county.coverage_status === 'unavailable') continue;
      const manifest = entry.manifest;
      await verifyAddressManifest(manifest, county, county.manifest_sha256);
      if (entry.filename !== manifest.data_file) continue;
      const file = await (await directory.getFileHandle(entry.filename)).getFile();
      if (file.size !== manifest.size_bytes) continue;
      const cacheKey = `${entry.filename}:${file.size}:${file.lastModified}`;
      const needsHash = !verifiedAddressFiles.has(cacheKey);
      const source = needsHash ? new Uint8Array(await file.arrayBuffer()) : file;
      const matches = [];
      await decodeAddressPack(source, manifest, {
        verifyHash: needsHash,
        onRecord(record) {
          const keys = [record.search_key, record.address, ...(record.aliases || [])]
            .filter((value) => typeof value === 'string').map((value) => value.normalize('NFKC')
              .replaceAll('台', '臺').replace(/[\s\u3000，,、]/gu, '').toLowerCase());
          if (!keys.some((key) => key.includes(normalized))) return;
          if (results.has(record.id)) return;
          matches.push({
            id: record.id, name: record.name, aliases: record.aliases || [], kind: 'address',
            region: record.region, coordinate: record.coordinate, address: record.address,
            search_key: record.search_key,
          });
          if (matches.length > 128) {
            matches.sort((left, right) => (left.search_key || '').localeCompare(right.search_key || ''));
            matches.length = 64;
          }
        },
      });
      verifiedAddressFiles.add(cacheKey);
      matches.sort((left, right) => {
        const leftKey = left.search_key || '';
        const rightKey = right.search_key || '';
        const leftScore = leftKey === normalized ? 0 : leftKey.startsWith(normalized) ? 1 : 2;
        const rightScore = rightKey === normalized ? 0 : rightKey.startsWith(normalized) ? 1 : 2;
        return leftScore - rightScore || leftKey.localeCompare(rightKey);
      });
      for (const match of matches) {
        if (results.size >= 8) break;
        results.set(match.id, match);
      }
      if (results.size >= 8) break;
    }
    return JSON.stringify({ results: [...results.values()] });
  }

  function getNLSCAddressPackProgress(countyCode) {
    return JSON.stringify(addressProgress.get(countyCode) || { state: 'idle', loaded: 0, total: 0 });
  }

  async function fetchLayer(directory, layerId, previousEntry) {
    const base = new URL(`/v1/layers/${layerId}/`, global.location.origin);
    const manifest = await fetchJson(new URL('manifest.json', base));
    if (manifest.layer_id !== layerId) throw new Error('伺服器回傳了不同的靜態圖層');
    if (previousEntry?.manifest_hash === manifest.manifest_hash) {
      const cached = await readCachedBundle(directory, previousEntry, layerId);
      if (cached) return cached;
    }
    if (manifest.chunks.length > 512) throw new Error('靜態圖層分塊數超出上限');
    const chunks = await Promise.all(manifest.chunks.map((entry) =>
      fetchJson(new URL(`chunks/${entry.sequence}.json`, base))));
    const verified = await verifyLayerBundle({ manifest, chunks }, layerId);
    const bundle = { manifest, chunks };
    const bytes = encoder.encode(JSON.stringify({ bundle }));
    const digest = await sha256(canonicalize(bundle));
    const filename = `${layerId}-${manifest.dataset_version}-${manifest.manifest_hash.slice(7, 19)}.json`;
    const partial = `${filename}.partial`;
    await writeBytes(directory, partial, bytes);
    const partialValue = await readJson(directory, partial);
    if (!partialValue || await sha256(canonicalize(partialValue.bundle)) !== digest) {
      throw new Error('靜態資料本機寫入驗證失敗');
    }
    const partialFile = await directory.getFileHandle(partial);
    const finalFile = await directory.getFileHandle(filename, { create: true });
    const file = await partialFile.getFile();
    const finalWriter = await finalFile.createWritable({ keepExistingData: false });
    await finalWriter.write(await file.arrayBuffer());
    await finalWriter.close();
    await directory.removeEntry(partial);
    return { ...verified, cacheEntry: { filename, sha256: digest, manifest_hash: manifest.manifest_hash } };
  }

  async function loadNLSCStaticLayers() {
    if (!global.isSecureContext || !global.navigator?.storage?.getDirectory) return '';
    const root = await global.navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('resilientgeo-static-layers', { create: true });
    const current = await readJson(directory, 'current.json') || { layers: {} };
    const bundles = {};
    const next = { layers: { ...current.layers }, updated_at: new Date().toISOString() };
    for (const layerId of layerIds) {
      let bundle;
      try {
        bundle = await fetchLayer(directory, layerId, current.layers[layerId]);
      } catch (networkError) {
        bundle = await readCachedBundle(directory, current.layers[layerId], layerId);
        if (!bundle && requiredLayerIds.includes(layerId)) throw networkError;
        if (!bundle) continue;
      }
      if (bundle.cacheEntry) next.layers[layerId] = bundle.cacheEntry;
      bundles[layerId] = bundle;
    }
    await writeBytes(directory, 'current.json', encoder.encode(JSON.stringify(next)));
    const features = linkDirectoryPoints(
      layerIds.flatMap((layerId) => (bundles[layerId]?.features ?? []).map(mapFeature)),
    );
    const snapshotAt = layerIds.map((layerId) => bundles[layerId]?.manifest.created_at).filter(Boolean).sort().at(-1) || null;
    return JSON.stringify({ schema_version: 'feature-v0', dataset_id: 'resilientgeo-taiwan', snapshot_at: snapshotAt, features });
  }

  global.ResilientGeoNLSCStatic = {
    canonicalize, verifyLayerBundle, linkDirectoryPoints, verifySigned, sha256,
    verifyAddressCatalog, verifyAddressManifest, mapFeature,
  };
  global.loadNLSCStaticLayers = loadNLSCStaticLayers;
  global.loadNLSCAddressCatalog = loadNLSCAddressCatalog;
  global.loadInstalledNLSCAddressPacks = readInstalledAddressPacks;
  global.downloadNLSCAddressPack = downloadNLSCAddressPack;
  global.searchNLSCAddressPacks = searchNLSCAddressPacks;
  global.getNLSCAddressPackProgress = getNLSCAddressPackProgress;
})(globalThis);
