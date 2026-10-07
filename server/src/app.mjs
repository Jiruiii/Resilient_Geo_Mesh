import Fastify from 'fastify';

import { registerFeedRoutes } from './routes/feed.mjs';
import { registerAddressPackRoutes } from './routes/address-packs.mjs';
import { registerHealthRoutes } from './routes/health.mjs';
import { registerLayerRoutes } from './routes/layers.mjs';
import { registerMetadataRoutes } from './routes/metadata.mjs';
import { registerSourceStatusRoutes } from './routes/source-status.mjs';

export function buildApp({ config = {}, releaseStore, sourceStateStore = {}, logger = false } = {}) {
  if (!releaseStore || typeof releaseStore.readFeed !== 'function') {
    throw new TypeError('releaseStore with readFeed is required');
  }
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10_000,
  });
  const dependencies = { config, releaseStore, sourceStateStore };
  registerHealthRoutes(app, dependencies);
  registerFeedRoutes(app, dependencies);
  registerAddressPackRoutes(app, dependencies);
  registerLayerRoutes(app, dependencies);
  registerSourceStatusRoutes(app, dependencies);
  registerMetadataRoutes(app, dependencies);
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ error: 'internal_error' }));
  return app;
}
