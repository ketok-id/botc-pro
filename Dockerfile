# BOTC Pro — headless server image.
#
# Builds the WebSocket signaling/game server only. The Electron desktop client
# runs on players' machines. This image is meant for internet-hosted rooms:
# put it behind a TLS-terminating reverse proxy (Caddy / nginx / Traefik) and
# point clients at `wss://your.domain`.

# ---- Stage 1: install production dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app

# Only copy package manifests first so the layer is cached unless deps change.
COPY package.json package-lock.json* ./

# Install runtime dependencies only (skip Electron — it's devDependency).
# Prefer `npm ci` when a lockfile is present; fall back to `npm install`.
#
# --ignore-scripts is required because package.json has a postinstall that runs
# electron-builder (a devDependency), which isn't available here. The server
# has no native modules, so skipping lifecycle scripts is safe.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi

# ---- Stage 2: runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app

# Useful signal handling for Node in containers.
RUN apk add --no-cache tini

# Copy installed deps and the server/source tree. The renderer/ folder is not
# needed by the headless server; keeping the copy narrow shrinks the image.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/main/server.js                    src/main/server.js
COPY src/main/server-standalone.js         src/main/server-standalone.js
COPY src/shared/                           src/shared/
# The standalone server serves src/renderer/ over HTTP on the same port as
# WebSocket, so browser clients can play without installing the desktop app.
# Run with --no-web to opt out if you only want the signaling endpoint.
COPY src/renderer/                         src/renderer/

# Drop root for runtime.
RUN addgroup -S botc && adduser -S -G botc botc \
    && chown -R botc:botc /app
USER botc

ENV NODE_ENV=production \
    PORT=7878 \
    BIND=0.0.0.0

EXPOSE 7878

# Lightweight TCP healthcheck — the server listens on PORT as soon as it's up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('net').connect(Number(process.env.PORT||7878),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node src/main/server-standalone.js --port \"$PORT\" --bind \"$BIND\""]
