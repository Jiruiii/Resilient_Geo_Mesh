import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
