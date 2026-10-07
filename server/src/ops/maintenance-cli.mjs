#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPrivateKey, readPublicKey } from '../../../pipeline/lib/crypto.mjs';
import { createBackup, restoreBackup } from './backup-restore.mjs';
import { cleanupReleases } from './release-cleanup.mjs';
import {
  createMigrationSnapshot,
  restoreMigrationSnapshot,
  verifyMigrationSnapshot,
} from './migration-snapshot.mjs';
import { createAzureRuntimeStorage } from '../storage/azure-runtime.mjs';

function options(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--execute') output.execute = true;
    else if (item === '--destination' || item === '--backup-root' || item === '--private-root'
      || item === '--public-root' || item === '--snapshot-root' || item === '--area-catalog-path'
      || item === '--emergency-roster-path'
      || item === '--emergency-crosswalk-path' || item === '--keep-revisions' || item === '--keep-days') {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${item}`);
      output[item.slice(2).replaceAll('-', '_')] = value;
      index += 1;
    } else throw new Error(`unknown option: ${item}`);
  }
  return output;
}

async function publicKey() {
  const keyPath = process.env.SIGNING_PUBLIC_KEY_PATH;
  if (process.env.SIGNING_PUBLIC_KEY_PEM) return readPublicKey(process.env.SIGNING_PUBLIC_KEY_PEM);
  if (!keyPath) throw new Error('SIGNING_PUBLIC_KEY_PATH is required');
  return readPublicKey(await readFile(keyPath));
}

async function privateKey() {
  if (process.env.SIGNING_PRIVATE_KEY_PEM) return readPrivateKey(process.env.SIGNING_PRIVATE_KEY_PEM);
  const keyPath = process.env.SIGNING_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error('SIGNING_PRIVATE_KEY_PATH is required');
  return readPrivateKey(await readFile(keyPath));
}

function azureStorage() {
  return createAzureRuntimeStorage({
    azureStorageBlobEndpoint: process.env.AZURE_STORAGE_BLOB_ENDPOINT ?? null,
    azureControlContainer: process.env.AZURE_CONTROL_CONTAINER ?? 'resilientgeo-control',
    azureReleasePointerBlob: process.env.AZURE_RELEASE_POINTER_BLOB ?? 'current/release-pointer.json',
    azureCollectorLockBlob: process.env.AZURE_COLLECTOR_LOCK_BLOB ?? 'locks/collector.lock',
  });
}

function rootOption(value, envName) {
  const result = value ?? process.env[envName];
  if (!result) throw new Error(`${envName} is required`);
  return result;
}

export async function run(command, argv = []) {
  const parsed = options(argv);
  const signingKeyId = process.env.SIGNING_KEY_ID;
  if (!signingKeyId) throw new Error('SIGNING_KEY_ID is required');
  const storage = azureStorage();
  if (command === 'backup') {
    return createBackup({
      privateDataRoot: rootOption(parsed.private_root, 'PRIVATE_DATA_ROOT'),
      publicReleaseRoot: rootOption(parsed.public_root, 'PUBLIC_RELEASE_ROOT'),
      destination: parsed.destination,
      publicKey: await publicKey(),
      signingKeyId,
      releasePointerStore: storage.releasePointerStore,
    });
  }
  if (command === 'snapshot') {
    return createMigrationSnapshot({
      privateDataRoot: rootOption(parsed.private_root, 'PRIVATE_DATA_ROOT'),
      publicReleaseRoot: rootOption(parsed.public_root, 'PUBLIC_RELEASE_ROOT'),
      destination: parsed.destination,
      areaCatalogPath: rootOption(parsed.area_catalog_path, 'AREA_CATALOG_PATH'),
      emergencyMedicalRosterPath: parsed.emergency_roster_path ?? process.env.EMERGENCY_MEDICAL_ROSTER_PATH,
      emergencyMedicalCrosswalkPath: parsed.emergency_crosswalk_path ?? process.env.EMERGENCY_MEDICAL_CROSSWALK_PATH,
      publicKey: await publicKey(),
      privateKey: await privateKey(),
      signingKeyId,
      releasePointerStore: storage.releasePointerStore,
    });
  }
  if (command === 'restore-snapshot') {
    return restoreMigrationSnapshot({
      snapshotRoot: rootOption(parsed.snapshot_root, 'MIGRATION_SNAPSHOT_ROOT'),
      privateDataRoot: rootOption(parsed.private_root, 'PRIVATE_DATA_ROOT'),
      publicReleaseRoot: rootOption(parsed.public_root, 'PUBLIC_RELEASE_ROOT'),
      publicKey: await publicKey(),
      signingKeyId,
      releasePointerStore: storage.releasePointerStore,
    });
  }
  if (command === 'verify-snapshot') {
    return verifyMigrationSnapshot({
      snapshotRoot: rootOption(parsed.snapshot_root, 'MIGRATION_SNAPSHOT_ROOT'),
      publicKey: await publicKey(),
      signingKeyId,
    });
  }
  if (command === 'restore') {
    return restoreBackup({
      backupRoot: parsed.backup_root,
      privateDataRoot: rootOption(parsed.private_root, 'PRIVATE_DATA_ROOT'),
      publicReleaseRoot: rootOption(parsed.public_root, 'PUBLIC_RELEASE_ROOT'),
      publicKey: await publicKey(),
      signingKeyId,
      releasePointerStore: storage.releasePointerStore,
    });
  }
  if (command === 'cleanup') {
    const lease = storage.collectorLockProvider
      ? await storage.collectorLockProvider.acquire()
      : null;
    try {
      await lease?.assertHeld();
      return await cleanupReleases({
        releaseRoot: rootOption(parsed.public_root, 'PUBLIC_RELEASE_ROOT'),
        keepRevisions: parsed.keep_revisions === undefined ? 10 : Number(parsed.keep_revisions),
        keepDays: parsed.keep_days === undefined ? 30 : Number(parsed.keep_days),
        dryRun: !parsed.execute,
        releasePointerStore: storage.releasePointerStore,
        assertLockHeld: lease ? () => lease.assertHeld() : undefined,
      });
    } finally {
      await lease?.release();
    }
  }
  throw new Error(`unknown maintenance command: ${command}`);
}

if (process.argv[1]?.endsWith('/maintenance-cli.mjs')) {
  const [command, ...argv] = process.argv.slice(2);
  run(command, argv)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.code ?? 'MAINTENANCE_ERROR', message: error.message }));
      process.exitCode = 1;
    });
}
