# Single image serving both the web app and the worker. They run as separate
# containers (see docker-compose.yml) because Next's server is not a job host,
# but they share one codebase and one plugin registry, so one image is correct.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The data volume holds rendered mp3s. Created here so the mount is owned by
# the app user rather than root.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next        ./.next
COPY --chown=node:node package.json ./
COPY --chown=node:node src          ./src
COPY --chown=node:node next.config.ts tsconfig.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
