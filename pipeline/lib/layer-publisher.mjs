import { buildFeatureBundle } from './feature-bundle.mjs';
import { signFeature } from './feature-contract.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function requireFeatureList(features) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new TypeError('buildSignedLayer requires features');
  }
}

function requireLayerId(layerId) {
  if (typeof layerId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(layerId)) {
    throw new TypeError('layerId must be a safe layer identifier');
  }
}

/**
 * Sign normalized static features and build the repository's existing layer
 * bundle contract. The caller supplies the server key; no client trust asset is
 * consulted here.
 */
export function buildSignedLayer(features, {
  layerId,
  privateKey,
  signingKeyId,
  datasetId,
  namespace,
  source,
  sourceVersion,
  datasetVersion = 1,
  createdAt,
  expiresAt,
  now = new Date(),
  priority,
  targetSizeBytes,
} = {}) {
  requireFeatureList(features);
  requireLayerId(layerId);
  if (!privateKey) throw new TypeError('buildSignedLayer requires a private key');
  if (typeof signingKeyId !== 'string' || signingKeyId.length === 0) {
    throw new TypeError('buildSignedLayer requires signingKeyId');
  }
  if (!Number.isSafeInteger(datasetVersion) || datasetVersion < 1) {
    throw new TypeError('buildSignedLayer requires a positive datasetVersion');
  }

  const first = features[0];
  if (features.some((feature) => feature?.layer_id !== layerId)) {
    throw new TypeError(`all features must have layer_id=${layerId}`);
  }
  const signedFeatures = features.map((feature) => {
    const unsigned = {
      ...feature,
      signing_key_id: signingKeyId,
    };
    delete unsigned.payload_hash;
    delete unsigned.signature;
    return signFeature(unsigned, privateKey);
  });
  const created = createdAt ?? now.toISOString();
  const expires = expiresAt ?? new Date(new Date(created).getTime() + DAY_MS).toISOString();
  return buildFeatureBundle(signedFeatures, {
    datasetId: datasetId ?? first.dataset_id,
    layerId,
    namespace: namespace ?? first.namespace,
    source: source ?? first.source,
    sourceVersion: sourceVersion ?? first.source_version,
    datasetVersion,
    createdAt: created,
    expiresAt: expires,
    signingKeyId,
    privateKey,
    priority,
    targetSizeBytes,
  });
}
