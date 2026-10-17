import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson } from './atomic-file.mjs';

const PREFIX = 'rescue/';

export function rescueBlobName(eventId) {
  return `${PREFIX}${createHash('sha256').update(eventId, 'utf8').digest('hex')}.json`;
}

function preconditionFailed() {
  return Object.assign(new Error('rescue store precondition failed'), { status: 412 });
}

/** Local and docker-compose storage. One process writes, so a promise chain serializes conditional writes. */
export function createFileRescueStore({ root }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path');
  let queue = Promise.resolve();
  const serialize = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const fileFor = (eventId) => path.join(root, rescueBlobName(eventId));

  async function read(filePath) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return Object.freeze({
    async get(eventId) {
      const record = await read(fileFor(eventId));
      return record ? { record, etag: record.event.payload_hash } : null;
    },
    put(record, { ifMatch, ifNoneMatch } = {}) {
      return serialize(async () => {
        const filePath = fileFor(record.event.event_id);
        const current = await read(filePath);
        if (ifNoneMatch === '*' && current) throw preconditionFailed();
        if (ifMatch && current?.event.payload_hash !== ifMatch) throw preconditionFailed();
        await atomicWriteJson(filePath, record);
        return record.event.payload_hash;
      });
    },
    async list() {
      let names;
      try {
        names = await readdir(path.join(root, PREFIX));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const records = await Promise.all(
        names.filter((name) => name.endsWith('.json')).map((name) => read(path.join(root, PREFIX, name))),
      );
      return records.filter(Boolean);
    },
  });
}

export function createAzureRescueStore({ blobClient, container }) {
  if (!blobClient || typeof container !== 'string') throw new TypeError('blobClient and container are required');
  return Object.freeze({
    async get(eventId) {
      const result = await blobClient.getJson(container, rescueBlobName(eventId));
      return result ? { record: result.value, etag: result.etag } : null;
    },
    async put(record, conditions = {}) {
      try {
        return await blobClient.putJson(container, rescueBlobName(record.event.event_id), record, conditions);
      } catch (error) {
        if (error.status === 409 || error.status === 412) throw preconditionFailed();
        throw error;
      }
    },
    async list() {
      const names = await blobClient.listBlobNames(container, PREFIX);
      const results = await Promise.all(names.map((name) => blobClient.getJson(container, name)));
      return results.filter(Boolean).map((result) => result.value);
    },
  });
}
