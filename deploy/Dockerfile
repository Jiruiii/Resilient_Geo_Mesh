FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY pipeline ./pipeline
COPY server ./server
COPY deploy/collector-entrypoint.mjs ./deploy/collector-entrypoint.mjs
COPY deploy/api-entrypoint.mjs ./deploy/api-entrypoint.mjs

USER root

CMD ["npm", "run", "server:start"]
