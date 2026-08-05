# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 needs a toolchain to build its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    COSTS_DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1001 --create-home costs \
    && mkdir -p /data && chown -R costs:costs /data

# standalone bundles only the server's transitive deps
COPY --from=build --chown=costs:costs /app/.next/standalone ./
COPY --from=build --chown=costs:costs /app/.next/static ./.next/static
COPY --from=build --chown=costs:costs /app/public ./public
# migrations + the runner are needed at boot, and are not traced into standalone
COPY --from=build --chown=costs:costs /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=costs:costs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

USER costs
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
