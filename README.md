# Custom Map Router

An interactive web app that routes across a **custom road network** instead of
public roads. Click a start and end point on the map and it snaps them to the
nearest intersection, finds the shortest path through a hand-defined grid, and
draws the route with a live distance readout.

The trick is separating what you *see* from what you *route on*: Mapbox renders a
normal basemap, but the pathfinding runs over a private network defined in
`src/paths.json`, so the same idea works for trails, indoor mall paths, a campus,
or a video-game grid.

## Demo

Click to drop a start (green) and end (red) point; the route snaps to the grid
and the panel shows the coordinates and total distance:

<img src="assets/demo.png" alt="The Custom Map Router: a dark Mapbox map with a green-to-red route drawn across a custom grid, and a Route Info panel showing coordinates and distance" width="720">

## How it works

1. **Snap the click.** A raw map click is a precise lng/lat that almost never
   lands exactly on the network. Turf.js finds the nearest valid intersection and
   the marker is placed there instead.
2. **Set start, then end.** The first click sets the start (green), the second
   sets the end (red); a third click resets.
3. **Route.** `geojson-path-finder` treats the network as a weighted graph and
   returns the shortest path between the two snapped nodes.
4. **Draw + measure.** The path is rendered as a cyan line and its weight is shown
   as the total distance. If no path connects the two points, it reports "No path
   found."

## Under the hood

A quick-glance tour of the pipeline. See [`TECHNICAL_DOCS.md`](TECHNICAL_DOCS.md)
for the deeper writeup.

### The stack

- [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/) renders the basemap (the
  `dark-v11` style) and draws the network and route layers.
- [Turf.js](https://turfjs.org/) handles the geospatial snapping.
- [geojson-path-finder](https://github.com/perliedman/geojson-path-finder) does
  the graph routing.
- [Vite](https://vitejs.dev/) bundles it; [Tailwind CSS](https://tailwindcss.com/)
  styles the UI.

### The network (`src/paths.json`)

A GeoJSON `FeatureCollection` of ~773 `LineString` segments centered on
Mountain View, CA. This is the graph the router walks. Swap this file to route on
any network you like.

### The routing flow (`src/main.js`)

- **On load**, it flattens every coordinate in `paths.json` into a deduplicated
  list of vertices and builds a Turf point cloud from them, then constructs a
  `PathFinder` over the raw network. The network itself is drawn as a dashed grey
  layer.
- **On click**, `turf.nearestPoint` snaps the click to the closest vertex. The
  first click becomes the start marker, the second the end marker.
- **Routing** calls `pathFinder.findPath(start, end)`; the returned `path` feeds a
  `calculated-route` GeoJSON source (the cyan line) and `weight` becomes the
  distance figure. A missing path clears the end marker and shows an error.
- **Clear** (button, or a third click) removes the markers and empties the route
  source.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add a Mapbox token

The map needs a Mapbox access token. Create a `.env` in the project root:

```env
VITE_MAPBOX_TOKEN=your_mapbox_token_here
```

Get a free token from your [Mapbox account](https://account.mapbox.com/). Without
it the map will not load (the console logs a warning).

### 3. Run

```bash
npm run dev       # dev server with HMR, usually http://localhost:5173
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## Project structure

```
mapper/
├── index.html          # Page shell + the Route Info panel markup
├── src/
│   ├── main.js         # Map setup, click handling, snapping, and routing
│   ├── paths.json      # The custom network (GeoJSON LineStrings)
│   └── input.css       # Tailwind entry stylesheet
├── vite.config.js
├── package.json
└── TECHNICAL_DOCS.md   # Detailed explanation of the routing logic
```

## License

ISC (see `package.json`).
