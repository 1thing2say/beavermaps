# Two stages: build the front-end with the Mapbox token baked in, then ship a
# slim runtime image containing only production deps + the built assets.
#
# Node 24 in both stages, and in every CI job: 20 reached end of life on
# 2026-04-30, and a base image that no longer gets security releases is a
# server that no longer gets them either. package.json's `engines` says
# >=22.12 because that is what the code needs; 24 is what we actually run.
FROM node:24-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_* variables are inlined into the client bundle at build time, so both
# credentials have to be present during `vite build`, not at runtime. Supplied
# by `fly deploy --build-arg` — `npm run deploy` reads them out of .env for you,
# because .dockerignore keeps .env itself out of the build context and fly.toml
# deliberately has no [build.args]: this repository is public. Both are public
# browser credentials — a pk.* token and a browser API key — and neither is
# protected by being hidden. The Mapbox token is restricted by URL in the
# Mapbox dashboard, the Google key by HTTP referrer in the Cloud console. A key
# that builds in but is not listed for the deployed origin fails at
# createSession, not here.
ARG VITE_MAPBOX_TOKEN
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
ARG VITE_GOOGLE_MAPS_KEY
ENV VITE_GOOGLE_MAPS_KEY=$VITE_GOOGLE_MAPS_KEY

# Refuse to build a map that cannot start.
#
# Without this, a bare `fly deploy` (no build args) built clean, passed every
# health check — /healthz is the API, and the API needs no token — and served
# visitors "This map cannot start" with developer instructions about .env. The
# most likely first-deploy mistake was also the one nothing reported.
#
# Mapbox is required and checked for shape, not just presence: an sk.* secret
# token would be a leak, and a typo'd or empty one is the same dead page. Google
# is only warned about — without it the app falls back to Mapbox, which is a
# whole working mode rather than a broken one.
#
# No `RUN npm test` here, on purpose: test/ is in .dockerignore, so the suite is
# not in the build context to run. `npm run deploy` runs `npm run check` on a
# clean tree before it uploads anything, and CI runs it on every push.
RUN case "$VITE_MAPBOX_TOKEN" in pk.*) ;; *) echo 'ERROR: --build-arg VITE_MAPBOX_TOKEN=pk... required (see README, Deploy)' >&2; exit 1;; esac; \
    [ -n "$VITE_GOOGLE_MAPS_KEY" ] || echo 'WARNING: no VITE_GOOGLE_MAPS_KEY; Google ground/flyover disabled' >&2
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production deps only, and that list is short on purpose: express,
# geojson-path-finder and the three @turf modules that server/graph.js and
# src/maneuvers.js import. deck.gl, loaders.gl, mapbox-gl and the rest of the
# client are devDependencies — they reach visitors through dist/, already
# bundled, so installing them here was ~280MB of node_modules nobody executes
# where the server's own are 20MB.
# test/deploy.test.js ('dependencies are exactly what the server imports')
# walks the server's imports and fails if the two lists ever disagree.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
# The whole of src/, not a hand-listed subset. server/index.js reads ten JSON
# files at boot — paths, approach-paths, doors and campus-boundary for the
# graph, and the six overlays, of which buildings and directory feed the graph
# too — and server/graph.js imports maneuvers.js, directions.js and
# campus-clip.js. Listing them individually meant the
# image built clean and then died on the first missing readFileSync at startup.
# src/ is ~3.5MB and the .js in it is already bundled into dist; the duplication
# costs less than the next boot crash.
COPY src ./src

# Drop root.
#
# node:24-slim ships an unprivileged `node` user (uid 1000) and does not use it
# — the default for every official node image is root, so without this line the
# process answering requests from the public internet is uid 0 inside its
# container. Nothing here needs it: the server reads dist/ and src/ and writes
# nothing at all, so the files stay root-owned and mode 644 and `node` reads
# them fine. Ownership is not handed over deliberately — a runtime that cannot
# write its own code is one fewer thing to reason about.
#
# The port is 8080, well clear of the 1024 that would have needed privilege.
USER node

EXPOSE 8080
CMD ["node", "server/index.js"]
