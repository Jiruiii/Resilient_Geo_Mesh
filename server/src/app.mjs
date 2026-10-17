import Fastify from 'fastify';

import { registerFeedRoutes } from './routes/feed.mjs';
import { registerAddressPackRoutes } from './routes/address-packs.mjs';
import { registerCrowdRescueRoutes } from './routes/crowd-rescue.mjs';
import { registerHealthRoutes } from './routes/health.mjs';
import { registerLayerRoutes } from './routes/layers.mjs';
import { registerMetadataRoutes } from './routes/metadata.mjs';
import { registerSourceStatusRoutes } from './routes/source-status.mjs';

export function buildApp({ config = {}, releaseStore, sourceStateStore = {}, rescueStore = null, rescueOptions, logger = false } = {}) {
  if (!releaseStore || typeof releaseStore.readFeed !== 'function') {
    throw new TypeError('releaseStore with readFeed is required');
  }
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10_000,
    // Caddy (docker-compose) or the ACA ingress is the single hop in front of
    // the API; trust exactly that hop for request.ip.
    trustProxy: 1,
  });
  const dependencies = { config, releaseStore, sourceStateStore };
  registerHealthRoutes(app, dependencies);
  registerFeedRoutes(app, dependencies);
  registerAddressPackRoutes(app, dependencies);
  registerLayerRoutes(app, dependencies);
  registerSourceStatusRoutes(app, dependencies);
  registerMetadataRoutes(app, dependencies);
  if (rescueStore) registerCrowdRescueRoutes(app, { rescueStore, rescueOptions });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((error, _request, reply) => {
    // Client errors keep their status but never echo the request body.
    if (error.statusCode === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request' });
    return reply.code(500).send({ error: 'internal_error' });
  });
  return app;
}
