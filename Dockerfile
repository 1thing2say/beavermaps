# Two stages: build the front-end with the Mapbox token baked in, then ship a
# slim runtime image containing only production deps + the built assets.
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_* variables are inlined into the client bundle at build time, so the
# token has to be present during `vite build`, not at runtime. Supplied by
# `fly deploy --build-secret` / `--build-arg`. This is a public pk.* token —
# protect it with URL restrictions in the Mapbox dashboard, not by hiding it.
ARG VITE_MAPBOX_TOKEN
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/paths.json ./src/paths.json
COPY src/buildings.json ./src/buildings.json
COPY src/maneuvers.js ./src/maneuvers.js

EXPOSE 8080
CMD ["node", "server/index.js"]
