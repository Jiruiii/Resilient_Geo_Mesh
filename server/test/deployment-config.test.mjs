import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

function serviceBlock(compose, service) {
  const match = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:|\\nvolumes:)`, 'u').exec(`\n${compose}`);
  assert.ok(match, `missing compose service: ${service}`);
  return match[1];
}

test('compose defines isolated collector, api, and proxy services with persistent volumes', async () => {
  const compose = await read('deploy/docker-compose.yml');
  const services = [...compose.matchAll(/^  ([a-z][a-z0-9-]*):$/gmu)].map((match) => match[1]);
  assert.deepEqual(services, ['collector', 'api', 'proxy']);
  assert.match(compose, /private_data:/u);
  assert.match(compose, /public_release:/u);
  assert.match(serviceBlock(compose, 'api'), /public_release:[^\n]*:ro|read_only:\s*true/iu);
  assert.doesNotMatch(serviceBlock(compose, 'api'), /private_data/u);
});

test('only collector has write access and upstream/signing secrets stay outside api', async () => {
  const compose = await read('deploy/docker-compose.yml');
  const collector = serviceBlock(compose, 'collector');
  const api = serviceBlock(compose, 'api');
  assert.doesNotMatch(collector, /^    ports:/mu);
  assert.match(collector, /private_data:/u);
  assert.match(collector, /public_release:/u);
  assert.doesNotMatch(api, /TDX_CLIENT_SECRET|CWA_API_KEY|NCDR_ALERT_API_KEY|SIGNING_PRIVATE_KEY_PATH|PRIVATE_DATA_ROOT/u);
  assert.match(compose, /SIGNING_PRIVATE_KEY_PATH|SIGNING_PRIVATE_KEY_FILE/u);
});

test('configured Central Server signer is trusted by Flutter and Android without replacing legacy keys', async () => {
  const [example, flutterKeysText, androidKeysText, androidTestKeysText] = await Promise.all([
    read('server/.env.example'),
    read('flutter/assets/data/trusted-keys.json'),
    read('android/app/src/main/assets/trust/trusted-keys.json'),
    read('android/app/src/test/resources/trust/trusted-keys.json'),
  ]);
  const keyId = /^SIGNING_KEY_ID=(.+)$/mu.exec(example)?.[1];
  assert.equal(keyId, 'central-server-2026');
  const flutterKeys = JSON.parse(flutterKeysText);
  const androidKeys = JSON.parse(androidKeysText);
  const androidTestKeys = JSON.parse(androidTestKeysText);
  assert.ok(flutterKeys[keyId]);
  assert.equal(androidKeys[keyId], flutterKeys[keyId]);
  assert.equal(androidTestKeys[keyId], flutterKeys[keyId]);
  assert.ok(flutterKeys['government-feed-2026']);
  assert.ok(flutterKeys['taiwan-static-2026']);
});

test('collector mounts the generated area catalog read-only', async () => {
  const compose = await read('deploy/docker-compose.yml');
  const collector = serviceBlock(compose, 'collector');
  assert.match(
    collector,
    /\.\.\/data\/area-catalog\.json:\/app\/data\/area-catalog\.json:ro/u,
  );
  assert.match(
    collector,
    /\.\.\/deploy\/public\/address-packs:\/app\/deploy\/public\/address-packs:ro/u,
  );
});

test('collector prepares persistent volumes before dropping to node', async () => {
  const compose = await read('deploy/docker-compose.yml');
  const dockerfile = await read('deploy/Dockerfile');
  const collector = serviceBlock(compose, 'collector');
  const api = serviceBlock(compose, 'api');
  assert.match(collector, /entrypoint:\s*\["node",\s*"\/app\/deploy\/collector-entrypoint\.mjs"\]/u);
  assert.match(api, /^    user:\s*node$/mu);
  assert.match(dockerfile, /USER root/u);
  assert.match(dockerfile, /COPY deploy\/collector-entrypoint\.mjs \.\/deploy\/collector-entrypoint\.mjs/u);
});

test('collector passes TDX endpoint pacing and freshness settings', async () => {
  const compose = await read('deploy/docker-compose.yml');
  const collector = serviceBlock(compose, 'collector');
  assert.match(collector, /TDX_API_ENDPOINTS:\s*\$\{TDX_API_ENDPOINTS:-\}/u);
  assert.match(collector, /TDX_EVENT_FRESHNESS_SECONDS:\s*\$\{TDX_EVENT_FRESHNESS_SECONDS:-900\}/u);
  assert.match(collector, /TDX_ENDPOINT_DELAY_MS:\s*\$\{TDX_ENDPOINT_DELAY_MS:-1000\}/u);
});

test('Caddy proxies only the documented public server paths', async () => {
  const caddy = await read('deploy/Caddyfile');
  assert.match(caddy, /reverse_proxy\s+api:\d+/u);
  assert.match(caddy, /\/healthz|\/readyz/u);
  assert.match(caddy, /\/feed\.json|\/releases|\/v1/u);
  assert.doesNotMatch(caddy, /\/maps\/|\/srv\/(?:maps|osm)/u);
  assert.match(caddy, /\/address-packs\/catalog\.json/u);
  assert.match(caddy, /root\s+\*\s+\/srv\/address-packs/u);
  assert.match(caddy, /root\s+\*\s+\/srv\/web/u);
  assert.match(caddy, /try_files\s+\{path\}\s+\/index\.html/u);
  assert.doesNotMatch(caddy, /raw|source-cache|private_data/u);
});

test('cross-platform parity workflow runs Android instrumentation on an API 36 emulator', async () => {
  const workflow = await read('.github/workflows/platform-parity.yml');
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /android:[\s\S]*?runs-on: macos-15-intel/u);
  assert.match(workflow, /reactivecircus\/android-emulator-runner@v2\.38\.0/u);
  assert.match(workflow, /api-level: 36/u);
  assert.match(workflow, /:app:assembleDebugAndroidTest/u);
  assert.match(workflow, /:app:connectedDebugAndroidTest/u);
  assert.match(workflow, /name: platform-parity/u);
});

test('root docker build context excludes nested dotenv files and local data', async () => {
  const dockerignore = await read('.dockerignore');
  const compose = await read('deploy/docker-compose.yml');
  const dockerfile = await read('deploy/Dockerfile');
  assert.match(dockerignore, /^\.env$/mu);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^\*\*\/\.env$/mu);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/mu);
  assert.match(dockerignore, /^\*\*\/\*\.pem$/mu);
  assert.match(dockerignore, /^\*\*\/\*\.key$/mu);
  assert.match(dockerignore, /^data\/live$/mu);
  assert.match(dockerignore, /^data\/raw$/mu);
  assert.match(dockerignore, /^node_modules$/mu);
  assert.match(compose, /context:\s*\.\./u);
  assert.match(compose, /dockerfile:\s*deploy\/Dockerfile/u);
  assert.match(dockerfile, /COPY pipeline \.\/pipeline/u);
});

test('runbook documents bootstrap, restart, backup, rollback, and Android boundary', async () => {
  const runbook = await read('docs/central-server-runbook.md');
  for (const phrase of ['docker compose', 'SIGNING_KEY_ID', 'initial release', 'backup', 'rollback', 'Android', 'stale']) {
    assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
  }
  assert.match(runbook, /Flutter Web 及 Android 已接入簽章 feed/u);
  assert.doesNotMatch(runbook, /Android\/Flutter 尚未接入/u);
  assert.match(runbook, /flutter build web --release/u);
  assert.ok(
    runbook.indexOf('flutter build web --release') < runbook.indexOf('docker compose -f deploy/docker-compose.yml up -d --build'),
    'the Web build must run before Compose mounts flutter/build/web',
  );
  assert.match(runbook, /flutter\/build\/web/u);
});

test('Azure Bicep keeps private/public shares separate and scopes runtime identities by role', async () => {
  const bicep = await read('deploy/azure/main.bicep');
  assert.match(bicep, /name: 'resilientgeo-private'/u);
  assert.match(bicep, /name: 'resilientgeo-public'/u);
  assert.match(bicep, /resource api 'Microsoft\.App\/containerApps/u);
  assert.match(bicep, /scale: \{ minReplicas: 0/u);
  assert.match(bicep, /accessMode: 'ReadOnly'/u);
  assert.match(bicep, /roleBlobReader/u);
  assert.match(bicep, /roleBlobContributor/u);
  assert.match(bicep, /roleKeyVaultSecretsUser/u);
  assert.match(bicep, /collectorIdentity\.id/u);
  assert.match(bicep, /name: 'AZURE_CLIENT_ID', value: collectorIdentity\.properties\.clientId/u);
  assert.match(bicep, /name: 'AZURE_CLIENT_ID', value: apiIdentity\.properties\.clientId/u);
  assert.match(bicep, /name: 'AZURE_CLIENT_ID', value: cleanupIdentity\.properties\.clientId/u);
  assert.doesNotMatch(bicep.slice(bicep.indexOf("resource api '"), bicep.indexOf("resource dynamicJob '")), /SIGNING_PRIVATE_KEY_PEM|CWA_API_KEY|NCDR_ALERT_API_KEY|PRIVATE_DATA_ROOT/u);
  assert.match(bicep, /cronExpression: '\*\/10 \* \* \* \*'/u);
  assert.match(bicep, /cronExpression: '0 3 \* \* \*'/u);
  assert.match(bicep, /cronExpression: '30 3 \* \* \*'/u);
  assert.match(bicep, /param enableApps bool = false/u);
  assert.match(bicep, /emergencyMedicalRosterConfigured bool = false/u);
});

test('Azure deployment workflow is manual, uses OIDC, and deploys the image by digest', async () => {
  const workflow = await read('.github/workflows/azure-deploy.yml');
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /id-token:\s*write/u);
  assert.match(workflow, /azure\/login@v2/u);
  assert.match(workflow, /steps\.image\.outputs\.digest/u);
  assert.match(workflow, /resilientgeo@\$\{IMAGE_DIGEST\}/u);
  assert.match(workflow, /SIGNING_PRIVATE_KEY_PEM:\s*\$\{\{\s*secrets\.GOVERNMENT_SIGNING_PRIVATE_KEY\s*\}\}/u);
  assert.match(workflow, /openssl pkey -pubout -outform DER/u);
  assert.match(workflow, /trustedKeys\['government-feed-2026'\]/u);
  assert.doesNotMatch(workflow, /secrets\.SIGNING_(?:PRIVATE|PUBLIC)_KEY_PEM/u);
  assert.doesNotMatch(workflow, /git push/u);
});
