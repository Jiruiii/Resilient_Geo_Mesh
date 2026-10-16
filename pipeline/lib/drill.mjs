import { signEvent } from './contract.mjs';
import { buildBundle } from './bundle.mjs';

export const DRILL_KEY_ID = 'exercise-local-v1';
export const DRILL_NAMESPACE = 'drill.exercise';
const allowed = { SHELTER_STATUS: ['OPEN', 'FULL', 'CLOSED'], ROAD_STATUS: ['OPEN', 'CLOSED', 'PARTIAL'], SUPPLY_STATUS: ['AVAILABLE', 'PAUSED', 'EXHAUSTED', 'CLOSED', 'UNKNOWN'] };
const text = (value, max = 160) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

export function validateDrillInput(input) {
  if (!input || !text(input.id, 80) || !/^[a-z0-9][a-z0-9:-]*$/.test(input.id)) throw new Error('請輸入有效的識別碼（英文小寫、數字、冒號或連字號）');
  if (!allowed[input.type]?.includes(input.status)) throw new Error('資料類別或狀態無效');
  if (input.type === 'ROAD_STATUS' && !/^road:w\d+(?:-|$)/.test(input.id)) throw new Error('道路識別碼須為 road:w<OSM way id>，才能對應離線路網；位置標記本身不會封路');
  if (!text(input.name) || !text(input.area, 64)) throw new Error('請填寫名稱與區域');
  if (!Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180 || !Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new Error('經緯度無效');
  if (!Number.isInteger(input.ttl_minutes) || input.ttl_minutes < 1 || input.ttl_minutes > 1440) throw new Error('有效時間必須為 1～1440 分鐘');
  if (input.quantity != null && (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 1000000)) throw new Error('數量請填非負整數，或留空表示未知');
  if (input.items != null && (!Array.isArray(input.items) || input.items.length > 20 || !input.items.every(v => text(v, 40)))) throw new Error('物資種類無效');
  for (const key of ['address', 'opening_hours', 'issuer']) if (input[key] != null && !text(input[key])) throw new Error(`${key} 無效`);
  return input;
}

export function publishDrill(state, input, privateKey, now = new Date()) {
  validateDrillInput(input);
  if (state.events.length >= 200 && !state.events.some(e => e.event_id === input.id)) throw new Error('單次演練上限 200 筆');
  const previous = state.events.find(e => e.event_id === input.id);
  if (previous && previous.event_type !== input.type) throw new Error('同一識別碼不能改變資料類別');
  const issued = now.toISOString(), expires = new Date(now.getTime() + input.ttl_minutes * 60000).toISOString();
  const attrs = { exercise: true, name: input.name.trim(), area_id: input.area.trim(), theme: input.type.toLowerCase(), status: input.status, issuer: input.issuer ?? '演練應變小組' };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(attrs.area_id)) throw new Error('區域代碼請使用英文小寫、數字、點或連字號');
  if (input.type === 'SHELTER_STATUS') attrs.available = input.status === 'FULL' ? 0 : input.quantity ?? null;
  if (input.type === 'SUPPLY_STATUS') Object.assign(attrs, { items: input.items ?? [], quantity: input.quantity ?? null, unit: '份', address: input.address ?? '演練座標', opening_hours: input.opening_hours ?? '依演練公告' });
  const event = signEvent({ schema_version: 'event-v0', namespace: DRILL_NAMESPACE, event_id: input.id,
    event_type: input.type, geometry: { type: 'Point', coordinates: [input.lon, input.lat] },
    severity: input.type === 'SUPPLY_STATUS' ? 'MEDIUM' : 'HIGH', source: 'EXERCISE_ONLY',
    source_version: String(state.version + 1), event_version: (previous?.event_version ?? 0) + 1,
    issued_at: issued, expires_at: expires, attributes: attrs, signing_key_id: DRILL_KEY_ID,
    provenance: { original_source: 'local-exercise-console', received_at: issued, transport_source: { kind: 'local_fixture' } },
  }, privateKey);
  return { version: state.version + 1, events: [...state.events.filter(e => e.event_id !== input.id), event] };
}

export function drillBundle(state, privateKey, publicKey) {
  const trusted_keys = { [DRILL_KEY_ID]: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  if (!state.events.length) return { exercise: true, version: state.version, trusted_keys, chunks: [] };
  const createdAt = state.events.map(e => e.issued_at).sort().at(-1);
  const expiresAt = state.events.map(e => e.expires_at).sort().at(-1);
  return { exercise: true, version: state.version, trusted_keys,
    ...buildBundle(state.events, { datasetId: 'exercise-local', namespace: DRILL_NAMESPACE,
      datasetVersion: state.version, source: 'EXERCISE_ONLY', sourceVersion: String(state.version),
      createdAt, expiresAt, signingKeyId: DRILL_KEY_ID, privateKey }),
  };
}
