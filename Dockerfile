# Two stages: build the front-end with the Mapbox token baked in, then ship a
# slim runtime image containing only production deps + the built assets.
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_* variables are inlined into the client bundle at build time, so both
# credentials have to be present during `vite build`, not at runtime. Supplied
# by `fly deploy --build-arg`. Both are public browser credentials — a pk.*
# token and a browser API key — and neither is protected by being hidden. The
# Mapbox token is restricted by URL in the Mapbox dashboard, the Google key by
# HTTP referrer in the Cloud console. A key that builds in but is not listed
# for the deployed origin fails at createSession, not here.
ARG VITE_MAPBOX_TOKEN
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
ARG VITE_GOOGLE_MAPS_KEY
ENV VITE_GOOGLE_MAPS_KEY=$VITE_GOOGLE_MAPS_KEY
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
# The whole of src/, not a hand-listed subset. server/index.js reads ten JSON
# files at boot — paths, approach-paths, and the seven overlays, plus rooms via
# the directory — and imports maneuvers.js. Listing them individually meant the
# image built clean and then died on the first missing readFileSync at startup.
# src/ is ~3.5MB and the .js in it is already bundled into dist; the duplication
# costs less than the next boot crash.
COPY src ./src

# Drop root.
#
# node:20-slim ships an unprivileged `node` user (uid 1000) and does not use it
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
