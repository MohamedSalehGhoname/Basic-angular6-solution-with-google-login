# Sync server + the built web app, served from one origin.
# Build the web app first (cd web && npx ng build); this image copies its output.
FROM node:22-bookworm-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/clipsync.db \
    STATIC_DIR=/app/web
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
COPY web/dist/web/browser ./web
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/index.js"]
