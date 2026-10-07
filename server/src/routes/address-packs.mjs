import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { notFound } from './response.mjs';

const FILE_NAME = /^(?:catalog\.json|manifest-\d{5}-[0-9a-f]{16}\.json|address-\d{5}-[0-9a-f]{16}\.ndjson\.gz)$/u;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** Serve only the public, signed address-pack artifacts from a read-only mount. */
export function registerAddressPackRoutes(app, { config }) {
  if (!config.addressPacksRoot) return;

  app.get('/address-packs/:fileName', async (request, reply) => {
    const { fileName } = request.params;
    if (!FILE_NAME.test(fileName)) return notFound(reply);

    let filePath;
    let file;
    try {
      const root = await realpath(config.addressPacksRoot);
      filePath = await realpath(path.join(root, fileName));
      if (!filePath.startsWith(`${root}${path.sep}`)) return notFound(reply);
      file = await stat(filePath);
      if (!file.isFile() || file.size > MAX_FILE_BYTES) return notFound(reply);
    } catch {
      return notFound(reply);
    }

    const compressed = fileName.endsWith('.ndjson.gz');
    const range = request.headers.range;
    const match = compressed && typeof range === 'string' ? /^bytes=(\d+)-$/u.exec(range) : null;
    if (range && (!match || Number(match[1]) >= file.size)) {
      return reply.code(416).header('content-range', `bytes */${file.size}`).send();
    }
    const start = match ? Number(match[1]) : 0;
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', fileName === 'catalog.json'
      ? 'no-cache' : 'public, max-age=31536000, immutable');
    reply.header('content-length', file.size - start);
    reply.type(compressed ? 'application/octet-stream' : 'application/json');
    if (match) {
      reply.code(206).header('content-range', `bytes ${start}-${file.size - 1}/${file.size}`);
    }
    if (compressed) reply.header('accept-ranges', 'bytes');
    return reply.send(createReadStream(filePath, { start }));
  });
}
