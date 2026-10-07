import { verifyFeed } from '../../../pipeline/lib/government-feed.mjs';
import { notFound, publicKeyFromConfig, sendPublicJson } from './response.mjs';

export function registerHealthRoutes(app, { config, releaseStore }) {
  app.get('/healthz', async (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/readyz', async (request, reply) => {
    try {
      const feed = await releaseStore.readFeed();
      verifyFeed(feed, publicKeyFromConfig(config), { signingKeyId: config.signingKeyId });
      if (!Array.isArray(feed.datasets)) throw new Error('current feed datasets are invalid');
      if (typeof feed.expires_at !== 'string' || Date.parse(feed.expires_at) <= Date.now()) {
        throw new Error('current feed is expired');
      }
      return sendPublicJson(request, reply, {
        status: 'ready',
        feed_revision: feed.revision,
        checked_at: feed.created_at,
      }, { lastModified: feed.created_at, maxAge: 5 });
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}

export { notFound };
