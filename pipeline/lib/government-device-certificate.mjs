import { deviceKeyIdFromSpkiBase64, parseDevicePublicKey } from './device-key.mjs';
import { signCanonical, verifyCanonical } from './crypto.mjs';

export const GOVERNMENT_DEVICE_CERTIFICATE_SCHEMA = 'government-device-certificate-v1';
export const GOVERNMENT_DEVICE_WARNING_PERMISSION = 'official.announcement.publish';
export const GOVERNMENT_DEVICE_CERTIFICATE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

const REQUIRED_FIELDS = [
  'schema_version', 'certificate_id', 'device_id', 'subject_id',
  'signing_key_id', 'signer_public_key', 'agency', 'permissions',
  'issued_at', 'expires_at', 'issuer_key_id', 'signature_algorithm', 'signature',
];
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRfc3339(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function unsignedCertificate(certificate) {
  const { signature, ...unsigned } = certificate;
  return unsigned;
}

function publicKeyForIssuer(certificate, fallbackPublicKey, options) {
  const issuerKeyId = certificate.issuer_key_id;
  const trustedKeyIds = options.trustedKeyIds;
  if (Array.isArray(trustedKeyIds) && trustedKeyIds.length > 0 && !trustedKeyIds.includes(issuerKeyId)) return null;

  const trustedKeys = options.trustedKeys;
  const mappedKey = trustedKeys instanceof Map
    ? trustedKeys.get(issuerKeyId)
    : trustedKeys?.[issuerKeyId];
  if (mappedKey) return mappedKey;

  if (fallbackPublicKey && Array.isArray(trustedKeyIds) && trustedKeyIds.includes(issuerKeyId)) return fallbackPublicKey;
  if (fallbackPublicKey && (!Array.isArray(trustedKeyIds) || trustedKeyIds.length === 0)
    && (!options.issuerKeyId || options.issuerKeyId === issuerKeyId)) return fallbackPublicKey;
  return null;
}

function shapeErrors(certificate) {
  if (!isRecord(certificate)) return ['certificate must be an object'];
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in certificate)) errors.push(`missing required field: ${field}`);
  }
  if (certificate.schema_version !== GOVERNMENT_DEVICE_CERTIFICATE_SCHEMA) errors.push('certificate schema_version is invalid');
  for (const field of ['certificate_id', 'device_id', 'subject_id', 'signing_key_id', 'signer_public_key', 'agency', 'issuer_key_id']) {
    if (typeof certificate[field] !== 'string' || certificate[field].trim() === '') errors.push(`${field} must be a non-empty string`);
  }
  if (typeof certificate.signer_public_key === 'string') {
    const signerPublicKey = parseDevicePublicKey(certificate.signer_public_key);
    if (!signerPublicKey) errors.push('signer_public_key is not an Ed25519 SPKI key');
    if (signerPublicKey && deviceKeyIdFromSpkiBase64(certificate.signer_public_key) !== certificate.signing_key_id) {
      errors.push('signing_key_id does not match signer_public_key fingerprint');
    }
  }
  if (!Array.isArray(certificate.permissions) || !certificate.permissions.every((permission) => typeof permission === 'string')) {
    errors.push('permissions must be an array of strings');
  } else if (!certificate.permissions.includes(GOVERNMENT_DEVICE_WARNING_PERMISSION)) {
    errors.push('certificate lacks official announcement publish permission');
  }
  const issuedAt = parseRfc3339(certificate.issued_at);
  const expiresAt = parseRfc3339(certificate.expires_at);
  if (issuedAt === null) errors.push('issued_at must be an RFC 3339 timestamp');
  if (expiresAt === null) errors.push('expires_at must be an RFC 3339 timestamp');
  if (issuedAt !== null && expiresAt !== null && expiresAt - issuedAt !== GOVERNMENT_DEVICE_CERTIFICATE_VALIDITY_MS) {
    errors.push('government device certificate validity must be exactly seven days');
  }
  if (certificate.signature_algorithm !== 'Ed25519') errors.push('signature_algorithm must be Ed25519');
  if (typeof certificate.signature !== 'string' || certificate.signature.length < 4 || !BASE64_RE.test(certificate.signature)) {
    errors.push('signature must be base64');
  }
  return errors;
}

/** Create a centrally signed seven-day device certificate for publisher use. */
export function signGovernmentDeviceCertificate(fields, signingKey) {
  if (!isRecord(fields)) throw new Error('certificate fields must be an object');
  const issuedAt = parseRfc3339(fields.issued_at);
  if (issuedAt === null) throw new Error('issued_at must be an RFC 3339 timestamp');
  const certificate = {
    schema_version: GOVERNMENT_DEVICE_CERTIFICATE_SCHEMA,
    certificate_id: fields.certificate_id,
    device_id: fields.device_id,
    subject_id: fields.subject_id,
    signing_key_id: fields.signing_key_id,
    signer_public_key: fields.signer_public_key,
    agency: fields.agency,
    permissions: [GOVERNMENT_DEVICE_WARNING_PERMISSION],
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + GOVERNMENT_DEVICE_CERTIFICATE_VALIDITY_MS).toISOString(),
    issuer_key_id: fields.issuer_key_id,
    signature_algorithm: 'Ed25519',
  };
  const errors = shapeErrors({ ...certificate, signature: 'AAAA' });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return { ...certificate, signature: signCanonical(certificate, signingKey) };
}

/** Verify issuer trust, certificate signature, device fingerprint, permission and validity at `at`. */
export function verifyGovernmentDeviceCertificate(certificate, publicKey, options = {}) {
  const errors = shapeErrors(certificate);
  if (errors.length > 0) return { valid: false, errors };
  const issuerPublicKey = publicKeyForIssuer(certificate, publicKey, options);
  if (!issuerPublicKey) return { valid: false, errors: ['certificate issuer is not trusted'] };
  if (!verifyCanonical(unsignedCertificate(certificate), certificate.signature, issuerPublicKey)) {
    return { valid: false, errors: ['certificate_signature_invalid'] };
  }
  const at = parseRfc3339(options.at);
  if (at === null) return { valid: false, errors: ['certificate verification time must be RFC 3339'] };
  const issuedAt = parseRfc3339(certificate.issued_at);
  const expiresAt = parseRfc3339(certificate.expires_at);
  if (at < issuedAt || at >= expiresAt) return { valid: false, errors: ['certificate is not valid at the requested time'] };
  return {
    valid: true,
    errors: [],
    signerPublicKey: parseDevicePublicKey(certificate.signer_public_key),
  };
}
