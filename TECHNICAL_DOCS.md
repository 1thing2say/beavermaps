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

Building the topology is `O(E)` over 8,285 segments, and it produces the same
graph every time. Done in the browser it was paid on every visitor's phone,
during the cold load, before the first route could be asked for.

`server/graph.js` builds it once at boot — about 60 ms — and holds it. The
client asks `POST /api/route` with two coordinates and gets back a line, a
distance and a list of maneuvers.

The graph is the union of three files, concatenated:

- **`src/paths.json`** — the campus's own paths, traced from its printed sheet.
  Owned by `scripts/build-walk-network.mjs`. This is also what gets *drawn*.
- **`src/plaza-paths.json`** — the ways across the sheet's paved plazas, the
  walkways it paints as filled surfaces rather than strokes: 590 straight
  crossings, 4.6 km, over eight of the ten plazas, round everything that stands
  on them. Written by the last stage of the same script. Routed over, **never
  drawn**: the plaza is already on the map as paving, and a walk across it
  shows on the route ribbon. Their ends weld to `paths.json`'s vertices the way
  the gates do; their corners are vertices only they touch.
- **`src/approach-paths.json`** — the surrounding streets, from OpenStreetMap.
  Owned by `scripts/build-approach-network.mjs`. Routed over, **never drawn**,
  because whichever provider is painting the ground is already drawing them.
  By default that script re-gates the streets already in the file against the
  current `paths.json` and leaves them otherwise byte-for-byte. Only `--fetch`
  goes to Overpass, so a campus rebuild cannot bring in OSM edits nobody has
  reviewed. Besides the streets (`source: 'osm'`) it holds the gates onto the
  campus (`'gate'`, 12 m at most) and four `'lot'` connectors, straight across
  a car park from an entrance the campus clip cut to the campus path beyond —
  78 to 111 m, which is why they are their own source.

Concatenation *is* the merge. `geojson-path-finder` derives topology from
coordinates rather than from feature identity, so the sixteen gate connectors
and four lot connectors that script prints on every build weld to campus vertices simply by ending on them at the same seven
decimals, and so do the plaza crossings.

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
ends at a door of it, not on a path beside it. Both ends of every edge joined
within the slack are offered too, so a walk can stop at the corner it comes
to rather than run on to the foot and step back off it: the walk from Room 560
to CalWORKs used to end in a 127° hook, and the hooks at the ends of walks
between two places went from 99 to 61. A pairing whose walk along the
network would be shorter than the weld is passed over: it is "cross the ground
and you are there", and there is nothing to draw.

**From open ground, every way.** The slack is for a tie of a metre or two. A
point at least 4 m from any path (`OPEN_GROUND_M`) — the middle of a car park, a
lawn — is also offered the nearest way on in each of eight directions, and any
other in that direction no more than 5 m further than that one (three at
most), out to five times the nearest distance and no more than 40 m further
than it (off the campus, no more than 5 m further: OSM draws the footways
that serve a stop, and the bus stop for lines 1 and 82 used to walk 42 m to the
street's centreline past one 8.9 m away). The car parks needed it: their aisles are clipped away, and a
permit machine 10 m from the walk down the north lot's east side is 46 m from
the corner of the walk at its west end. With only the first, the Science
Success Center 89 m away was 272 m up the east side and round; across the
tarmac it is 98 m. Under 4 m you are standing on the pavement, and a pin
dropped on a path keeps the single answer the slack gives it.

**A wider reach, at a price.** That reach is the most the car parks needed,
and it can still leave a point with only a nearby path that goes the long way
round: a point on a lawn 7.2 m from walkway 1313 was offered ways on out to
36 m, the end of walkway 1314 was 58 m across the same grass, and a walk to a
point 123 m away went down 1313 and back up it, 336 m (the nearest-vertex
router, snapped to 1314, walked 155). So on the campus, from open ground and
out of a room, every way on within 60 m further than the nearest
(`OPEN_GROUND_WIDE_M`) is offered too, in the same search, each charged half
again for every metre of its leg beyond the first reach
(`OPEN_GROUND_WIDE_CHARGE`): a leg 20 m past it has to save 10 m of path. Free,
the wider reach changed 7,118 of 37,220 test walks and nearly tripled the
walks with a dotted leg over 60 m to save 1.3% of the walking. So for a while
it was searched only when the first answer was a detour, more than twice the
straight line (`DETOUR_SHARE`). That made the better walk depend on the first
being bad enough: a new edge that brought the first answer just under twice
switched the wider search off, and three connectors added through the north
lot took Drop-off North to the permit machine there from 213 m to 351 m.
Charged per way on, a way on offered beside the drawn edges can only make a
walk cheaper (a new drawn edge can still cost a walk a little, by changing
which corners a point is offered; see `LEG_CHARGE`). Against the
detour rule, over 15,323 walks between places, amenities and 2,000 random
campus points, 2,589 come out shorter (by 15 m at the median, 204 m at most)
and the walking falls by 1.1%; the dotted legs over 60 m go from 740 to 1,882.
At no charge they would be 2,403, for 5% more saving. The ways on for both
reaches are gathered in the one scan of the edges.

**The plazas, beside the paths.** The plaza crossings are campus network once
a walk is on them, but nothing a point is measured by is measured to them: the
nearest edge, the slack, whether a point is on open ground, the directions it
can leave in and whether a room is nearer a peeled stub than the network are
all asked of the drawn edges, and the foot of each crossing within the drawn
slack is offered after, unless its leg crosses a building. Measured like any
other edge, a crossing 3.4 m from the Math Learning Center put it under the
4 m open-ground mark, five ways on became one, and its walk to Para Transit
went from 333 m to 377 m; of every walk between two places, 539 came out
longer. Offered beside the drawn edges they lengthen none, and
`test/plaza.test.js` holds every pair of places to that, and to a connector
added through the north lot doing the same. The lot connectors that now run
through the north and south-west car parks are offered the same way, beside
the drawn edges: a lot's pin stands on one (Myrtle Parking Lot West is 0.2 m
off it), and measured as its nearest edge it lost every way across the tarmac
and its walk to the Administration Building went from 307 m to 371 m.

**Never through a building, and never for free.** No way on is offered whose
straight leg goes more than 1.5 m into a building's footprint (`WALL_CLIP_M`,
`buildings` passed to `createGraph`) — the nearest join no more than any
other, and the building a leg ends at no exception. Only the open-ground ways
used to be asked, and a leg was let through any building either end of it
stood in; a door is on its wall or just inside it, so a leg to one was let
through the whole building. Para Transit left by a 43.7 m leg to the Arts and
Science door, 21 m of it through Arts and Science; a stall in lot 42 crossed
35.4 m of CTE; a bike rack among the portables joined the walk through one.
Now the last 2 m of a leg stands for the door's own wall, the building a
point is inside is let off only on its way out, and depth rather than length
is what counts, so a leg along a wall a metre under the drawn roof is beside
the building: Receiving's walk north up the car park beside its loading dock
is that, and refusing it sent 137 walks round by the south. Where every way
on is behind a building, the ways round it are offered — the nearest clear
one in each direction, read every 2 m along the edges out to the wider
reach — and only where there are none of those does the nearest stand. Of
the legs walked between places, amenities and entrances, 41 went more than
1.5 m into a building, 36 of them more than 3 m; none does now.

Every metre of a leg beyond the nearest join is charged 0.3 again
(`LEG_CHARGE`), and every metre past a drawn path it steps over on the way
to another once again (`CROSSING_CHARGE`), with the path it steps over
offered as a way on where it crosses. Costed at its straight metres a
diagonal across a lawn always beat the path round two sides of it: a bike
rack beside the Child Development Center took a 61.3 m leg across the grass,
and a telephone on the Gym's north wall walked 47.7 m over the walkway outside
it and 26 m of lawn to the next. Over the 10,440 walks between two places the
dotted legs come to 369 km instead of 472, and the walking to 3,174 km instead
of 3,150 km, 0.8% more; none is refused that was answered or answered that
was refused. Legs over a drawn path before their join went from 163 distinct
to 29. Both charges are fixed per way on, so `test/plaza.test.js` still holds
every pair of places to costing no more with the plazas than without; in
walked metres 121 pairs come out longer with them, by 3.8 m at the median and
25 m at most, each having traded dotted leg for path. A room's ways out that
are not its own footprint's drawn doors are offered only where the leg runs no
more than 4 m outside the building and over no drawn path; see *Inside a
building: the door, not the nearest face*.

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
that building whose straight leg does not go through another building, runs
no more than 4 m out of doors and over no drawn path, and is no more
than 40 m further than the nearest door (`OPEN_GROUND_MAX_M`; out to 60 m at the
wider reach's price, above), each leg through the building counted, and the walk picks;
nothing else is offered. Without the second and third conditions a room walked
out of its building and over the paths outside to where the walls come nearest
somewhere else: the Counseling Center, inside Administration, left for the lawn
west of it by a node on another face of Administration, 35.9 m off and over the
path between. Seven such ways out of four rooms are turned away. Out of doors
is outside every footprint of the building, not only the room's: CTE is drawn
as two footprints that abut, and the Design Hub and the MCT HomeBase, in one,
were refused CTE's north door on the other for metres that never leave the
building, the second footprint held against the leg as a wall besides. Leaving
by it, the MCT HomeBase walks 48 m to the bike rack north of CTE, not 98 m
round. Unbounded, the telephones in the Parking Garage, 7.7 m
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
splices a node at each, so a way in is always a vertex: 88 of them. Three
more kinds follow. The drawn doors of a building's other footprints come
straight after the home footprint's (four were listed nowhere, on Science &
Engineering's wings and the CTE's north wing). A building drawn as several
footprints offers each shard's own nearest point, within 12 m of its walls,
where no way in lies within 20 m (`memberNearest()` in
`scripts/building-names.mjs`; 11 today, the Portable Village's and TEW's
far portables among them), spliced like the rest. And a corner of the plaza
crossings standing about as near the walls as the network does is offered
last, since the router walks plaza vertices like any other. A point the walls of
two buildings come nearest goes to one of them: to the building whose drawn
door it is, then to a building with no drawn door, then to the nearer. None
is listed inside another building's footprint, or a weld or two from another
building's way in when it is plainly nearer that building's walls; and none
within 10 m by the network of a drawn door at the end of a dead-end approach,
because that is the door's own approach path: Kinesiology's wall-nearest point
was 7.3 m back along it, and walks ended there, short of the door. A coordinate that is one of a building's doors is
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
closest pair of *distinct* campus nodes is now `2.9e-6` apart — under the
default, not over it. Six pairs in `paths.json` are closer than `1e-5`:
sub-metre joints where the build cuts a path at a building wall, each pair
joined by its own short edge. Another 72 are among the corners and cuts of the
plaza crossings. At the default those would weld into one vertex, the edge between them
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
be exactly the pairing passed over. Timed side by side in one process under a
load average of about 3, against the router as last committed (before the
plaza lines, the wider reach on every request and the rooms' ways out): 0.86
against 0.53 ms between two places, 0.9 against 0.68 ms between two arbitrary
points on the campus, and 1.6 against 1.5 ms from the streets. That is about
1.6 times slower between two places, all of it added a step at a time; when
the plazas came in it was about 0.4 ms, against 0.9 ms for the nearest-vertex
router it replaced. The tail is 1.4 to 2.1 ms at the 99th percentile between two
places, and the slowest of 1,554 takes 3.5 to 6 ms from one run to the next.
The wider reach (§2) is in that search every time there is
one; timed side by side in one process against searching it only for a detour,
that adds about a tenth on the campus, on average and at the 99th percentile,
and nothing from the streets. Keeping legs out of buildings and charging the
ones over a path (§2) adds nothing that shows: side by side, 0.79 against
0.74 ms between two places, 0.99 against 1.02 ms from an arbitrary point.
The absolute figures above want a quiet machine to check:
under a load average of 10 to 20, which is how this was last measured, a
thousand seeded routes came out at a mean of about 1.1 ms and a 99th percentile
of about 4 ms.

---

## 4. What comes back

```jsonc
{
  "geometry":     { "type": "LineString", "coordinates": [...] },
  "distanceFeet": 1204,
  "legFeet":      { "from": 38, "to": 0 },        // the dotted legs, not in distanceFeet
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

`legFeet` is how far each dotted leg is: from the point asked about to
`snapped.from`, and from `snapped.to` to the other. `distanceFeet` is the line
alone and stays so, so nothing reading it changes; the card adds the two. Between
two places they come to a median 33 m (42 m before the legs were charged), and to
more than a quarter of the walk in 19% of walks. A building's end is nothing:
its pin moves to the door the walk used.

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
"12 min · 8:24 PM · 0.3 mi". The instructions are read off corners, not
vertices: bends less than 10 m apart are one corner, judged by the bearing 6 m
either side of it, so the sheet's drawing — curves of 2 m segments, dog-legs
where a stroke was anchored at a crossing — stops being a stream of "bear
left, bear right". Given each vertex's degree and branches it also drops a
gentle bend with no choice on it, says "keep left" at a fork, and given the
two points asked about, the turn onto the path and the side the destination is
on. `route()` in `server/graph.js` gives it each vertex's degree and branches —
the drawn paths and the streets meeting there, not the plaza crossings or the
lot connectors, which nobody can see to take — and the two points asked about.
Over the 13,440 walks `buildManeuvers` is measured on, that takes the turns
said from 68,493 to 64,583, and the "bear"s at a vertex with no other way from
7,762 to 68. The distance on the card and the banner is the line plus the two dotted
legs (`legFeet` from the server, or `measureLegs` in `src/route-state.js`
where it sends none), and both say it in
`walkLabel`'s words. Both are pure modules with no DOM in them, which is
why the server can import the second one for `REACH_M` and its refusal wording.
