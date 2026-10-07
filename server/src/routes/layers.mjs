import { AUXILIARY_LAYER_IDS, SOURCE_REGISTRY } from '../source-registry.mjs';
import { notFound, sendPublicJson } from './response.mjs';

const LAYER_IDS = new Set(SOURCE_REGISTRY
  .filter((source) => source.kind === 'static')
  .map((source) => source.output.layerId)
  .concat(AUXILIARY_LAYER_IDS));
const CHUNK_RE = /^\d+\.json$/u;

function allowedLayer(layerId) {
  return LAYER_IDS.has(layerId);
}

export function registerLayerRoutes(app, { releaseStore }) {
  app.get('/v1/layers/:layerId/manifest.json', async (request, reply) => {
    const { layerId } = request.params;
    if (!allowedLayer(layerId)) return notFound(reply);
    try {
      const manifest = await releaseStore.readLayerManifest(layerId);
      return sendPublicJson(request, reply, manifest, { lastModified: manifest.created_at });
    } catch {
      return notFound(reply);
    }
  });

  app.get('/v1/layers/:layerId/chunks/:chunkName', async (request, reply) => {
    const { layerId, chunkName } = request.params;
    if (!allowedLayer(layerId) || !CHUNK_RE.test(chunkName)) return notFound(reply);
    try {
      const chunk = await releaseStore.readLayerChunk(layerId, chunkName);
      return sendPublicJson(request, reply, chunk, { lastModified: chunk.created_at });
    } catch {
      return notFound(reply);
    }
  });
}

export { LAYER_IDS };
