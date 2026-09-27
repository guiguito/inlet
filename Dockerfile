# Inlet ships as one image: the API also serves the built management interface, so a
# personal deployment is a single container plus PostgreSQL and object storage.
#
# The base is Debian slim rather than Alpine because sharp's prebuilt binaries target
# glibc; Alpine would mean compiling libvips from source on every build.

FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV npm_config_update_notifier=false

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig*.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/mcp apps/mcp
COPY apps/web apps/web
# UX Analytics AN-033: the pinned DB-IP Lite country database (CC BY 4.0), checked against its
# SHA-256. Fetched here, so the image carries it and a running container never downloads it.
COPY scripts/ip-country-db.mjs scripts/ip-country-db.mjs
RUN node scripts/ip-country-db.mjs apps/api/ip-country/dbip-country-lite.mmdb
# What the server ships, and only that: the SDK is published to npm, not served, and is not
# in this build context, so the root `build` (which includes it) cannot run here.
RUN npm run build:server

# Drop the dev dependencies from the tree that ships.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    INLET_HOST=0.0.0.0 \
    INLET_PORT=3000 \
    INLET_WEB_DIST=/app/apps/web/dist

# sharp needs libvips' runtime dependencies for its prebuilt binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
# The event store's migrations, which the API applies at start when ClickHouse is configured.
COPY --from=build /app/apps/api/clickhouse apps/api/clickhouse
COPY --from=build /app/apps/api/ip-country apps/api/ip-country
COPY --from=build /app/apps/mcp/package.json apps/mcp/package.json
COPY --from=build /app/apps/mcp/dist apps/mcp/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Never run as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.INLET_PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
