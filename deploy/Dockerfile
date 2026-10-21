FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/resilientgeo-private /var/lib/resilientgeo-public \
  && chown -R node:node /var/lib/resilientgeo-private /var/lib/resilientgeo-public

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY pipeline ./pipeline
COPY server ./server
RUN mkdir -p /app/data
COPY deploy/collector-entrypoint.mjs ./deploy/collector-entrypoint.mjs
COPY deploy/api-entrypoint.mjs ./deploy/api-entrypoint.mjs

# Writable by the non-root API user; docker-compose mounts the crowd_data
# volume here and copies this ownership into the new volume.
RUN mkdir -p /var/lib/resilientgeo-crowd && chown node:node /var/lib/resilientgeo-crowd

USER root

CMD ["npm", "run", "server:start"]
