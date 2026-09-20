# Technical Documentation: Routing

How a walk across this campus is calculated, and where each part of it happens.

> This document described client-side routing until the graph moved to the
> server. It was left saying that the browser ran `new PathFinder(...)` and
> snapped clicks with Turf — which `src/main.js` contradicts in a comment
> ("this file never builds a PathFinder") — and its worked example used the
> Googleplex's coordinates rather than this campus's. Both are corrected below.

---

## Overview

Map APIs route over public road networks. This campus's pavement is not in any
of them: it is a set of paths traced out of the college's own printed site plan,
plus the streets immediately around it so a walk can begin outside the fence. So
the visual map and the routing graph are separate things, joined only by
coordinates.

| Concern | Library | Where it runs |
|---|---|---|
| Drawing the ground | Mapbox GL JS, or Google 2D Tiles | browser |
| Drawing our own linework, labels, pins | Mapbox GL JS | browser |
| Snapping a coordinate to the graph | `@turf/nearest-point` | **both** |
| Shortest path | `geojson-path-finder` | **server only** |
| Turning a path into instructions | `src/maneuvers.js` | server |
| The 3D flyover | deck.gl + Google 3D Tiles | browser, lazily |

---

## 1. Why the graph is on the server

Building the topology is `O(E)` over 7,145 segments, and it produces the same
graph every time. Done in the browser it was paid on every visitor's phone,
during the cold load, before the first route could be asked for.

`server/graph.js` builds it once at boot — about 300 ms — and holds it. The
client asks `POST /api/route` with two coordinates and gets back a line, a
distance and a list of maneuvers.

The graph is the union of two files, concatenated:

- **`src/paths.json`** — the campus's own paths, traced from its printed sheet.
  Owned by `scripts/build-walk-network.mjs`. This is also what gets *drawn*.
- **`src/approach-paths.json`** — the surrounding streets, from OpenStreetMap.
  Owned by `scripts/build-approach-network.mjs`. Routed over, **never drawn**,
  because whichever provider is painting the ground is already drawing them.

Concatenation *is* the merge. `geojson-path-finder` derives topology from
coordinates rather than from feature identity, so the fifteen hand-made gate
connectors weld to campus vertices simply by ending on them at the same seven
decimals.

---

## 2. Snapping (`@turf/nearest-point`)

**The problem.** A click is an arbitrary lon/lat. `findPath` only accepts points
that are *already nodes* in the network.

**The solution.** Every distinct vertex in the graph — 6,523 of them — becomes a
point cloud. A coordinate is replaced by the nearest member of that cloud.

```
click   [-121.3465, 38.6486]
snapped [-121.3464482, 38.648593]   ← a real vertex, exactly
```

This happens in two places, deliberately:

- **In the browser**, so the marker lands on the graph the instant you tap
  rather than a round trip later. The cloud comes from `GET /api/vertices`.
- **On the server**, because it is the server that has to be right.

### `REACH_M`: the check that makes snapping honest

Snapping is unconditional. `nearestPoint` will happily hand back the closest
vertex to a point on another continent, so on its own it turns *any* request
into a confident walking route:

```
GET /api/route?from=2.3522,48.8566&to=-121.3448,38.6502     (Paris → campus)
→ 200 OK   distanceFeet: 7520   maneuvers: 27
```

The distance is real and the walk is real. It is not yours.

`REACH_M = 300` in `src/directions.js` is the line, measured rather than chosen:
a 60×60 grid over the graph's bounding box has a median distance to the nearest
vertex of 26 m, a 99th percentile of 121 m and a worst case of 215 m. Beyond
300 m you are not near anything this server can walk you along.

It is enforced on **both** sides:

| Where | What happens |
|---|---|
| `locateStart()` | a GPS fix too far out is refused before any request |
| `placeStart()` | a dropped pin too far out is refused the same way |
| `graph.route()` | the endpoint answers **422** with the same sentence |

The browser check saves a round trip. The server check is the one that is
actually load-bearing, since the endpoint is public.

The camera is also fenced to `ROUTABLE_BOUNDS` (`maxBounds`), so panning cannot
leave the area the server can route over in the first place.

---

## 3. Path-finding (`geojson-path-finder`)

`new PathFinder(graph, { precision: 1e-7 })` walks the LineStrings, joins those
that share coordinates, and weights each edge by its true geographic length.

**Precision matters here.** The library's default is `1e-5` degrees, and the
closest pair of *distinct* campus nodes is `1.24e-5` apart — a 24 % margin. At
the default, one re-survey would weld two stair landings into a single vertex
and quietly delete a route. `1e-7` is about a centimetre, which is the precision
`paths.json` is written at. `test/router.test.js` holds the constant to the data.

The search itself is Dijkstra's algorithm: explore outward from the start,
accumulating edge weights, always expanding the cheapest frontier node, until
the end is reached.

---

## 4. What comes back

```jsonc
{
  "geometry":     { "type": "LineString", "coordinates": [...] },
  "distanceFeet": 1204,
  "maneuvers":    [ /* see src/maneuvers.js */ ],
  "snapped":      { "from": [...], "to": [...] }   // where it really began
}
```

`snapped` is not decoration — it is the server saying where it *actually*
started, which may not be where you clicked.

Three non-answers, and they are not interchangeable:

| Status | Meaning |
|---|---|
| **400** | `from`/`to` missing or not a coordinate pair |
| **404** | both ends are on the graph; nothing joins them |
| **422** | an end is too far from the graph to snap to (`REACH_M`) |
| **429** | too many route requests from one address — see `server/limit.js` |

`/api/route` is the only endpoint here that is not a precomputed constant, which
is why it is the only one that is rate limited and the only one not gzipped at
boot.

---

## 5. Rendering

The returned `LineString` goes into a GeoJSON source and is drawn as a ribbon
over whichever ground is underneath — Mapbox's or Google's. The ribbon is the
only thing a visitor ever sees of the approach network.

`src/maneuvers.js` runs on the server to turn the path into turn-by-turn
instructions; `src/directions.js` runs in the browser to turn the distance into
"12 min · 8:24 PM · 0.3 mi". Both are pure modules with no DOM in them, which is
why the server can import the second one for `REACH_M` and its refusal wording.
