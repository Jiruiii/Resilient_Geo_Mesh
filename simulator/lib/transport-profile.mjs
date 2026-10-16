import { subStream } from './rng.mjs';

export function validateTransportProfile(profile) {
  if (profile?.schema_version !== 'transport-profile-v1' || profile.transport !== 'WIFI_DIRECT_TCP') throw new Error('unsupported transport profile');
  if (!Array.isArray(profile.setup_ms) || !profile.setup_ms.length || !profile.setup_ms.every(n => Number.isFinite(n) && n >= 0)) throw new Error('setup_ms must contain non-negative observations');
  if (!Number.isFinite(profile.bytes_per_second) || profile.bytes_per_second <= 0) throw new Error('bytes_per_second must be positive');
  if (typeof profile.evidence !== 'string' || !profile.evidence.trim() || typeof profile.throughput_source !== 'string' || !profile.throughput_source.trim()) throw new Error('profile must distinguish setup evidence and throughput assumptions');
  return profile;
}

// Each contact pays setup once and shares its remaining capacity across both
// directions. Protocol overhead / partial chunks are not resumed in this model.
export function contactBudget(profile, seconds, seed, round, a, b) {
  const roll = subStream(seed, 'wifi-setup', round, Math.min(a, b), Math.max(a, b))();
  const setup = profile.setup_ms[Math.floor(roll * profile.setup_ms.length)];
  return Math.floor(Math.max(0, seconds - setup / 1000) * profile.bytes_per_second);
}
