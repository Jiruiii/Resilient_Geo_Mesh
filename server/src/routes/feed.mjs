import { notFound, sendPublicJson } from './response.mjs';

const REVISION_RE = /^[1-9]\d*$/u;
const SOURCE_RE = /^[a-z][a-z0-9-]+$/u;
const CHUNK_RE = /^\d+\.json$/u;
const V2_CHUNK_RE = /^[0-9a-f]{64}$/u;

export function registerFeedRoutes(app, { releaseStore }) {
  app.get('/feed.json', async (request, reply) => {
    try {
      const feed = await releaseStore.readFeed();
      return sendPublicJson(request, reply, feed, { lastModified: feed.created_at });
    } catch {
      return notFound(reply);
    }
  });

  app.get('/v2/feed.json', async (request, reply) => {
    try {
      const feed = await releaseStore.readV2Feed();
      return sendPublicJson(request, reply, feed, { lastModified: feed.created_at });
    } catch {
      return notFound(reply);
    }
  });

  app.get('/v2/chunks/:hash.json', async (request, reply) => {
    const { hash } = request.params;
    if (!V2_CHUNK_RE.test(hash)) return notFound(reply);
    try {
      const chunk = await releaseStore.readV2Chunk(hash);
      return sendPublicJson(request, reply, chunk);
    } catch {
      return notFound(reply);
    }
  });

  app.get('/releases/:revision/:source/:chunk', async (request, reply) => {
    const { revision, source, chunk } = request.params;
    if (!REVISION_RE.test(revision) || !SOURCE_RE.test(source) || !CHUNK_RE.test(chunk)) return notFound(reply);
    try {
      const value = await releaseStore.readGovernmentChunk(revision, source, chunk);
      return sendPublicJson(request, reply, value, { lastModified: value.created_at });
    } catch {
      return notFound(reply);
    }
  });
}
