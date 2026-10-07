import { SOURCE_REGISTRY } from '../source-registry.mjs';
import { notFound, sendPublicJson } from './response.mjs';

const STATIC_SOURCES = SOURCE_REGISTRY.filter((source) => source.kind === 'static');

export function registerMetadataRoutes(app, { config, releaseStore }) {
  app.get('/v1/metadata', async (request, reply) => {
    try {
      const feed = await releaseStore.readFeed();
      const layers = [];
      for (const source of STATIC_SOURCES) {
        try {
          const manifest = await releaseStore.readLayerManifest(source.output.layerId);
          layers.push({
            layer_id: manifest.layer_id,
            dataset_version: manifest.dataset_version,
            manifest_id: manifest.manifest_id,
            created_at: manifest.created_at,
            expires_at: manifest.expires_at,
            coverage: source.coverage,
          });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return sendPublicJson(request, reply, {
        server_version: config.serverVersion ?? null,
        feed_revision: feed.revision,
        generated_at: feed.created_at,
        coverage: 'TW',
        layers,
      }, { lastModified: feed.created_at });
    } catch {
      return notFound(reply);
    }
  });
}
