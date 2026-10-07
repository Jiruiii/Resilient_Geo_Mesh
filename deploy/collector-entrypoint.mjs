import { spawn } from 'node:child_process';
import {
  chownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

const NODE_UID = 1000;
const NODE_GID = 1000;

function chownTree(target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return;

  chownSync(target, NODE_UID, NODE_GID);
  if (!stat.isDirectory()) return;

  for (const entry of readdirSync(target)) {
    chownTree(path.join(target, entry));
  }
}

function prepareDataRoot(root) {
  mkdirSync(root, { recursive: true });
  const stat = lstatSync(root);
  if (stat.uid !== NODE_UID || stat.gid !== NODE_GID) {
    chownTree(root);
  }
}

for (const name of ['PRIVATE_DATA_ROOT', 'PUBLIC_RELEASE_ROOT']) {
  const root = process.env[name];
  if (!root) throw new Error(`${name} is required`);
  prepareDataRoot(root);
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('collector command is required');

const child = spawn(command, args, {
  env: process.env,
  gid: NODE_GID,
  stdio: 'inherit',
  uid: NODE_UID,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
