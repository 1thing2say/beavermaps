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

Search a destination or drop a start (green) and end (red) point; the route
snaps to the network and the panel shows the walking distance and turn count:

<img src="assets/demo.png" alt="my campus's campus map: a Google-Maps-style interface with a pill search field reading Library, a strip of category chips for Restrooms, Parking, Food and drink, Bus stops and Bike racks, a blue walking route drawn from a green pin to a red one, and a panel reading 666 ft, route calculated, 7 turns" width="720">

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

A GeoJSON `FeatureCollection` of **803 `LineString` segments over 725 nodes**,
13.6 km in total. It **is** the light-grey paths my campus's printed map draws —
`scripts/build-walk-network.mjs` takes those polylines verbatim and makes the
smallest set of edits that turn a drawing into a graph.

That is the whole idea. Walkways on the sheet are stroked paths carrying a real
ground width — 105 of them, 10.5 km, 3.3 to 13.2 m wide — and the driveways and
crossings are drawn the same way, so those strokes *are* centrelines. Tracing
them gives a network that lies on the drawn pavement by construction:

| where a segment sits | my campus's own graph | traced from the sheet |
|---|---|---|
| drawn walkway | 411 (59%) | **623 (78%)** |
| driveway | 88 (13%) | **161 (20%)** |
| crossing | — | 6 (1%) |
| through a building | 83 | **0** |
| over lawn | 85 | **12 (1%)** |
| over parking bays | 27 | **0** |

#### Why not my campus's own routing graph

Their wayfinding app ships one in `Batch.json` — 696 edges over 580 nodes — and
this project used it for a while. It is real, it is theirs, and it is not the
same thing as the map. It draws a path along *both* sides of the Hutchison Loop
parking aisle, the northern one straight through the parking bays, and 83 of
its edges cut through building interiors. On screen that reads as nonsense,
because the pavement it describes is not the pavement the sheet shows. Their
own app never draws it — it only ever draws the computed route, so none of this
is visible to their users.

`Batch.json` is still the source for `places.json` and its `nodeIds`; only the
routing network stopped coming from it.

#### The seven stages, and why each exists

1. **Node.** Illustration linework crosses rather than joins — intersections
   happen mid-segment with no shared vertex. Every crossing is cut into both
   lines, or a junction on screen is not a junction in the graph.
2. **Weld.** Vertices within 2 m become one node; a draughtsman's "touching"
   endpoints sit a metre or two apart.
3. **Collapse.** *This is the one that matters.* The sheet draws corridor twice
   all over — a footway shadowing a driveway, a walkway drawn over itself, and
   every bar of a zebra crossing as its own stroke, so one crossing becomes five
   parallel routes. On paper the duplicates render as a single grey band and
   nobody can tell; ride a centreline down each and you get two and three lines
   threading one path.

   **The tolerance is the drawn width, not a constant.** Two centrelines are one
   corridor when the strokes painted on them overlap — half the sum of their two
   widths, floored at 3 m. A flat 3 m was the old rule, justified by paths being
   3.3 m wide: true of a walkway, wrong for a 6.6 m driveway, whose own edge is
   3.3 m from its centre. The footway beside the Portable Village runs **3.23 m**
   from that driveway's centreline — inside the carriageway it is drawn beside,
   dead parallel for 60 m — and missed the old cutoff by **23 cm**. It shipped as
   two separate ways, so an 11 m walk routed 404 ft up one and back down the
   other. The sheet has carried a per-stroke `width` all along; the script read
   it and threw it away. Using it takes 288 merges to **498**.

   Where the survivor lands follows the same logic: equal widths keep the
   **midpoint**, because a walkway drawn over itself really does have its
   centreline between the two strokes — but unequal widths keep the **narrower**
   one, because the pedestrian line beside a carriageway is the footway, not the
   average of footway and road. That is the preference *Dedupe* already applies
   by kind. Nodes are merged, never deleted, so no connection the drawing makes
   is lost.
4. **Tee.** The gap the first three leave. *Node* cuts where two segments
   **cross**, so a stroke that *ends* on another never produces a cut — it does
   not cross it. *Weld* joins vertex to vertex, and there is no vertex halfway
   along a line. *Collapse* does project a node onto a segment, but only one
   running the same way, because it exists to merge duplicate corridors — which
   excludes the perpendicular T-junction exactly. So a footway drawn up to a
   walkway and stopping half a metre short was a junction on paper and nothing
   at all in the graph, and the map showed paths ending mid-car-park with a
   round cap. 32 dead ends are teed onto the stroke they stop short of, at a
   3 m one-path-width tolerance.
5. **Junction.** Two lines that pass within a few metres and never join. It is a
   junction on paper and nothing at all in the graph, and none of the four
   stages above can see it: it is not a crossing, so *Node* cuts nothing; it
   shares no vertex, so *Weld* has nothing to join; neither end is loose, so
   *Tee* skips it; it is not parallel, so *Collapse* excludes it. That shape
   turned an 11 m walk into 140 ft.

   The guard is what makes this safe: a junction is welded only where the graph
   **already makes you walk six times further around** than the ground distance.
   Paths that legitimately pass close without meeting — a ramp beside its stair,
   a way over a culvert — are left alone, because for them the walk-around is
   already short. 12 are welded. It adds a node; it never adds a metre.
6. **Link.** The one stage that is *not* the drawing. `src/path-links.json`
   holds connectors added by hand where the sheet omits something plainly
   visible on the ground, each with a `why` naming what is there and what the
   sheet drew instead. It is a separate file, applied as its own stage, and its
   count and metres print on every build — currently **11 links, 191 m out of
   13.6 km (1.4%)**, so the invented share is never in doubt.

   Three of the eleven are **rescues**: connectors that bring a whole stranded
   fragment into the largest component. They carry **571 m, 409 m and 120 m** of
   my campus's own drawn linework — 1,100 m returned to the routable network for 46 m
   of connector. The largest is the entire perimeter footway around the south car
   park, which was stranded because the sheet never joins it to campus; it comes
   within **9.7 m** of the network at the head of the accessible bays, across
   hatched crossing markings and unbroken tarmac.

   Every link is load-bearing, and the two kinds are tested differently. Local
   links are ablated on the walk between their own endpoints. That test is
   meaningless for a rescue — pull one and its fragment is pruned, so an endpoint
   stops existing and the measurement compares two snaps onto the same surviving
   node — so rescues are ablated on **shipped metres** instead.

   **It is a last resort, and the first attempt got this wrong.** That pass wrote
   15 links; checked afterwards, **eleven of them ran parallel to a path my campus
   already draws**. The gap was never a missing path — it was a drawn path
   failing to join the graph — so a straight connector alongside it fixed the
   number and left two splintered lines down one corridor on screen. *Junction*
   repairs the cause instead, and six of the fifteen were then shown redundant by
   ablation: removed one at a time, rebuilt, and the detour did not come back.

   These came out of a sweep, not a hunch. All-pairs shortest path over the whole
   graph, flagging every pair of nodes within 30 m of each other that is four
   times further apart *through the network*: 31 distinct gaps, the worst of them
   23 m on foot and **592 m** to walk. Each was then checked three ways — against
   my campus's ground polygons in painter's order, against an excess-green measurement
   of the satellite imagery, and by eye at z21.

   **Fourteen were accepted and seventeen refused**, and the refusals are
   recorded in the file next to the links. Nine cross building footprints, four
   cross lawn or a grassed swale, two end on a roof, one ends in a planted bed
   and one crosses a kerb with no dropped ramp. They will keep showing up as
   large detours in any future audit, and they should: being near is not the same
   as being connected. A second pass over the rebuilt graph surfaced five more
   candidates and refused all five.

   The clearest accepted case is the Hutchison Loop bus stop: the sheet draws the
   zebra crossing over the road and stops at the kerb, but the crossing lands on
   a concrete pad that ramps down to the south footway. Without it, an 11 m walk
   across the road routed 804 ft round three sides of a rectangle.
7. **Splice.** The router only accepts vertices, so every positioned
   destination gets a node at its closest point on the network — otherwise a
   path can run right past a building while its nearest *vertex* is fifty
   metres away, and the destination quietly resolves somewhere else.

There is still deliberately **no automatic bridging step**. An earlier version
closed gaps between fragments with 42 *generated* connectors — a guess made 42
times unsupervised. *Link* is the opposite of that: each entry is written down by
hand with a reason and counted in the log. And teeing is neither: it splits an
edge that already exists at a point a dead end is already touching, and it adds
no length of its own. Turning it off drops the shipped network from 12,255 m
over 16 fragments to **11,603 m over 29** — 652 m of already-drawn path that
would otherwise be thrown away for want of a junction. 3 m is where that trade
turns, too: measured at 5 and 8 m the largest component starts *losing* nodes,
and by 8 m total drawn length falls, because dead ends begin merging onto paths
they merely pass near.

#### The biggest thing still wrong

**479 m of drawn path still never reaches the routable graph** — 26 strokes,
measured by sampling each drawn walkway, driveway and crossing and asking
whether anything in `paths.json` runs within 3 m of it. It was **1,694 m over 34
strokes**, including a 357 m driveway, a 204 m driveway and a 150 m walkway, all
100% absent.

The cause was not what it looked like. *Dedupe* was the obvious suspect and is
almost innocent: it drops 151 m in total, of which only **6 m** is genuinely
uncovered by the surviving stroke — every real duplicate on this sheet is
shadowed at 75–100%. It is now hardened anyway, because nothing was stopping
that 6 m from becoming 600 m on a data change: a stroke with an uncovered tail
over 4 m is kept rather than dropped whole, and the count prints.

The actual loss was **stranded fragments** — 1,324 m in 14 pieces that never
join the largest component. Three of them account for 1,055 m and sit 9.7 m,
15.7 m and 20.6 m from the network; those are now rescued through
`path-links.json`. The seven that remain need **75 to 117 m** of invented path to
reach, which is the automatic bridging step this pipeline refuses to have. The
largest stroke still missing is 72 m.

The cost is still paid honestly: whatever the drawing leaves genuinely
disconnected stays disconnected — 16 fragments over 86 nodes, down from 31 over
143 — and only the largest component ships.

#### One projection, applied to everything

Everything — network, artwork, buildings, labels — comes out of one SVG
coordinate space through `scripts/projection.mjs`, and nothing is nudged
afterwards. Residual error is therefore shared: it moves the whole map as a
body and never shows.

An earlier pass fitted per-node corrections onto OSM linework. It is deleted
and should not come back. Because the corrections were keyed by my campus node ID
they could never be applied to artwork that has no node IDs, so they moved the
grid and left the drawing behind — and they pushed **15 of my campus's own
destinations out of their own buildings** (75 of 145 places landed inside a
footprint, against 90 after removal). Improving one layer's agreement with an
outside reference makes the map disagree with itself. Fix the transform or
retrace the source; never nudge a single layer.

### Off campus (`src/approach-paths.json`)

my campus's sheet stops at the fence and so did the router: click a start point on the
pavement outside and the nearest graph vertex was somewhere inside the campus,
so the walk began in the wrong place. `scripts/build-approach-network.mjs` adds
the streets you arrive by — **6,342 segments, 125 km** in an 800 m apron.

**It is not Google's paths, and it cannot be.** The Map Tiles API serves
*pictures* of roads; there is no graph in a raster tile and nothing in the
response says where a footway goes. Their Routes API does know, but it is a
per-request billed server call answering in its own geometry — a second network
to stitch to ours at every entrance, with its own snapping and its own idea of
where the kerb is. That seam is the thing this file exists to remove. So the
off-campus network comes from OpenStreetMap, which is where the campus boundary
already comes from and what Mapbox draws from anyway. One graph, one router, one
route line, turn-by-turn that works across the fence, no per-request cost.

**Nothing from this file is ever drawn.** Whichever provider is painting the
ground is already drawing these streets, and putting ours on top of theirs is
exactly the doubled linework the campus edge used to show. The only thing you
see from it is the route ribbon lying along it.

Five stages, each printed on every build:

1. **Fetch** every OSM way in the apron a person on foot may legally use —
   selected by exclusion, because listing what to *keep* silently drops a footway
   with an unexpected tag, and around a campus those are the paths people take.
2. **Clip** to the apron *and* to the campus. Both are load-bearing. Overpass's
   bounding box selects **ways**, and `out geom` returns each match whole — Auburn
   Blvd came back running two kilometres past the box. And inside the fence my campus's
   drawing is the better data: OSM has a dozen generalised paths where the sheet
   has 141 walkways.
3. **Weld** coincident vertices at 0.5 m. Connected OSM ways share a node
   exactly, so this guards rounding rather than inventing junctions — and ways
   that merely *cross* are left crossing, because in OSM that means a bridge.
4. **Gate** — join the two networks where my campus's linework already reaches the
   street. **15 connectors, 38 m in total.** Ten of them are under 2 m and are
   the same ground drawn twice; the other five are listed individually with their
   length, and each is the only way in within 250 m.
5. **Prune** to the component the campus is in, seeded from the campus rather
   than from the largest piece — what has to ship is what a walker standing on
   my campus can actually reach.

The gate guard is the part worth stating. my campus draws its own perimeter driveways
and OSM draws the same streets about three metres away, so for hundreds of
metres the two run side by side and every campus vertex along them looks like a
door. The first version used `build-walk-network.mjs`'s local test — "already
joined within six times the gap" — and accepted **80** connectors: the second one
twenty metres along the same kerb sees a 43 m walk round through the first, which
is outside a 19 m cap, so it is admitted, and so is the next. That is sewing a
seam, not finding a door. The question is absolute, so the threshold is: a
connector over 2 m is only taken where the merged graph does not already put its
two ends within 250 m of each other on foot.

The server unions the two collections into one `PathFinder` —
`geojson-path-finder` builds topology from coordinates, so concatenation *is* the
merge, and the gate connectors end on my campus's vertices at exactly the seven
decimals those vertices are written at. `/api/network` still serves my campus's paths
alone, for drawing; `/api/vertices` serves every vertex in the merged graph, for
snapping.

### The routing flow (`src/main.js`)

- **On load** it asks the server for two different things, because what gets
  drawn and what gets routed on are no longer the same set. `/api/network` is
  my campus's own paths, drawn the way Google Maps draws a road — two line layers over
  one source, a white core inside a wider grey casing — so the routing grid and
  the pavement my campus drew underneath it read as one thing rather than an overlay,
  and clipped at the boundary so it never lands on a road the basemap is already
  drawing. `/api/vertices` is every vertex in the *merged* graph, campus and
  approach streets alike, as bare coordinate pairs; that is what clicks snap to.
- **On click**, `turf.nearestPoint` snaps the click to the closest vertex — which
  is why a start point on the pavement outside now stays outside instead of
  being dragged onto the campus. The first click becomes the start marker, the
  second the end marker — both drawn as Google's pin (`googlePin` in
  `src/map-images.js`), green for the origin and red for the destination,
  anchored at the tip rather than the centre.
- **Routing** posts both ends to `/api/route`, where one `PathFinder` over the
  merged graph answers with the path, the distance and the turn-by-turn. The
  geometry feeds a `calculated-route` source (Google's navigation blue,
  `#4285f4`, over a darker blue casing). A missing path clears the end marker
  and shows an error.
- **Framing.** A finished route is brought into view unless it is already there
  — the same rule the category chips use, and for the same reason: a gratuitous
  `flyTo` throws away wherever the user had panned to. This is also why picking a
  destination no longer flies to it when a start point already exists; doing both
  landed on the destination and then judged the route against the view it had
  before the flight, leaving half the walk off the top of the screen.
- **Clear** (button, or a third click) removes the markers and empties the route
  source.

## The interface

The chrome is modelled on Google Maps, because that is the interface everyone
arriving at this app has already learned. The map is the page and everything
else floats over it — a full-bleed canvas, a pill search field, a chip strip
across the top, the layers switcher in the bottom-left corner and the map
controls in the bottom-right. The previous layout put a 600 px map inside a
padded card under a page heading, which spent the top third of a phone screen on
furniture.

### Appearance: light, dark, auto

Three states, and the third one is why it is not a switch. **Auto is not a
colour** — it is the absence of a choice, the app deferring to
`prefers-color-scheme`. A two-way toggle can express dark and light but has
nowhere to put "go back to following the system", so the moment a visitor
touched it they were pinned to whatever they picked, permanently. Google uses
the same three under Settings → Appearance.

It appears twice and holds no state in either place: the **rail** carries a
one-glyph cycle, and the **layers menu** carries the explicit three under their
own heading — which is what a phone gets, since the rail is hidden below 640 px.
Both are redrawn from a single `mode` on every change, so neither can drift.
What is persisted is the *mode*, not the resolved theme; storing "dark" because
someone picked Auto on a dark machine would silently pin them the first time
they opened the app at night.

#### The night preset was eating the buildings

Starting a walk turned the campus into pitch-black blocks, and ending it left
them there. Two independent faults, both worth naming because both are the kind
that read as a styling choice:

- `campus-buildings` was the one layer in the file **missing
  `fill-extrusion-emissive-strength`**. Mapbox Standard lights extrusions through
  its own model, and under the night preset that drove an authored `#2f3336` to
  roughly `#0c0d0d`. Every other custom layer already carries this opt-out with a
  comment explaining it; the extrusion is the one that was missed. It is set to
  **0.75, not the flat 1** the others use — they are ground planes and want their
  colour rendered exactly as written, while this is the only genuinely
  three-dimensional thing on the map, and at 1 every face renders identically and
  a building reads as a sticker.
- Nothing ever took the layer down. Extrusion is navigation-only — every other
  reference to it in `main.js` is guarded by `navActive` — but `endNavigation`
  never removed it, so the blocks outlived the walk that put them there.

### Where our map stops (`src/campus-clip.js`)

The rule is "inside the boundary the map is ours and outside it is theirs", and
for a while only half of it was enforced. `addCampusMask` took the basemap's own
data *out* of the campus; nothing stopped parts of my campus's sheet being drawn
*outside* it, on a ground that was already drawing the same things. That was
what the seam at the campus edge was made of:

| drawn beyond the fence | what it landed on |
| --- | --- |
| 23 `offsite_road` elements | Auburn Blvd, Myrtle Ave and College Oak Dr, drawn a few metres off the provider's own |
| 2 `north_arrow` elements | a print convention with nothing to point at on a rotatable map, sitting in a residential street |
| 21 crossings, 59 tree canopies, 2 driveway stubs | the public verge |
| 17 segments of the white path ribbon | a public road the basemap was drawing underneath it |

`trimToCampus` handles both shapes. A **LineString is cut** at the boundary and
its inside parts kept — dropping it would be wrong, because a driveway that runs
out to the street has to stop at the gate, not vanish from the last junction
inside it. **Anything else is dropped only when it lies wholly outside**;
clipping a polygon to a fifty-vertex ring is a much larger problem, and what it
would buy is a metre of overhang on the elements that straddle the line. Wholly
rather than mostly for a second reason too: the crossings at my campus's entrances are
drawn straddling the boundary because that is where they are, and a majority test
eats the campus edge rather than tidying it.

Three amenities are a deliberate exception — the bus stops on the perimeter road
sit outside the ring, and Google draws a generic transit icon near each. They
stay, because my campus publishes them by route and direction ("Bus 1 Heading North")
and that is information the campus map exists to carry.

### Labels, at Google's sizes

my campus set its building names between 6.0 and 14.5 pt, and that ordering is real
information — Library is 13.1 pt against Oak Cafe's 6.6. Using those numbers *as
pixels* was the mistake: they were set for a sheet 34 inches wide, and they gave
a 6.6–16 px spread against the 11–15 px Google sets its own labels in. On the
Google ground ours were visibly the smaller map's type on the bigger map's
ground.

Two changes, both measured off the raster rather than taken from a spec. The
print range is **remapped onto Google's band** (their road labels are 11–12 px,
an ordinary POI 12, a prominent one 14–15) and the ordering survives the remap.
And the zoom ramp is **flattened from 1.1×–1.9× to 0.86×–1.1×**: a Google label
is very nearly the same size at z15 as at z19, because their type is chrome for
reading the map rather than something drawn on the ground. Ours grew with the
campus, so the two agreed at exactly one zoom level and diverged either side.

Bigger type is wider type, and width is what the collision solver charges for,
so this was measured against the running map before and after: **27 of the 39
building names place at the default view, against 28 before.** One name, for
labels that stop announcing which half of the map you are reading.

### Pins that look like Google's

Ours were flat discs centred on the place. Google's are balloons — a round head
on a short tail, a thick white ring around the whole silhouette, a white glyph
inside, and the **tip** on the place rather than the centre. Side by side on the
same map that read as two maps' markers, which is what it was.

Both proportions were wrong on the first cut, and both are measured off a 3x
capture of their raster: their marker is 50 px wide and 60 tall, so the tail
drops only about **four tenths of the head's radius** below it — draw it by eye
and it comes out nearly twice that and reads as a balloon on a string. And their
white ring is a good **eighth of the total width**, not the hairline a 2 px
stroke gives at this size.

The tail is drawn as two curves leaving the head at its widest point, where the
circle's tangent is vertical, so a control point directly below continues the
curve smoothly. Start it anywhere else and the join is a visible corner — the
difference between a pin and a lollipop.

One compromise is worth naming. With the tip on the place, a label set beside the
head needs a fixed ~12.5 px lift, but `text-offset` has no unit except ems — and
an em here is whatever size my campus set for that particular name. One value cannot be
exact for both the 11 px labels and the 16 px ones; 1.0 em splits it and leaves
the extremes about 3 px out, which at this size does not read. The horizontal gap
has the opposite property and genuinely wants ems, because a bigger name should
stand further off its pin.

### Building POIs

Google never labels a place with bare text: it draws a small coloured disc and
sets the name beside it, and the colour carries the category. That is most of
why their map is scannable — you find the gym without reading every label. my campus's
sheet sets all 39 building names in one ink.

So every printed building name now gets a disc, classified in `src/poi.js`:

| disc | colour | buildings |
| --- | --- | --- |
| `campus` | Google service blue | 15 — the general teaching and service buildings |
| `sport` | green | 6 — Main Gym, Practice Gym, Pool, Adaptive PE, Rec., Kinesiology |
| `works` | grey | 5 — Operations, Sign Shop, Auto Yard, Ranch House, Portable Village |
| `arts` | purple | 4 — Fine & Applied Arts, Gallery, Music, Theatre |
| `food` | orange | 2 — Oak Cafe, Evangelisti Culinary Arts Center |
| `library` | blue | 2 — Library, Learning Resource Center |
| `store` · `civic` · `childcare` · `parking` | blue | 1 each |

The classification lives in the app rather than in `build-labels.mjs` because it
is presentation, not data — `labels.json` stays exactly what my campus's cartographer
set, and the discs are attached on the way into the map source.

Two rules are order-dependent and the tests pin both: the **Evangelisti Culinary
Arts Center** is a kitchen that contains the word "Arts", and **Arts & Sci** is a
general teaching building that does too. One label, "Closed", gets no disc — it
names a fenced-off area, not a place, and it is the only name allowed to opt out.

#### One icon language, not two

my campus's sheet draws its own pictograms, and the app redraws several of them as
discs. Where both are on the map you get two icon languages stacked on one
point, so `REDRAWN` in `main.js` hides the printed version of every class the
app draws itself.

Two layers held out for a long time, because `build-basemap.mjs` could not name
them: they were called `marker`, and they were the black bicycles and the black
P badges left competing with the discs. They are named now — 15 bicycle-and-P
signs in one, and 8 P badges, 10 permit machines, a motorcycle bay and 2
drop-off symbols in the other — and every one of them is redrawn, so both are
hidden.

Getting there needed two data fixes. The P badge has **no size to match on**:
the sheet draws it at four different sizes and rotates one 90°, so it is matched
by shape instead — a plate that is exactly square, which nothing else in that
layer is. And the size match for bike racks was finding **fourteen of fifteen**;
the last one is drawn about 10% smaller, so hiding its layer would have deleted
it outright. A test now asserts that every hidden marker has a disc within 10 m,
which is the check that would have caught it.

The one thing that does move: my campus paints its two Student Drop-Off symbols on the
kerb, while the disc replacing them sits on the routing node my campus binds that
destination to — 21 m and 30 m away. The test pins that at exactly two symbols
so a third cannot join them unnoticed.

#### What the discs cost

A disc makes every symbol wider, and width is exactly what Mapbox's collision
solver charges for. Adding them dropped **5 of the 21** building names that
placed at the default view; trimming the default 2 px of icon and text padding
bought four back, so the discs now cost one label. That was measured against the
running map, not guessed — which is what the dev-only `window.__map` handle in
`main.js` exists for (it is constant-folded out of the production bundle).

### Category chips

Google's chips are their POI verticals: Restaurants, Hotels, Things to do,
Museums. None of those mean anything inside one college campus, so the strip is
**my campus's own printed legend** instead — the key block on `campus-map.pdf`
(Ver. 3/2026), in `src/categories.js`:

| chip | source | on the sheet |
| --- | --- | --- |
| Restrooms · Bike racks · Emergency phones · Defibrillators · Motorcycle parking · Permit machines | `amenities.json` | drawn symbols, matched by fill and bbox size |
| Bus stops | both | 3 sign plates, plus my campus's two Para Transit stands |
| Health center · Drop-off · Food & drink | both | listed rows, some with no printed symbol |
| Parking · HomeBase | `places.json` | named directory rows, no symbol at all |

Selecting one hides the ambient pictogram layer and draws the category's own
pins, larger and overlap-allowed, with a list beside them sorted by straight-line
distance from wherever you are measuring from. Clicking a row makes it the
destination. Two details that took a second pass:

- The pins have to be **the category's own layer**, not a filter on the ambient
  one. That layer is `minzoom: 16` and the campus only fits the screen at about
  14.5, so a filtered selection was invisible at the zoom people actually use.
- A pin gets its name written on the map **only when the name identifies it**.
  "Myrtle Parking Lot East" does; six pins all reading "All-gender restroom" are
  six copies of what the icon already said. Uniqueness within the category
  decides it, so no category has to declare which sort it is.

The **Legend** button on the rail opens the printed key itself, generated from
the same list, so the chips and the legend cannot drift apart.

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

### 2b. Add a Google key

**Google draws the ground by default**; the **Google / Mapbox** button in the
Layers switcher swaps who does. Google's half needs a second key in the same
`.env`:

```env
VITE_GOOGLE_MAPS_KEY=your_google_browser_key_here
```

Leave it out and nothing breaks: the first tile request fails, the panel shows
Google's own message, and the app falls back to Mapbox and *remembers* — the
refusal writes `mapbox` to `localStorage`, so a reload does not repeat the
failed round trip. Mapbox's token above is therefore still required and Google's
is still, strictly, optional. Two things have to be true in the
[Cloud console](https://console.cloud.google.com/) before tiles will draw:

1. **Map Tiles API enabled** on the project (it is off by default, and needs
   billing). A disabled API and a rejected key are both HTTP 403; only the
   message says which, which is why that message is shown verbatim in the panel.
2. **HTTP-referrer restrictions** covering every origin you serve from. The key
   is a query parameter on the tile URL and therefore public — the referrer
   allowlist is the only thing protecting it. `localhost` is not enough on its
   own: `npm run dev` also binds the LAN address, and a phone hitting
   `http://192.168.x.x:5173` or `https://<host>.local:5173` is a different
   referrer. This is the exact failure mode Mapbox's URL restrictions have.

Only the *ground* changes. Routing, the campus sheet, the labels, the pins and
the 3D buildings are our own layers over either provider, because Google's
[Map Tiles API](https://developers.google.com/maps/documentation/tile) serves
plain XYZ raster that drops into a Mapbox raster source. Loading Google's
JavaScript SDK instead would have meant a second renderer and a second copy of
every one of those layers.

Under Google the style beneath is blank rather than Mapbox Standard, so their
raster is not drawn over a second set of roads and labels; dark mode restyles
the tiles at session-creation time using the same values as `THEMES.dark`, so
there is no seam at the campus mask edge.

### 3. Run

```bash
npm run dev       # dev server with HMR, usually http://localhost:5173
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## Project structure

```
mapper/
├── index.html              # Page shell: rail, search bar, chips, panels
├── server/
│   └── index.js            # Routing API; also serves the overlay GeoJSON
├── src/
│   ├── main.js             # Map setup, click handling, snapping, routing
│   ├── paths.json          # The walkable network (GeoJSON LineStrings)
│   ├── approach-paths.json # The streets around campus — routed over, never drawn
│   ├── campus-clip.js      # Where our map stops and the basemap's takes over
│   ├── buildings.json      # Footprints, extruded during navigation
│   ├── landcover.json      # Lawn, trees, paving, parking, track, pool
│   ├── amenities.json      # Defibrillators, phones, restrooms, bus stops…
│   ├── places.json         # my campus's destination directory, positioned
│   ├── campus-boundary.json# OSM campus polygon, used to mask the basemap
│   ├── categories.js       # The chip strip — my campus's printed legend
│   ├── poi.js              # Which disc each building name earns
│   ├── g-icons.js          # Button and chip glyphs, drawn as SVG
│   ├── map-images.js       # Amenity pictograms and the route pin, drawn as SVG
│   ├── provider.js         # Mapbox/Google toggle — who draws the ground
│   ├── theme.js            # Light / dark / auto, in the rail and the layers menu
│   ├── google-tiles.js     # Map Tiles API sessions, dark styling, attribution
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
| `build-walk-network.mjs` | `paths.json` — 725 nodes, 803 segments; the drawn paths, deduplicated, teed, welded, linked |
| `build-approach-network.mjs` | `approach-paths.json` — 6,342 segments of OSM street in an 800 m apron, joined to my campus's network by 15 gates |
| `build-buildings.mjs` | `buildings.json` — 96 footprints, 58 of them named |
| `build-labels.mjs` | `labels.json` — 49 labels: the PDF's text, plus building names |
| `build-amenities.mjs` | `amenities.json` — 84 amenity points in 12 classes |
| `build-places.mjs` | `places.json` — my campus's 120 destinations, positioned |
| `build-directory.mjs` | `directory.json` — 30 buildings and what is inside them |
| `build-landcover.mjs` | `landcover.json` — 593 ground polygons, superseded |
| `build-boundary.mjs` | `campus-boundary.json` — the OSM campus polygon |
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
footprint carrying three printed labels — *Music*, *Theatre* and the building's
own larger name — each set inside the wing it names. Where the sheet leaves a building bare,
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
- **the campus and the streets around it are one graph.** The same failure, one
  level up, and completely invisible: the approach network is never drawn, so a
  gate connector that misses my campus's vertex by a decimal place looks like nothing
  at all until someone standing off campus asks for directions onto it.
- **nothing of ours is drawn outside the boundary**, and the clip that enforces
  it does not hollow the campus out. Both directions are quiet — clip too little
  and my campus's roads sit on top of the provider's, clip too much and part of the
  campus silently stops rendering, and either reads as a styling choice.
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
