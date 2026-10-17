import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadGovernmentApiConfig } from '../src/government/config.mjs';

const database = 'postgresql://government:secret@government-postgres:5432/resilientgeo';

test('government API loads only the trusted public signing key needed to verify device certificates', () => {
  const config = loadGovernmentApiConfig({
    DATABASE_URL: database,
    SIGNING_KEY_ID: 'government-feed-2026',
    SIGNING_PUBLIC_KEY_PATH: '/run/secrets/signing_public_key',
  });

  assert.equal(config.signingKeyId, 'government-feed-2026');
  assert.equal(config.signingPublicKeyPath, '/run/secrets/signing_public_key');
  assert.equal('signingPrivateKeyPath' in config, false);
});

test('government API refuses to start without an issuer trust anchor', () => {
  assert.throws(() => loadGovernmentApiConfig({ DATABASE_URL: database }), /SIGNING_PUBLIC_KEY/u);
  assert.throws(() => loadGovernmentApiConfig({
    DATABASE_URL: database,
    SIGNING_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----',
  }), /SIGNING_KEY_ID/u);
});
