import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const ownedLockPaths = new Set();

async function processStartTime(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = contents.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // The fields after the command begin at field 3; field 22 is therefore
    // index 19 in this suffix. This distinguishes a reused container PID.
    return contents.slice(commandEnd + 2).trim().split(/\s+/u)[19] ?? null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
    throw error;
  }
}

async function isStaleLock(lockPath) {
  let contents;
  try {
    contents = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (contents.trim() === '') return true;
  let metadata;
  try {
    metadata = JSON.parse(contents);
  } catch {
    return true;
  }
  if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) return true;
  if (ownedLockPaths.has(lockPath)) return false;
  if (metadata.pid === process.pid) return true;
  if (metadata.pid_start_time) {
    const currentStartTime = await processStartTime(metadata.pid);
    if (currentStartTime && currentStartTime !== metadata.pid_start_time) return true;
  }
  try {
    process.kill(metadata.pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

export async function acquireCollectorLock(lockPath) {
  if (typeof lockPath !== 'string' || !path.isAbsolute(lockPath)) {
    throw new TypeError('collector lock path must be absolute');
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        pid_start_time: await processStartTime(process.pid),
        acquired_at: new Date().toISOString(),
      })}\n`);
      ownedLockPaths.add(lockPath);
      let released = false;
      return async function release() {
        if (released) return;
        released = true;
        ownedLockPaths.delete(lockPath);
        await handle.close();
        await unlink(lockPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await isStaleLock(lockPath)) {
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      const lockError = new Error('collector lock is already held');
      lockError.code = 'COLLECTOR_LOCK_HELD';
      throw lockError;
    }
  }
  throw new Error('collector lock acquisition failed');
}
