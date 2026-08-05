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
├── index.html              # Page shell + the Route Info panel markup
├── server/
│   └── index.js            # Routing API; also serves the overlay GeoJSON
├── src/
│   ├── main.js             # Map setup, click handling, snapping, routing
│   ├── paths.json          # The walkable network (GeoJSON LineStrings)
│   ├── buildings.json      # Footprints, extruded during navigation
│   ├── landcover.json      # Lawn, trees, paving, parking, track, pool
│   ├── amenities.json      # Defibrillators, phones, restrooms, bike racks…
│   ├── places.json         # my campus's destination directory, positioned
│   ├── campus-boundary.json# OSM campus polygon, used to mask the basemap
│   ├── path-corrections.json # Per-node fix solved by scripts/build-snap.mjs
│   ├── amenity-icons.js    # Amenity pictograms, drawn as SVG
│   └── input.css           # Tailwind entry stylesheet
├── scripts/                # Data extraction — see below
├── vite.config.js
├── package.json
└── TECHNICAL_DOCS.md       # Detailed explanation of the routing logic
```

### Campus data

Everything drawn inside the campus boundary is traced out of my campus
College's own wayfinding basemap rather than taken from Mapbox, whose data for
this campus is close to empty. The extraction lives in `scripts/`:

| script | output |
|---|---|
| `build-basemap.mjs` | `basemap.json` — the whole printed sheet, 2,284 features |
| `build-paths.mjs` | `paths.json` — 581 nodes, 696 walkable segments |
| `build-buildings.mjs` | `buildings.json` — 96 footprints, 58 of them named |
| `build-labels.mjs` | `labels.json` — 49 labels: the PDF's text, plus building names |
| `build-amenities.mjs` | `amenities.json` — 72 amenity points in 10 classes |
| `build-places.mjs` | `places.json` — my campus's 120 destinations, positioned |
| `build-directory.mjs` | `directory.json` — 30 buildings and what is inside them |
| `build-landcover.mjs` | `landcover.json` — 593 ground polygons, superseded |
| `build-boundary.mjs` | `campus-boundary.json` — the OSM campus polygon |
| `build-snap.mjs` | `path-corrections.json` — per-node alignment fix |
| `projection.mjs` | the SVG→WGS84 transform every other script uses |
| `svg-geometry.mjs` | shared SVG path/transform parsing |
| `building-names.mjs` | grouping, tidying and label anchoring, shared |

`build-basemap.mjs` is the one that reads the drawing whole. The scripts above it
each take one class of thing off the same sheet, and between them they keep 24%
of its 3,220 elements; the rest — 1,004 parking-bay stripes, the walkway and
driveway linework, 555 trees, the crossings, the icons — is what makes the
printed map look like a map, and it is what the client now draws. Classification
comes from the artwork's own 24 Illustrator layers rather than from colour,
because three fills each carry more than one kind of thing.

Building names come from two places, in that order of preference. The printed
sheet's own labels win wherever it sets one, because its placement carries
information a centroid cannot: `Fine and Applied Arts` is a single 4,960 m²
footprint carrying three printed labels — *Music*, *Theatre* and the plate —
each set inside the wing it names. Where the sheet leaves a building bare,
`build-labels.mjs` falls back to my campus's database name, reduces it to something a
map can carry (`Bookstore - College Store` → `Bookstore`), and anchors it at the
footprint's **pole of inaccessibility** — the point furthest from any wall, which
a centroid is not: my campus has L-shaped buildings whose centroid falls on the lawn
outside. That radius also measures how much room the building has for type, and
sets the label's size and wrap width.

Thirty-eight footprints stay unlabelled because no source names them — they are
grandstands, annexes and service buildings. Naming them from the nearest entry in
`places.json` was tried and rejected: it labels an 839 m² building
*"Defibrillator"* and gives six separate portables the same name.

Tapping a building opens its card instead of dropping a pin. `directory.json`
joins the three files that were never joined — footprints, printed labels, and
my campus's 145 positioned destinations, 75 of which fall inside a footprint — so the
Welcome and Support Center can say it holds the Transfer Center, TRIO, DSPS and
five more. Amenities are counted separately from destinations: listing them
together made the Gym's directory read *"Defibrillator, Drink Vending Machine,
Drink Vending Machine"*, three entries and nowhere to go. The card's **Go here**
routes to the network node nearest the building's walls rather than to wherever
the tap landed, and `build-directory.mjs` reads only committed artifacts, so
unlike its siblings it runs from a bare clone.

`buildings.json` is still separate: it carries heights, and the 3D extrusion
during navigation needs them. `landcover.json` is kept and still served, but the
client no longer draws it.

Their source is gitignored (it is third-party content), so these are **not
runnable from a bare clone** — but every output they produce is committed. Each
script's header carries its own derivation, including the measurements that
ruled out the approaches that did not work.

### Tests

```bash
npm test          # node --test, no framework
```

The suite runs against the committed artifacts rather than the generators, so it
works from a bare clone. It is aimed at the failures that do not announce
themselves:

- **the walkable network is one connected component.** A fragmented graph draws
  identically and fails only when someone asks for a route across the split.
- **draw order and ring winding** in `basemap.json`. Mapbox tolerates backwards
  winding, so this never appears as a rendering bug — it appears when the file
  reaches anything that follows RFC 7946.
- **the joins between files**: every amenity class has an icon registered in
  `map-images.js`, and every place resolves onto the routing graph.
- **the letterform mask**, checked where it acts — on the layers that carry text
  — rather than by counting small shapes, because the sheet is full of
  legitimately small things.
- **every building's entrance is a real graph node** and its card anchor lies
  inside its own walls — the two things a pole of inaccessibility exists for.
- `maneuvers.js` directly, including that collinear vertices never become a turn.

Each of those was confirmed to fail when the thing it guards is deliberately
broken; a test that has never been red is not evidence of anything.

## License

ISC (see `package.json`).
