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
| Snapping a coordinate to the graph | our own, in `server/graph.js`; `@turf/nearest-point` in the browser | **both** |
| Shortest path | `geojson-path-finder`'s graph, our own search | **server only** |
| Turning a path into instructions | `src/maneuvers.js` | server |
| The 3D flyover | deck.gl + Google 3D Tiles | browser, lazily |

The browser half is a set of modules that each take their collaborators through
a factory, wired together by `src/main.js`. The ones a route passes through are
`src/api.js` (the request), `src/route-state.js` (the answer), `src/endpoints.js`
(the two ends and their pins), `src/route-layers.js` (the ribbon) and
`src/navigation.js` (walking it).

---

## 1. Why the graph is on the server

Building the topology is `O(E)` over 7,561 segments, and it produces the same
graph every time. Done in the browser it was paid on every visitor's phone,
during the cold load, before the first route could be asked for.

`server/graph.js` builds it once at boot — about 50 ms — and holds it. The
client asks `POST /api/route` with two coordinates and gets back a line, a
distance and a list of maneuvers.

The graph is the union of two files, concatenated:

- **`src/paths.json`** — the campus's own paths, traced from its printed sheet.
  Owned by `scripts/build-walk-network.mjs`. This is also what gets *drawn*.
- **`src/approach-paths.json`** — the surrounding streets, from OpenStreetMap.
  Owned by `scripts/build-approach-network.mjs`. Routed over, **never drawn**,
  because whichever provider is painting the ground is already drawing them.
  By default that script re-gates the streets already in the file against the
  current `paths.json` and leaves them otherwise byte-for-byte. Only `--fetch`
  goes to Overpass, so a campus rebuild cannot bring in OSM edits nobody has
  reviewed.

Concatenation *is* the merge. `geojson-path-finder` derives topology from
coordinates rather than from feature identity, so the twenty-two gate connectors
that script prints on every build weld to campus vertices simply by ending on them at the same seven
decimals.

A third file is read beside them and routed over by nobody: **`src/doors.json`**,
also written by `build-walk-network.mjs`. It holds what that script's walls
stage took off the graph under each building's roof, and the node each piece
left the graph at — the building's doors. It changes only where a coordinate
snaps; see below. So do two more: the `doors` each building in
**`src/directory.json`** lists, which make a building's doors one destination,
with its footprint, which makes anywhere inside it the same place as the
building, and the footprints in **`src/buildings.json`**, which keep a way onto the
network from open ground from being drawn through a wall.

---

## 2. Snapping

**The problem.** A click is an arbitrary lon/lat, and the graph is vertices and
the edges between them.

**The solution.** The coordinate joins the network at the **nearest point on the
nearest edge** — the foot of the perpendicular, or the edge's end when the foot
is within 2 m of it (`SNAP_WELD_M`, the weld distance the build splices
destinations with, so a destination the build bound to a vertex snaps to that
vertex). A foot between two vertices is not a node of the graph, so the search
starts from both ends of its edge, each charged the part of the edge walked to
reach it, and the returned line begins at the foot itself.

```
click   [-121.3465, 38.6486]
snapped a point on an edge, or a real vertex within 2 m of one
```

**Why not the nearest vertex**, which is what this did until the build started
collapsing strokes traced as runs of near-collinear points into the single
straight edges they are. The walkway along STEM's south face is now one 107 m
segment with nothing in its middle, and a point beside that middle snapped to
whichever end was nearer and began its walk fifty metres up the path and back.
Of 170 walks that came out more than a quarter longer after that change, 155
came back to their old length when routed between their old snap targets — the
snap was the whole regression.

**Not only the nearest edge.** A point well off the network — a room in the
middle of a building — is often about as far from two sides of it: the STEM
place is 30.6 m from a path to its east and 32 m from the walkway to its south.
So every edge within a quarter again of the nearest distance, and never more
than 5 m further (`SNAP_SLACK_M`), offers its own nearest point too, as long as
that point is the nearest of its neighbourhood (a perpendicular foot, or a
corner every edge at it leads away from). The extra metres to it are counted
against it, and the walk picks: College Oak Parking Lot to STEM is 155 m by the
south side and 210 m by the nearest. A point on or beside the network has no
alternative — the slack is proportional — so a walk to a building's entrance
ends at a door of it, not on a path beside it. A pairing whose walk along the
network would be shorter than the weld is passed over: it is "cross the ground
and you are there", and there is nothing to draw.

**From open ground, every way.** The slack is for a tie of a metre or two. A
point at least 4 m from any path (`OPEN_GROUND_M`) — the middle of a car park, a
lawn — is also offered the nearest way on in each of eight directions, out to
five times the nearest distance and no more than 40 m further than it, and not
where the straight leg to it would cross a building (`buildings` passed to
`createGraph`). The car parks needed it: their aisles are clipped away, and a
permit machine 10 m from the walk down the north lot's east side is 46 m from
the corner of the walk at its west end. With only the first, the Science
Success Center 89 m away was 272 m up the east side and round; across the
tarmac it is 98 m. Under 4 m you are standing on the pavement, and a pin
dropped on a path keeps the single answer the slack gives it.

**A detour, asked again wider.** That reach is the most the car parks needed,
and it can still leave a point with only a nearby path that goes the long way
round: a point on a lawn 7.2 m from walkway 1313 was offered ways on out to
36 m, the end of walkway 1314 was 58 m across the same grass, and a walk to a
point 123 m away went down 1313 and back up it, 336 m (the nearest-vertex
router, snapped to 1314, walked 155). So on the campus, when a walk comes out
more than twice the straight line between its two points, legs and all
(`DETOUR_SHARE`), and the point has ways on beyond the reach, it is searched
again with every way on within 60 m further than the nearest
(`OPEN_GROUND_WIDE_M`), bounded by the first answer, and the shorter answer
stands: 157 m on that lawn, and 230 of 37,391 test walks shorter, by 48 m at the
median. Widening the reach for every walk instead changed 7,118 of them, nearly
tripled the walks with a dotted leg over 60 m, and saved 1.3% of the walking.
The ways on for both reaches are gathered in the one scan of the edges.

**The campus, from the street side.** The streets join the campus only at the
gates, and the gate stage keeps those hundreds of metres apart on purpose (see
`build-approach-network.mjs`). So a point whose nearest edge is a street, but
which is plainly on the campus's side of it, would be walked along the street to
the next gate and back. Two cases are offered the nearest campus edge as well,
with the extra metres counted as above:

- **Inside the campus boundary**, at any distance. The street is on the far side
  of the line the streets were clipped at. The north car parks are the case:
  their aisles are OSM's, clipped away, and a permit machine there is 41 m from
  the road outside and 56 m from the walk through the lot. Arts & Science from
  that machine is 263 m through the car park and 495 m by the road. This needs
  `boundary` (`src/campus-boundary.json`) passed to `createGraph`; the
  open-ground rule above now finds that walk on its own too, 56 m being within
  40 m of 41, and the boundary is what still offers it further out than that.
- **Between the street and the campus, within 25 m** (`STREETSIDE_M`). This
  means the directions to the street foot and the campus foot are more than a
  right angle apart. The Admin bus stop is 4.7 m from the street's centreline
  and 16.7 m from the campus walk behind it. From the parking machine 41 m away
  the walk is 57 m, not 224 m. Across the road, with the street between you and
  the campus, nothing is added: the walk leaves along the street, not over the
  traffic.

This happens in two places, differently:

- **In the browser**, against the vertex cloud from `GET /api/vertices`, so a
  GPS fix or a dropped pin's Start here can be refused for reach before any
  request. The nearest vertex is never nearer than the nearest point on an edge,
  so this check is the stricter one. It is only a check: neither is moved to
  the vertex. A dropped pin used to be — planted on the nearest vertex the moment
  you let go — and since the build collapsed straight runs into long single
  edges that vertex is a median 6 m and up to 68 m from where the server joins
  the network; a vertex snaps to itself, too, so a pin dropped in a room never
  reached the building's doors below.
- **On the server**, because it is the server that has to be right. A GPS start
  and a dropped pin are both sent as the coordinate itself.

### Inside a building: the door, not the nearest face

The printed sheet draws a building's approach paths a few metres in through its
wall, and the build peels each one back to the wall. A room inside used to snap
onto that stub, so the walk ended where the drawn path goes in. With the stub
gone, the nearest point on the network can be a path running past a different
face, with no way in from it.

So a coordinate inside a building in `doors.json` is first asked whether it is
closer to one of the pieces peeled off under that roof than to any edge left.
If it is, it snaps to that piece's door — the nearer one, where a cut passage
left two — and `metres` is the distance to the door. Its ways on are then
**every door of that footprint**, that one first and the rest nearest first,
then — where those doors are a building's in `entrances` — every other way into
that building whose straight leg does not cross another building and is no more
than 40 m further than the nearest door (`OPEN_GROUND_MAX_M`; 60 m when the walk
is a detour, above), each leg through the building counted, and the walk picks;
nothing else is offered. Unbounded, the telephones in the Parking Garage, 7.7 m
from a door, began the walk to the Baseball field with a 132 m dotted line
across the deck; between two places, 28 legs ran more than 50 m further than the
nearest join. The footprint's drawn doors are not capped. The
other ways in are where the building's walls come nearest the network (below),
and they are what stops a door at the fork of two walkways being a dead end:
the Evangelisti Culinary Arts Center's north door hangs 7.5 m down one arm from
the apex, 3.7 m from the other, and the Oak Café inside walked 51 m to the
telephone on the other arm by the apex, 40 m by the node on that arm where the
walls come nearest. It used to be that one door alone, and a room has no
more reason to leave by the door nearest it than somebody in it does: a
defibrillator 33 m from the Gallery resolved to its building's east door, and
the walk to the Gallery went round the outside, 116 m; by the building's west
door it is 48 m. If not, it joins the
network as above. The build asks the same question and leaves those
destinations unspliced, so the two agree; today that is 21 destinations, and
only the Library's defibrillator lands somewhere the nearest vertex would not.

### A building: any of its doors

The card's Directions sends a building's entrance, which is one way in of
several: `src/directory.json` lists every drawn door of the footprint the card
stands on, then every point where the building's walls come nearest the
network (`doors`, entrance first), and `server/index.js` passes those lists to
`createGraph` as `entrances`. The second kind is each wall corner whose nearest
point on the network is within a metre of the nearest corner's — which corner
the network passes closest to is the drawing's slop, and the old router's end
was whichever of them had a vertex — and `scripts/build-walk-network.mjs`
splices a node at each, so a way in is always a vertex. A point the walls of
two buildings come nearest goes to one of them: to the building whose drawn
door it is, then to a building with no drawn door, then to the nearer. A coordinate that is one of a building's doors is
then every door of it, all at no distance — what was asked for is the building
— and the walk ends (or starts) at whichever suits it. The answer says which in
`door`, and the browser moves the pin there, so it is not left at the door it
was asked about with a dotted line across the building. With the entrance as
the only end, walks to the Parking Garage came in 71 m longer on average than
the nearest-vertex router's, and to Fine & Applied Arts 70 m; the box office
6 m from Fine & Applied Arts' south-west door was 238 m from its entrance.
With the drawn doors as the only ends, the walks that used to end by a wall
lost that end: restroom #51 to the Library went from 92 m to 171 m. A building
without a drawn door has its entrance at the nearest of the second kind.

The browser's own snap does not apply the rule. It only refuses a start beyond
`REACH_M`, which a door can never change — a door is never further away than
the building is wide — and the door is the server's to choose.

### `REACH_M`: the check that makes snapping honest

Snapping is unconditional. It will happily hand back the closest point on the
network to somewhere on another continent, so on its own it turns *any* request
into a confident walking route:

```
GET /api/route?from=2.3522,48.8566&to=-121.3448,38.6502     (Paris → campus)
→ 200 OK   distanceFeet: 7520   maneuvers: 27
```

The distance is real and the walk is real. It is not yours.

`REACH_M = 300` in `src/directions.js` is the line, measured rather than chosen:
a 60×60 grid over the graph's bounding box has a median distance to the nearest
vertex of 26 m, a 99th percentile of 121 m and a worst case of 215 m (the
nearest point on an edge is never further). Beyond
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

## 3. Path-finding

`new PathFinder(graph, { tolerance: 1e-7 })` walks the LineStrings, joins those
that share coordinates, and weights each edge by its true geographic length.
That graph — a public field of the library — is what the router searches.

**Precision matters here.** The library's default is `1e-5` degrees, and the
closest pair of *distinct* campus nodes is now `4.1e-6` apart — under the
default, not over it. Five pairs are closer than `1e-5`: sub-metre joints where
the build cuts a path at a building wall, each pair joined by its own short
edge. At the default those would weld into one vertex, the edge between them
would become a self-loop and vanish, and the route through that wall opening
would quietly break. `1e-7` is about a centimetre, which is the precision
`paths.json` is written at.

**The option is `tolerance`.** It was passed as `precision`, its name in
geojson-path-finder 1.x; 2.x ignores anything it does not know, so for as long as
this was on 2.1 the graph was built at the default: 6,966 vertices where the
files have 6,977, the eleven lost each merged into a neighbour about a metre
away or less. `test/router.test.js` holds the constant to the data and the built graph
to the constant.

**The search is our own Dijkstra** over that graph, not the library's
`findPath`. With two ways on at a foot and sometimes several feet at each end,
asking `findPath` pairing by pairing was dozens of searches a request. Ours runs
once per way on, seeded with that way's cost, stopping each time nothing on its
frontier can beat the best walk found. It runs once from every way on at once,
and again from each alone only when that joint search had to pass over a
pairing — one that walks less than the weld, or whose way on and way off are
the same place on the network, so that its walk would only go somewhere and
come back — since it keeps only the cheapest way to each vertex, and that can
be exactly the pairing passed over. About 0.4 ms between two places, 0.6 ms for
an arbitrary point on the campus and 0.9 ms from the streets around it, against
0.9 ms for the nearest-vertex router it replaced; the tail is about 2 ms at the
99th percentile, and the slowest route of a thousand takes 2.3 to 3.5 ms from
one run to the next. A detour is searched once more with the wider reach (§2),
bounded by the first answer; timed side by side with the router without that,
in one process, it adds a few percent on average and about a quarter at the
99th percentile. The absolute figures above want a quiet machine to check:
under a load average of 10 to 20, which is how this was last measured, a
thousand seeded routes came out at a mean of about 1.1 ms and a 99th percentile
of about 4 ms.

---

## 4. What comes back

```jsonc
{
  "geometry":     { "type": "LineString", "coordinates": [...] },
  "distanceFeet": 1204,
  "maneuvers":    [ /* see src/maneuvers.js */ ],
  "snapped":      { "from": [...], "to": [...] },  // where it really began
  "door":         { "from": null, "to": [...] }    // the door used, at a building's end
}
```

`door` is null at an end that is not a building. Where it is not, it is the same
coordinate as `snapped` at that end, and it may be another door of the building
than the one asked for; see *A building: any of its doors*.

`snapped` is not decoration — it is the server saying where it *actually*
started, which may not be where you clicked.

Three non-answers, and they are not interchangeable:

| Status | Meaning |
|---|---|
| **400** | `from`/`to` missing or not a coordinate pair |
| **404** | both ends are on the graph; nothing joins them |
| **422** | the request is well-formed but does not describe a walk — see below |
| **429** | too many route requests from one address — see `server/limit.js` |

Two things come back 422, and the server's `error` sentence says which. The
client shows it verbatim.

- **`unreachable`** — an end is further than `REACH_M` from the graph.
- **`same-place`** — both ends snap to the same place: the same vertex, or two
  points on one edge, or two vertices, less than the 2 m weld apart along the
  network. Both on one vertex used to come back as a path of one coordinate with
  a weight of zero, answered `200 OK`. Nothing downstream survives it: `lineString()` throws
  outright on a single coordinate, so the browser's handler died mid-assignment
  and left the panel on "Calculating…"; had it survived, `maneuvers.length - 2`
  would have printed "-2 turns" underneath. Two taps inside one courtyard do it.
  A building and anywhere inside its footprint are the same place too: from
  the Student Center's restroom to the Student Center, every door is an end of
  the building, so some pairing of doors always walks somewhere — out of one
  and round to the next — and that is not a walk anybody standing in the
  building wants. Two rooms in one building are two places, unless they
  resolve to the same door. And a walk that costs more than twice the cheapest
  pairing of ways on and off the search passed over — two that meet the
  network at one place — is refused as well, with its own sentence: the ends
  are the same place as far as the paths go, and the walk is a detour on not
  walking them at all (`DETOUR_SHARE` in `server/graph.js`). Two restrooms in
  the Student Center 2.7 m apart were a 124 m walk. Against the nearest-vertex
  router, over every pair of places, entrances and amenities and 200 random
  points (34,391 requests), 156 pairs it walked are refused: 31 a room or
  amenity and its own building by its doors (up to 147 m, for two points 33 m
  apart), 77 a place inside a footprint and that building (the Access Card
  Station to the Student Center, 62 m apart, was 190 m), and 48 detours on the
  paths (Receiving to the Rec. entrance, 37 m apart, was 410 m). 29 pairs it
  refused now route.

The invariant, stated once: **an answered route has at least two coordinates and
at least two maneuvers.** `test/router.test.js` holds the server to it.

`/api/route` is the only endpoint here that is not a precomputed constant, which
is why it is the only one that is rate limited and the only one not gzipped at
boot.

---

## 5. Rendering

The returned `LineString` goes into a GeoJSON source and is drawn as a ribbon
over whichever ground is underneath — Mapbox's or Google's. The ribbon is the
only thing a visitor ever sees of the approach network.

It is drawn wider than the path network under it at every zoom
(`ROUTE_CASING_WIDTH` and `ROUTE_WIDTH` in `src/route-layers.js`): a 12 px
casing and a 6 px line up to z18, then a width on the ground — 3.3 m and 2.3 m
from z19 — because the network becomes a ground width at z18 and doubles with
every zoom after it, and a route left in pixels ended up a thin thread down the
middle of it. `test/campus-sheet.test.js` evaluates both curves against each
other from z14 to z22.

`src/maneuvers.js` runs on the server to turn the path into turn-by-turn
instructions; `src/directions.js` runs in the browser to turn the distance into
"12 min · 8:24 PM · 0.3 mi". Both are pure modules with no DOM in them, which is
why the server can import the second one for `REACH_M` and its refusal wording.
