# syntax=docker/dockerfile:1

# Node 22, not 24, and deliberately so. better-sqlite3 11.x predates Node 24:
# its Statement destructor calls node::RemoveEnvironmentCleanupHook, which
# Node 24.19 aborts on (`Assertion failed: (env) != nullptr`). That is a hard
# SIGABRT mid-query, not a warning — it killed the server six times in the
# first ten minutes of the first deploy, and took the seed down with it.
# Upgrading to better-sqlite3 >=12 (the first line declaring node 24.x in
# engines) fixes it on 24 and lets this go back; until then, pin the runtime.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 needs a toolchain to build its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runner
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
