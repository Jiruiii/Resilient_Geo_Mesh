import { spawn } from 'node:child_process';

const NODE_UID = 1000;
const NODE_GID = 1000;
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('api command is required');

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
  console.error(`[api-entrypoint] failed to start API: ${error.code ?? 'SPAWN_ERROR'}`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
