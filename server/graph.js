// The routing graph, and the one question it answers.
//
// Its own module because server/index.js could not be tested without it. That
// file builds the graph at import time and calls app.listen() on the way past,
// so "does the router refuse a start point in Paris" was a question you could
// only ask by standing a server up and talking HTTP to it — which is why nobody
// asked it, and why it did not refuse.
//
// Everything here is a pure function of the FeatureCollections handed in.
// No file reads, no express, no port. index.js reads the files and owns the
// HTTP contract; this owns the geometry.

import pathFinderModule from 'geojson-path-finder';
import { point } from '@turf/helpers';
import { distance } from '@turf/distance';
import { buildManeuvers, FEET_PER_KM } from '../src/maneuvers.js';
import { REACH_M, reachProblem } from '../src/directions.js';
import { ringOf } from '../src/campus-clip.js';

// geojson-path-finder ships CommonJS with no "exports" map, so under bare Node
// the default import is the module namespace rather than the class itself.
// Vite's bundler papers over this; node does not.
const PathFinder = pathFinderModule.default ?? pathFinderModule;

/**
 * How close two coordinates must be before the graph treats them as one vertex.
 *
 * The library's default is 1e-5 degrees, and the closest pair of distinct campus
 * nodes is 2.9e-6 apart — inside the default, not outside it. Six pairs in
 * paths.json are closer than 1e-5, sub-metre joints where the build cuts a path
 * at a building wall, and 72 more among the corners and cuts of the plaza
 * crossings (`plazas` below). At the default each would weld into one vertex
 * and lose the edge between them. Tightening it to 1e-7 (~1cm, matching the precision paths.json
 * is written at) keeps those, and tight junctions like stair landings, apart.
 *
 * PASSED AS `tolerance`, WHICH IS WHAT THE LIBRARY READS. It was passed as
 * `precision`, the option's name in geojson-path-finder 1.x; 2.x renamed it and
 * ignores anything else, so for as long as this file has been on 2.1 the
 * constant was documented, tested against the data, and never used. The graph
 * was built at the 1e-5 default the paragraph above warns about, which rounds
 * every coordinate to a 1e-5 grid and welds whatever lands in one cell: 6,966
 * vertices where the files have 6,977. The eleven lost were each about a
 * metre or less from the one they merged into — one sub-metre joint on the
 * campus, four gate vertices merged with the street vertex beside them, and
 * six pairs inside the street network itself. None of those welds was holding the graph
 * together; it is one component either way. test/router.test.js now asks the
 * built graph, not the constant.
 */
export const VERTEX_PRECISION = 1e-7;

/**
 * How near a vertex a snapped point must be before it is the vertex.
 *
 * WELD_M in scripts/build-walk-network.mjs, and for the same reason: the build
 * splices each destination onto its nearest edge and, where the foot lands this
 * close to an end, reuses the end instead of leaving a stub of a couple of
 * metres beside it. The router splices a request onto its nearest edge the same
 * way, so it reuses the end at the same distance — a destination the build
 * bound to a vertex snaps to that vertex here, not to a point a hand's width
 * along from it. It is also the line between a walk and the same place: two
 * ends nearer than this along the network are one node to the build, and are
 * refused as one here. See route().
 */
export const SNAP_WELD_M = 2.0;

/**
 * How much further than the nearest edge another edge may be and still be
 * offered as a way onto the network: a quarter again of the distance to the
 * nearest, and never more than five metres. See candidates() in createGraph.
 *
 * Small on purpose. The extra metres to a further edge are counted against
 * it, so it only wins when it saves more walking than it costs, but those
 * metres are drawn as a dotted straight line and walked across whatever is
 * there — lawn, a planter, a wall. The cases that need it are rooms well
 * inside a building, 15 to 35 m from two sides that differ by under 2 m, and
 * five metres is narrower than the lawns the network goes round.
 *
 * PROPORTIONAL, so a point on the network or beside it has no alternative.
 * A building's entrance is a node, and a pin dropped on a path or somebody
 * standing on one is on it: a parallel path four metres away is not
 * "about as far" as the one under your feet, and walking off to it would end
 * a route to a front door on the far side of a railing.
 */
export const SNAP_SLACK_M = 5.0;
export const SNAP_SLACK_SHARE = 0.25;

/**
 * How far the campus's own network may be from a point whose nearest edge is
 * a street, and still be offered as a way onto the network beside it. See
 * candidates() in createGraph.
 *
 * The two networks are joined only at gates (scripts/build-approach-network.mjs),
 * and on purpose sparsely: along the perimeter the campus's driveways and
 * OSM's centreline run side by side, and the gate stage refuses a second
 * connector within 250 m of walking of the first. So a point on the kerb
 * between the two is nearest a street centreline that only joins the campus a
 * hundred metres away in either direction. The Admin bus stop is the case that
 * showed it: 4.7 m from the street's centreline and 16.7 m from the campus
 * walk on the other side of it, it snapped to the street once snapping went to
 * edges, and every walk from it onto the campus went up the street to a gate
 * and back down — the parking-badge machine 41 m away became a 224 m walk.
 *
 * Twenty-five metres because that is the strip, not a reach: the campus
 * boundary at that stop is 5.5 m from it, and the walk it should be on another
 * 11 m behind that. Far enough to cross a kerb, a verge and a car park's edge
 * to the path that serves them; well short of the 41 m and 50 m the other two
 * bus stops sit from any campus path, which are across the road and stay on it.
 */
export const STREETSIDE_M = 25.0;

/**
 * How far off the network a point must be before it is on open ground, and
 * every direction from it is a way onto the network; and how much further
 * than the nearest edge such a way may be. See candidates() in createGraph.
 *
 * The slack above is for a point a few metres either side of a tie. It is too
 * narrow for the car parks, whose aisles the clip removes: a permit machine in
 * the north lot is 10 m from the long walk down the lot's east side and 46 m
 * from the corner of the walk at its west end, and those two lead opposite
 * ways. With only the first on offer, the Science Success Center 89 m away was
 * a 272 m walk up the east side and round; across the tarmac to the west
 * corner it is 98 m. Of 129 walks that came out more than a quarter longer
 * than the nearest-vertex router's for this reason, every one began or ended
 * at a car park machine, a bike rack, a motorcycle bay or a random point
 * standing like that, and the way it used to take was still there, beyond
 * the slack. With this rule 8 of them are still longer, by 4 m at the median.
 *
 * So a point at least OPEN_GROUND_M off the network is also offered, in each of
 * eight directions, the nearest way on within OPEN_GROUND_SHARE times the
 * nearest and no more than OPEN_GROUND_MAX_M further than it — 4.5 times and
 * 36 m further were the most those 129 needed. The cap is for the streets
 * beyond the campus, where a point 150 m from the nearest road would otherwise
 * be offered every way within 750 m; those were the slowest routes, and the
 * cap took the slowest from 3.0 to 2.4 ms. Four metres because that is a path
 * and its verge: nearer than that you are standing on the pavement, a parallel
 * path across a railing is not a way you would take, and a building's
 * entrance, a pin dropped on a path or a GPS fix on one keeps the single answer
 * the slack gives it. A way whose straight leg goes through a building is not
 * offered, from open ground or anywhere else; the leg is walked across
 * whatever is there, and a wall is not something to walk across (see
 * WALL_CLIP_M). Off the campus the reach stops at SNAP_SLACK_M beyond the
 * nearest, and on it there is a wider reach as well, at a price; see
 * LEG_CHARGE and OPEN_GROUND_WIDE_CHARGE.
 *
 * NOT ONLY THE NEAREST IN EACH DIRECTION. It used to be the nearest way and
 * no other, so a way added nearer in a direction pushed out the one there
 * before, however much better that one led: more edges made a walk longer,
 * which more edges must never do. So each direction offers every way on no
 * more than SNAP_SLACK_M further than its nearest, up to
 * OPEN_GROUND_PER_SECTOR.
 * Against one per direction, over the 15,323 walks measured at DETOUR_SHARE,
 * 410 come out shorter, by 29 m at most. 11 come out longer by what is walked,
 * by 3.5 m at most, each having traded a long leg for path, which is what the
 * search weighs (see OPEN_GROUND_WIDE_CHARGE).
 */
export const OPEN_GROUND_M = 4.0;
export const OPEN_GROUND_SHARE = 5;
export const OPEN_GROUND_MAX_M = 40;
const OPEN_GROUND_SECTORS = 8;
const OPEN_GROUND_PER_SECTOR = 3;

/** How often the edges are read for a way between buildings: see candidates(). */
const GAP_STEP_M = 2;

/**
 * How far into a building's outline a leg may go and still be beside it
 * rather than through it. See throughBuilding() in createGraph.
 *
 * NO WAY ON THROUGH A BUILDING, AND THE WAY ON AT ITS WALL NO EXCEPTION. Only
 * the ways from open ground used to be asked, and a leg was let through any
 * building either end of it stood in. A door is on its building's wall or
 * just inside it, so every leg to one was let through the whole building: a
 * stall in lot 42 reached CTE by a 74.3 m leg, 35.4 m of it inside CTE, in 62
 * of its walks to the 145 places; a point beside the Gym crossed 39.9 m of
 * the Gym to a way into it, in 114. And the nearest join, and those about as
 * far beside it, were never asked at all. Of the legs walked between the
 * campus's places, amenities and entrances, the entrances' own aside, 41 ran
 * more than this far into a building's footprint, 2,111 times, and 36 of
 * those more than 3 m. Now none does.
 *
 * DEPTH, NOT LENGTH. A leg along a wall that dips under the outline by a
 * metre is walking beside the building, the line drawn a hand's width over
 * the sheet's drawing of the roof; a corner clipped is the same. Receiving's
 * pin stands a metre off the corner of its loading dock, a wing 2.2 m wide,
 * and the walk north from it is up the car park beside the dock. The leg it
 * used to take there ran 13.7 m inside the dock's outline and 2 m in, and is
 * refused; the leg to the corner of the path 4.7 m further west runs inside
 * it for 11 m and never more than 1.5 m in. Measured by length, both were
 * refused, and the 137 walks from Receiving to anywhere north of it went
 * round by the south, 134 m longer on average and 302 m at most: the College
 * Police to Receiving went from 93 m to 395. No leg now goes deeper than this
 * into a footprint; the shallowest of the 36 above went 3.25 m.
 */
export const WALL_CLIP_M = 1.5;

/**
 * What a metre of dotted leg costs the search beyond the nearest join, on
 * top of the metre itself; and what a metre of it costs past a drawn path it
 * steps over. See priced() and candidates() in createGraph.
 *
 * A LEG IS WALKED ACROSS WHATEVER IS THERE, AND COSTED AT ITS STRAIGHT METRES
 * IT BEAT EVERY PATH. A diagonal across a lawn or a car park is always
 * shorter than the path round two sides of it, so the search took it
 * whenever it saved a stride, and over every walk between two places 472 km
 * of the 3,150 km walked was dotted line. A bike rack beside the Child
 * Development Center took a 61.3 m leg over the grass in 56 of its walks to
 * the 145 places; the bus stop for lines 1 and 82 west walked 42 m across the
 * pavement to the street's centreline in 139, with the footway 8.9 m away.
 * So every metre of a leg beyond the nearest join is charged LEG_CHARGE
 * again: a leg 20 m longer than the nearest has to save 6 m of path. Fixed
 * per way on, like the wider reach's charge, so a plaza line or a lot
 * connector, offered beside the drawn edges, can only make a walk cheaper
 * (test/plaza.test.js). `metres`, legFeet and distanceFeet are what is
 * walked; the charge is only weighed, and the same-place test (DETOUR_SHARE)
 * is asked in walked metres too.
 *
 * NOT EVERY NEW EDGE, THOUGH. A drawn edge is measured to, so it changes
 * which vertices are corners a point is offered (candidates()), and with them
 * the paths a leg steps over to reach one. When the junction stage joined a
 * walkway's end cap by the south car park to the footway beside it, 11 of
 * 2,000 random walks on the campus came out 1,136 m shorter in all, and 3
 * cost more, by 11.5 m at most: the walkway's end was no longer a corner, and
 * the leg aimed at it had stepped over another walkway to a better way on.
 * No walk between two places changed.
 *
 *
 * Measured over the 10,440 walks between two places with everything else in
 * this file as it is: at no charge the dotted legs come to 419 km and the
 * walking to 3,163 km; at 0.3, 369 km of leg for 3,174 km walked, a third of
 * a percent more; at 1, 318 km for 3,205 km, and a walk between two
 * restrooms refused as the same place. The longest leg is 98.7 m either way,
 * and the median falls from 17.1 m to 13.3. Off the campus the open-ground
 * reach stops at SNAP_SLACK_M beyond the nearest, because the streets are
 * OSM's and OSM draws the footways that serve a stop. That is a choice, and
 * it costs walking: 505 of 36,191 walks between places, entrances, amenities
 * and random points come out longer for it, 21 km in all and 92 m at most,
 * every one to or from the three bus stops west of the campus. Bus stop to
 * bus stop, lines 1 north to lines 1 and 82 west, is 203 m by the footway
 * against 114 m with 61 m of dotted legs across whatever OSM leaves undrawn.
 *
 * STEPPING OVER A PATH TO ANOTHER COSTS MORE. A leg from open ground that
 * crosses a drawn path on its way to one further off offers the path it
 * crosses as well, where it crosses (see candidates()), and the metres of it
 * past the crossing are charged CROSSING_CHARGE again: nobody crosses a
 * walkway to carry on over the grass to the next. Legs over a drawn path
 * before their join went from 163, walked 7,031 times between places,
 * amenities and entrances, to 29, walked 607 times, for a fifth of a percent
 * more walking. Those left are where the path stepped over leads nowhere
 * near: beside the Stadium car park a walkway and a path run side by side
 * with a verge between and no join for a hundred metres.
 */
export const LEG_CHARGE = 0.3;
export const CROSSING_CHARGE = 1;

/**
 * A wider reach, at a price; and when a walk is a detour on not walking at
 * all. See route().
 *
 * THE WIDER REACH. The open-ground reach above is the most those 129 car park
 * walks needed, and it can still leave a point with only a nearby path that
 * leads the long way round. A point on a lawn 7.2 m from walkway 1313 was
 * offered ways on out to 36 m; the end of walkway 1314, 58 m across the same
 * grass, was beyond that, so a walk to a point 123 m away went down 1313 and
 * back up it: 336 m, where the nearest-vertex router, which snapped to 1314,
 * walked 155. On the campus, from open ground or out of a room whose building
 * has ways in beyond the usual reach, there is a wider reach as well: every
 * way on out to OPEN_GROUND_WIDE_M further than the nearest. Only inside the
 * campus boundary: beyond it are the streets, which the cap was set for.
 *
 * FREE, IT BUYS A FEW METRES OF PATH WITH A LONG LEG ACROSS A LAWN. Offered
 * for every request at no charge, it changed 7,118 of 37,220 walks between
 * places, entrances, amenities and 3,200 random points. The walks with a
 * dotted leg over 60 m went from 2,065 to 5,721, and the total walked fell by
 * 1.3%. So for a while it was asked for only when the first answer was a
 * detour, more than DETOUR_SHARE times the straight line, and the cheaper of
 * the two answers stood. That made a better answer depend on the first being
 * bad enough. A new edge that brought the first answer just under twice the
 * straight line switched the second search off, and the much better walk it
 * used to find was never asked for. Three connectors added through the north
 * lot took Drop-off North to the permit machine there from 213 to 351 m. The
 * drink machine west of the Soccer Stadium walked 197 m where the same router
 * found 81 m.
 *
 * SO IT IS ALWAYS ON OFFER, AT A PRICE: OPEN_GROUND_WIDE_CHARGE. The ways on
 * from both reaches go into the one search, and a way on only the wider reach
 * offers is charged that share again for every metre of its leg beyond the
 * first reach. A leg 20 m past it has to save 10 m of path before it wins.
 * The charge is fixed per way on, so a way on offered beside the drawn edges
 * can only make a walk cheaper and never stops a better one being searched
 * for (test/plaza.test.js holds every walk between two places to that; a
 * drawn edge is another matter, see LEG_CHARGE). `metres` and every distance
 * served are what is walked; the charge is only weighed.
 *
 * Measured over 15,323 walks between places, the campus's amenities and 2,000
 * random points on the campus, against asking only for a detour: 2,589 come
 * out shorter, by 15 m at the median and 204 m at most, and the total walked
 * falls by 1.1%, 57.7 km. The dotted legs over 60 m go from 740 to 1,882. At
 * no charge the saving is 60.6 km and those legs number 2,403; charging the
 * whole leg again saves 50.7 km with 1,424. Half keeps 95% of the saving.
 * Twelve walks come out longer by what is walked, by 6.3 m at most. In every
 * one the old second search took a long leg free that is now charged, and the
 * walk keeps more of itself to the path. Between two places the longest leg is
 * 98.7 m either way.
 *
 * A WALK THAT IS A DETOUR ON NOT WALKING THE PATHS AT ALL IS NOT A WALK.
 * search() passes over a pairing whose way on and way off are one place on
 * the network, and answers with the cheapest walk that is one. Usually that
 * walk is close to the pairing passed over: the Science Success Center and
 * Room 440, 11 m apart, are 33 m by way of the spot where their ways on
 * meet and 34 m by the walk. But where the two ends' cheapest ways meet at one spot and every walk
 * goes round, the walk is an answer to a question nobody asked. Two restrooms
 * in the Student Center 2.7 m apart both leave by the door between them, and
 * the walk went out of one door and round to another, 124 m. From the Student
 * Technology Center, the way across the grass to the STEM Center landed on
 * STEM's entrance itself, 32 m off, and the walk went 60 m round to the same
 * door, until the plaza crossings gave it a walk over the paving: 36 m, legs
 * and all, for 32.5 m as the crow flies.
 * Receiving to the Rec. entrance, 37 m apart, was 410 m by the
 * nearest-vertex router. So when the walk is more than DETOUR_SHARE times
 * what the cheapest pairing passed over walks, the two ends are the same
 * place as far as the paths go, and are refused as one. That is 114 of the
 * 15,437 requests behind the 15,323 walks above, the other 15,323 being
 * those walks: 92 between two places, 81 of them two things inside one
 * building; 20 from an amenity; and 2 from the random points.
 *
 * Twice, because that is where a route stops being a fair answer to the
 * straight line: the median walk between two places is 1.24 times it.
 */
export const DETOUR_SHARE = 2;
export const OPEN_GROUND_WIDE_M = 60;
export const OPEN_GROUND_WIDE_CHARGE = 0.5;

/**
 * How far from a point a way onto the network may be, `nearest` metres being
 * the nearest: see OPEN_GROUND_M, and OPEN_GROUND_WIDE_M for `wide`.
 */
function openGround(nearest, wide) {
  return wide ? nearest + OPEN_GROUND_WIDE_M : Math.min(nearest * OPEN_GROUND_SHARE, nearest + OPEN_GROUND_MAX_M);
}

const METRES_PER_KM = 1000;

/**
 * Metres from p to segment a-b, on a plane tangent at p.
 *
 * The same local equirectangular sum scripts/build-walk-network.mjs does its
 * geometry in, because the door rule below has to give the answer the build
 * gave: the build decides which destinations it leaves unspliced on that
 * comparison, and a router that measured it differently could disagree about
 * a near tie. The snap onto an edge does the same sum, inlined in
 * candidates(), for the same reason — it is the build's SPLICE, asked again
 * at request time.
 */
const EARTH_M = 6371008.8;
function metresToSegment(p, a, b) {
  const my = (EARTH_M * Math.PI) / 180;
  const mx = my * Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * mx, ay = (a[1] - p[1]) * my;
  const vx = (b[0] - a[0]) * mx, vy = (b[1] - a[1]) * my;
  const L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L));
  return Math.hypot(ax + t * vx, ay + t * vy);
}

/** Seven decimals, ~1 cm: what every coordinate in paths.json is written at. */
const round7 = (x) => Number(x.toFixed(7));
const coordKey = (c) => `${c[0]},${c[1]}`;

/** Even-odd test against one ring of [lon, lat]. */
function inRing(p, ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a, a += 1) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > p[1]) !== (yb > p[1]) && p[0] < ((xb - xa) * (p[1] - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/**
 * Where the line from p to q crosses a ring's outline, as shares of the way
 * along it, in order and with both ends: the pieces between are each wholly
 * inside or wholly outside, and asking whether a piece's middle is inside
 * is a question a line through a vertex of the outline, or along one of its
 * sides, cannot fool.
 */
function cutsAlong(p, q, ring) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const cuts = [0, 1];
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a, a += 1) {
    const ex = ring[a][0] - ring[b][0], ey = ring[a][1] - ring[b][1];
    const den = dx * ey - dy * ex;
    if (den === 0) continue;
    const wx = ring[b][0] - p[0], wy = ring[b][1] - p[1];
    const t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  return cuts.sort((x, y) => x - y);
}

/**
 * Whether the line from p to q goes more than `limit` inside a ring, in the
 * ring's own units: whether some point of it inside the ring is further than
 * that from the outline. With `leaving`, not the stretch from p to where the
 * line first leaves the ring. Read every quarter-metre where the units are
 * metres, and only where it could be so: a stretch that runs from the outline
 * to the outline is nowhere further from it than half its length.
 */
function deeper(p, q, ring, limit, leaving = false) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const length = Math.hypot(dx, dy);
  const cuts = cutsAlong(p, q, ring);
  const fromOutline = (x, y) => {
    let d = Infinity;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a, a += 1) {
      const vx = ring[a][0] - ring[b][0], vy = ring[a][1] - ring[b][1];
      const L = vx * vx + vy * vy;
      const t = L ? Math.max(0, Math.min(1, ((x - ring[b][0]) * vx + (y - ring[b][1]) * vy) / L)) : 0;
      d = Math.min(d, Math.hypot(x - ring[b][0] - t * vx, y - ring[b][1] - t * vy));
    }
    return d;
  };
  for (let k = 1; k < cuts.length; k += 1) {
    const [t0, t1] = [cuts[k - 1], cuts[k]];
    if (t1 <= t0) continue;
    if (!inRing([p[0] + (dx * (t0 + t1)) / 2, p[1] + (dy * (t0 + t1)) / 2], ring)) {
      leaving = false;
      continue;
    }
    const stretch = (t1 - t0) * length;
    if (leaving || (k > 1 && k < cuts.length - 1 ? stretch / 2 : stretch) <= limit) continue;
    const steps = Math.ceil(stretch / 0.25);
    for (let j = 1; j < steps; j += 1) {
      const t = t0 + ((t1 - t0) * j) / steps;
      if (fromOutline(p[0] + dx * t, p[1] + dy * t) > limit) return true;
    }
  }
  return false;
}

/** Every distinct coordinate in a FeatureCollection of LineStrings, in order. */
function uniqueVertices(features) {
  const seen = new Set();
  const vertices = [];
  for (const feature of features) {
    for (const coord of feature.geometry.coordinates) {
      const key = `${coord[0]},${coord[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        vertices.push(coord);
      }
    }
  }
  return vertices;
}

/**
 * Build the router.
 *
 * `network` is my campus's own printed linework and `approach` is the streets
 * around it. Concatenating the two collections IS the merge — geojson-path-finder
 * builds its topology from coordinates rather than from feature identity, and the
 * gate connectors end on my campus's vertices at the same seven decimals those
 * vertices are written at, so they weld there.
 *
 * `doors` is src/doors.json, also from scripts/build-walk-network.mjs: what its
 * walls stage took off the graph under each building's roof, and the node each
 * piece left the graph at. Optional, so a graph can be built from a fixture
 * with no buildings in it; without it every coordinate snaps to the nearest
 * point on the network, which is what the router did before the walls stage
 * existed.
 *
 * `boundary` is src/campus-boundary.json, the line build-approach-network.mjs
 * clips the streets at. Optional too; it only decides whether a point is on
 * the campus, for the rules in candidates() that ask.
 *
 * `entrances` is one entry per building in src/directory.json: `{ doors,
 * footprint }`, its `doors` and its geometry. The doors come entrance first —
 * its drawn doors, then where its walls come nearest the network. A walk asked to
 * start or end at any one of a building's doors may use whichever of them
 * suits it, because what was asked for is the building — the card's
 * Directions sends its entrance, and the entrance is one door of several. The
 * answer says which door it used (`door` in route()), so the pin can move
 * there. They are also a room's other ways out of its building (see
 * doorFor()). The footprint is what makes anywhere inside the building the
 * same place as the building (see sameBuilding()). A bare door list is taken
 * as an entry with no footprint. Optional; without it a door is a vertex like
 * any other, and a room leaves only by the doors of its own footprint.
 *
 * `plazas` is src/plaza-paths.json, the ways across the sheet's paved plazas
 * from the last stage of scripts/build-walk-network.mjs: routed, never drawn,
 * and the campus's own network once a walk is on them. BUT NEVER WHAT A POINT
 * IS MEASURED TO. Every distance candidates() takes is to the drawn edges
 * alone: the nearest edge, the slack, whether a point is on open ground, the
 * directions it can leave in, and whether a room is nearer a peeled stub than
 * the network. After that, the foot of each plaza line within the drawn slack
 * is offered as well, with the ends of its line, unless a leg goes through
 * a building. When the lines were measured like any other edge, a crossing
 * beside a place shrank the reach every other way on is offered within. The
 * Math Learning Center went from
 * 9.9 m off the network to 3.4 m, under OPEN_GROUND_M, so five ways on became
 * one, and its walk to Para Transit went from 333 to 377 m. Of every walk
 * between two places, 539 came out longer for the plazas. Offered beside the
 * drawn edges, they lengthen none (test/plaza.test.js). Where a plaza line
 * meets the network it ends on a vertex of `network` at the same seven
 * decimals, so it welds the way the gates do. Its corners, and the points
 * where two lines cross, are vertices only plaza lines touch, 268 of them,
 * and a point that is one of those joins there first, as well as by every
 * way it would have without them. Optional; without it a walk
 * goes round a plaza by its drawn edges.
 *
 * The LOT CONNECTORS in `approach` (source 'lot') are held to the same rule.
 * They are the straight lines build-approach-network.mjs draws across a car
 * park from an entrance the clip cut to the campus path beyond, and a lot's
 * pin stands on the aisle they follow: Myrtle Parking Lot West is 0.2 m off
 * one. Measured like a street, that made the pin a point on a path, it lost
 * its ways on across the tarmac, and its walk to the Administration Building
 * went from 307 m to 371 m. Offered beside, a lot connector only adds a way.
 *
 * `buildings` is src/buildings.json, every footprint on the sheet. Optional;
 * it keeps every way onto the network from being drawn through a building
 * (throughBuilding(), WALL_CLIP_M). Without it none is refused for that.
 */
export function createGraph({
  network, approach, plazas = null, doors = null, boundary = null, entrances = null, buildings = null,
}) {
  const campusFeatures = [...network.features, ...(plazas?.features ?? [])];
  const features = [...campusFeatures, ...approach.features];
  const pathFinder = new PathFinder(
    { type: 'FeatureCollection', features },
    { tolerance: VERTEX_PRECISION },
  );
  // The library's own graph, which is a public field of it: every vertex by
  // key, with the weight in km to each neighbour, and the coordinate each key
  // was made from. route() searches it directly — see search() for why — so
  // the only thing taken from geojson-path-finder is the topology, which is the
  // part of it that is O(E) and worth doing once.
  const { vertices: adjacency, sourceCoordinates } = pathFinder.graph;
  // The library's key for a coordinate: rounded to the tolerance, then joined.
  const keyOf = (c) => `${Math.round(c[0] / VERTEX_PRECISION) * VERTEX_PRECISION},`
    + `${Math.round(c[1] / VERTEX_PRECISION) * VERTEX_PRECISION}`;

  // Every unique vertex. Served to the browser as /api/vertices, which checks a
  // start's reach against the nearest of them before any request is made.
  const vertices = uniqueVertices(features);

  // Every edge as the straight piece it is, with the weight the library gave
  // it — its haversine length in km — so the part of an edge between a snapped
  // point and either end costs the same share of that weight the search will
  // charge for the whole of it. A zero-length piece is skipped: the library
  // leaves it out of the graph, and an end that only it touches is no vertex.
  const segments = [];
  for (const [index, feature] of features.entries()) {
    // The campus's own edges, as against the streets and the gates onto them.
    // candidates() asks which network a point's nearest edge belongs to.
    const campus = index < campusFeatures.length;
    // A way across a plaza (see `plazas` above), as against an edge the sheet
    // draws — or across a car park (the lot connectors, likewise).
    const plaza = (campus && index >= network.features.length)
      || (!campus && feature.properties?.source === 'lot');
    const cs = feature.geometry.coordinates;
    for (let k = 1; k < cs.length; k += 1) {
      const a = cs[k - 1], b = cs[k];
      const ka = keyOf(a), kb = keyOf(b);
      if (ka === kb) continue;
      const km = adjacency[ka]?.[kb];
      if (km === undefined) {
        // Not a state the data can reach by being wrong — only by the library
        // keying vertices some other way than keyOf() assumes, which would be
        // an upgrade to say something about rather than a route to get wrong.
        throw new Error(`geojson-path-finder has no edge ${ka} -> ${kb}; has its vertex key changed?`);
      }
      // One id for the edge whichever way it was drawn, so two snaps onto the
      // same edge recognise each other; `along` is measured from the end named first.
      const flip = ka > kb;
      segments.push({ a, b, ka, kb, km, id: flip ? `${kb}|${ka}` : `${ka}|${kb}`, flip, campus, plaza });
    }
  }
  // The drawn edges and the plaza lines apart: every distance candidates()
  // measures is to the drawn network, and the plaza lines (and lot
  // connectors) are only offered beside it. See `plazas` above.
  const drawn = segments.filter((seg) => !seg.plaza);
  const plazaSegments = segments.filter((seg) => seg.plaza);
  // The drawn edges at each vertex, for asking whether a vertex is the nearest
  // point of its own neighbourhood. See candidates().
  const incident = new Map();
  for (const seg of drawn) {
    for (const k of [seg.ka, seg.kb]) {
      if (!incident.has(k)) incident.set(k, []);
      incident.get(k).push(seg);
    }
  }

  // What meets at each vertex that a walker can see to take: the far end of
  // every drawn edge and street there, without the plaza lines and the lot
  // connectors, which are routed and never drawn. buildManeuvers() asks it
  // which bends are junctions and which branches rival the one taken; see
  // route().
  const around = new Map();
  for (const [key, list] of incident) {
    const far = new Map();
    for (const seg of list) {
      const [k, c] = seg.ka === key ? [seg.kb, seg.b] : [seg.ka, seg.a];
      if (k !== key) far.set(k, c);
    }
    around.set(key, [...far.values()]);
  }
  const branchesAt = (c) => around.get(keyOf(c)) ?? [];
  const degreeAt = (c) => branchesAt(c).length;

  // Every building's doors, filed under each of them, so a coordinate that is
  // one of them finds the rest — and the building's footprint with them. Only
  // doors that are vertices of the graph: a door is a node the walls stage
  // left on the network, and one that is not would be a way on that leads
  // nowhere.
  const buildingAt = new Map();
  for (const entry of entrances ?? []) {
    const { doors: list, footprint = null } = Array.isArray(entry) ? { doors: entry } : entry;
    const onGraph = list.filter((d) => adjacency[keyOf(d)]);
    const polygons = !footprint ? []
      : footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
    const record = { doors: onGraph, polygons };
    for (const d of onGraph) buildingAt.set(keyOf(d), record);
  }

  /**
   * Where a coordinate is on the network, and the places it could join it at:
   * `{ nearest, list, wider? }`.
   *
   * ON AN EDGE, NOT AT A VERTEX. The router used to take the nearest vertex,
   * and that is only the nearest point on the network where the drawing
   * happens to put vertices close together. It stopped doing so: the build now
   * collapses a stroke traced as a run of near-collinear points into the one
   * straight edge it is, so the walkway along the south face of STEM is a
   * single 107 m segment with nothing in its middle. A point beside that middle
   * snapped to whichever end was nearer, fifty metres off, and the walk began
   * by going there and coming back. Of 170 walks that came out more than a
   * quarter longer after that round of fixes, 155 were snapping and nothing
   * else: routed between their old snap targets, the new graph gave the old
   * lengths.
   *
   * So a coordinate joins an edge where the build's SPLICE stage would have
   * spliced it: at the foot of the perpendicular, or at the edge's end when the
   * foot is within SNAP_WELD_M of it. A foot is not a vertex of the graph, so
   * it carries `via` — each end of its edge and the part of the edge's weight
   * it takes to walk there — and the search starts from both.
   *
   * NOT ONLY THE NEAREST EDGE. A destination inside a building is often about
   * as far from two faces of it: TRIO is 31.9 m from a path to the west and
   * 33.6 m from one to the south, the STEM place 30.6 m from one to the east
   * and 32 m from one to the south. Which is nearest is then a matter of a
   * metre or two, and the walk it picks can be fifty metres longer than the
   * other — you would leave by whichever side faces where you are going. So
   * every edge about as far as the nearest (SNAP_SLACK_M) offers its foot too,
   * and route() lets the walk choose, counting the extra metres to the further
   * one against it.
   *
   * AND THE CAMPUS, FROM THE KERB. A point whose nearest edge is a street, and
   * which stands between that street and the campus's own network, is also
   * offered the nearest campus edge within STREETSIDE_M — further than the
   * slack would allow, because the street it is nearest only joins the campus
   * at the next gate, and the gates are hundreds of metres apart by design.
   * The walk still chooses: going on along the street wins where that is
   * where you are going.
   *
   * AND THE ENDS OF THE EDGE. Each end of an edge joined within the slack is
   * offered too, so a walk can stop at the corner it reaches rather than run
   * on past it to the foot and step off back the way it came.
   *
   * AND FROM OPEN GROUND, EVERY WAY. A point at least OPEN_GROUND_M off the
   * network — the middle of a car park, a lawn — is also offered the nearest
   * way on in each of eight directions, and those about as far beside it, out
   * to OPEN_GROUND_SHARE times the nearest; and where a leg steps over a drawn
   * path on the way, that path where it crosses. See OPEN_GROUND_M,
   * CROSSING_CHARGE, and `wider()` below.
   *
   * NONE OF THEM THROUGH A BUILDING (throughBuilding()), the nearest no more
   * than the rest. `nearest` is still the nearest point on the drawn network,
   * through a wall or not, because it is where the coordinate is: it is what
   * `snap()` reports and what the reach check and the same-place test are
   * asked about. `list` is the ways the walk may leave by. Where every way
   * within the slack and the open-ground reach is behind a building, it is
   * the ways round it; where there is none of those either, the nearest
   * stands, so that no walk is lost.
   *
   * AND THE PLAZAS, BESIDE ALL OF THAT. Every distance above is to the drawn
   * edges; a plaza line within the drawn slack is offered after them, and never
   * changes what they are. See `plazas` above.
   *
   * Inside a building that has doors, the answer may instead be its doors;
   * see doorFor(). The doors are the only entries then — they stand for the
   * approach paths the building used to have, which are the ways in that were
   * drawn — and the nearest comes first.
   *
   * A building's door, asked for as itself, is every door of that building;
   * see `entrances` above. The one asked for comes first, at no distance, and
   * the rest follow at no distance either: they are the same destination.
   *
   * Every way in `list` beyond the nearest carries the `cost` the search
   * weighs it at, its metres and the charges on them (LEG_CHARGE). Where
   * there is a wider reach — on the campus, from open ground or out of a room
   * with ways in beyond the usual one — there is `wider()` as well, which
   * answers the same with every way on within OPEN_GROUND_WIDE_M of the
   * nearest, each beyond the first reach charged for that too. See
   * OPEN_GROUND_WIDE_CHARGE. Gathered in the same scan, so asking for it
   * costs no second pass over the network.
   */
  function candidates(coord) {
    const building = buildingAt.get(keyOf(coord));
    if (building) {
      const asked = building.doors.find((d) => keyOf(d) === keyOf(coord));
      const list = [asked, ...building.doors.filter((d) => d !== asked)]
        .map((d) => ({ ...joinAt(d, null, d), building: building.doors, footprint: building.polygons }));
      return { nearest: list[0], list };
    }

    // metresToSegment()'s sum, inlined: the tangent plane is the same for
    // every edge, this is a scan of all of them on every request, and it
    // needs `t` and the edge's length as well as the distance.
    const my = (EARTH_M * Math.PI) / 180;
    const mx = my * Math.cos((coord[1] * Math.PI) / 180);
    const read = (seg) => {
      const ax = (seg.a[0] - coord[0]) * mx, ay = (seg.a[1] - coord[1]) * my;
      const vx = (seg.b[0] - seg.a[0]) * mx, vy = (seg.b[1] - seg.a[1]) * my;
      const L = vx * vx + vy * vy;
      const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L));
      const fx = ax + t * vx, fy = ay + t * vy;
      return { t, d2: fx * fx + fy * fy, len: Math.sqrt(L), fx, fy };
    };

    let best = null;
    let campusBest = null;
    for (const seg of drawn) {
      const r = read(seg);
      const { t, d2, len } = r;
      if (seg.campus && (!campusBest || d2 < campusBest.d2)) campusBest = { seg, ...r };
      if (best && d2 > best.d2 + 1e-9) continue;
      // A vertex lies on every edge it ends, at the same distance; prefer the
      // reading that lands on it, so a vertex always snaps to itself.
      if (best && !(d2 < best.d2 - 1e-9 || (atEnd(t, len) && !atEnd(best.t, best.len)))) continue;
      best = { seg, ...r };
    }
    // ...and where the coordinate IS a vertex, that vertex outright. The rule
    // above cannot tell it from the end of another edge it lies on within a
    // weld: the street vertex where OSM's road crosses the campus walk at the
    // west gate is 0.7 m from the walk's end, on the walk, and snapped to that
    // end instead of to itself.
    const self = incident.get(keyOf(coord));
    if (self) best = { seg: self[0], ...read(self[0]) };
    // A corner only plaza lines meet is a vertex of the graph too, and is
    // itself: it is where the point is, and its first way on, at no distance.
    // One more way on, and not the only one. It used to be the whole answer,
    // and a vertex in the middle of a plaza lost every way across the paving
    // and round it that the same point a hand's width off was offered: of
    // 13,132 walks from the 268 such vertices, 1,358 cost more with the
    // plazas than without them, by 57.7 m at most. So everything below is
    // asked of it as of any point, measured to the drawn edges, and the
    // vertex goes in front (see withVertex()). 30 still do, every one from a
    // vertex that is also a building's door, which is asked for as the
    // building (above) and is no vertex at all without the plazas.
    const itself = !self && plazaSegments.some((seg) => seg.ka === keyOf(coord) || seg.kb === keyOf(coord))
      ? joinAt(coord, keyOf(coord), coord) : null;
    const withVertex = (answer) => {
      if (!itself) return answer;
      const more = answer.wider;
      const and = (list) => [itself, ...list.filter((option) => keyOf(option.coord) !== keyOf(coord))];
      return { nearest: itself, list: and(answer.list), ...(more ? { wider: () => and(more()) } : {}) };
    };
    if (!best) {
      const nowhere = { coord, metres: Infinity, via: [], edge: null, along: 0 };
      return withVertex({ nearest: nowhere, list: itself ? [] : [nowhere] });
    }

    const nearest = Math.sqrt(best.d2);
    const onCampus = Boolean(campusRing && inRing(coord, campusRing));
    const room = doorFor(coord, nearest, false);
    if (room) {
      const leave = ({ doors: list }) => list.map((door) => ({ ...joinAt(coord, null, door), room: list }));
      const out = leave(room);
      // Charged beyond the nearest way out, as any leg is: see LEG_CHARGE.
      const shortest = Math.min(...out.map((option) => option.metres));
      const answer = { nearest: out[0], list: priced(out, shortest) };
      if (onCampus && room.bounded) {
        const first = new Set(room.doors.map(keyOf));
        answer.wider = () => priced(leave(doorFor(coord, nearest, true))
          .map((option) => (first.has(keyOf(option.coord)) ? option : charged(option, room.reach))), shortest);
      }
      return withVertex(answer);
    }

    // Every edge within the slack offers the nearest point of it — but only
    // where that is the nearest point of its neighbourhood too: the foot of a
    // perpendicular, or a corner every edge at it leads away from. A path
    // curving past at 32 to 36 m is one way onto the network, not twenty, and
    // the rest of its vertices are reached along it.
    const found = [entry(coord, best)];
    const seen = new Set([coordKey(found[0].coord)]);
    const slack = nearest + Math.min(SNAP_SLACK_M, nearest * SNAP_SLACK_SHARE);
    const reach = slack ** 2;
    const corner = (key) => incident.get(key).every((seg) => {
      const { t } = read(seg);
      return seg.ka === key ? t === 0 : t === 1;
    });
    // The ways on from open ground are gathered in the same scan (see below),
    // out to the wider reach where there is one. Off the campus the first
    // reach stops at the slack beyond the nearest: see LEG_CHARGE. And every
    // way on out to that reach is gathered whatever the ground, for a point
    // whose nearer ways all cross a building (see `clear` below).
    const open = nearest >= OPEN_GROUND_M;
    const wide = open && onCampus;
    const first = onCampus ? openGround(nearest, false) : Math.min(openGround(nearest, false), nearest + SNAP_SLACK_M);
    const far = wide ? openGround(nearest, true) : first;
    const gather = openGround(nearest, onCampus) ** 2;
    const ways = [], around = [];
    for (const seg of drawn) {
      const r = read(seg);
      if (r.d2 > reach && r.d2 > gather) continue;
      around.push({ seg, ...r });
      if ((r.t === 0 && !corner(seg.ka)) || (r.t === 1 && !corner(seg.kb))) continue;
      if (r.d2 > reach) {
        ways.push({ seg, ...r });
        continue;
      }
      const option = entry(coord, { seg, ...r });
      if (seen.has(coordKey(option.coord))) continue;
      seen.add(coordKey(option.coord));
      found.push(option);
    }

    // The campus side of a street: see STREETSIDE_M. Offered only where the
    // street and the campus edge lie in opposite directions from the point —
    // it stands between them — so somebody across the road from the campus,
    // with the street between them and it, is still taken along the street
    // to a gate rather than straight over the traffic.
    //
    // Inside the campus boundary it is offered however far it is. The street
    // is then on the far side of the line the streets were clipped at, and
    // the ground in between is the campus's own — the north car parks, whose
    // permit machines are 33 to 41 m from the road outside and 47 to 56 m
    // from the walk through the lot, and whose aisles OSM draws and the clip
    // removes. Joining the road from there means leaving the campus through
    // whatever hedge or fence it keeps there and coming back in at a gate;
    // walking through the car park to the campus path is the walk people make.
    if (!best.seg.campus && campusBest && (onCampus || (campusBest.d2 <= STREETSIDE_M ** 2
      && best.fx * campusBest.fx + best.fy * campusBest.fy < 0))) {
      const option = entry(coord, campusBest);
      if (!seen.has(coordKey(option.coord))) {
        seen.add(coordKey(option.coord));
        found.push(option);
      }
    }

    // THE ENDS OF EACH EDGE JOINED, within the slack. A walk that comes along
    // a path to the vertex at the end of the edge the point is beside, and
    // goes on past it to the foot of the perpendicular only to step off there
    // back the way it came, is a hook drawn at the end of the line: the walk
    // from Room 560 to CalWORKs turned back through 127 degrees in its last
    // 9 m, and 40 walks between two places hooked at that corner. The vertex
    // was never offered, so the walk could not stop at it. Offered here, where
    // its own leg is clear of every building — the ends of a foot that is not
    // clear too, because the corner of a path round a wall is the way past it:
    // Receiving's way north is the end of the edge whose foot is behind its
    // loading dock. Hooks at either end of a walk between two places went from
    // 99 to 61, and from 324 to 252 without the plaza lines.
    const ends = (feet, there, into = feet) => {
      for (const option of [...feet]) {
        if (!option.seg) continue;
        for (const [key, vertex] of [[option.seg.ka, option.seg.a], [option.seg.kb, option.seg.b]]) {
          if (there.has(coordKey(vertex))) continue;
          const end = joinAt(coord, key, vertex);
          if (end.metres > slack || throughBuilding(coord, vertex)) continue;
          there.add(coordKey(vertex));
          into.push(end);
        }
      }
      return into;
    };

    // NONE OF THEM THROUGH A BUILDING. A way on whose straight leg goes
    // through a building is not offered, the nearest no more than any other:
    // see throughBuilding(). It used to be only the ways from open ground that
    // were asked, and the nearest join and those about as far beside it were
    // taken as found. A bike rack on the lawn among the portables of Portable
    // Village joined the walk on the far side of one, 26.6 m with 14.7 m of it
    // through the portable, in 261 walks; Receiving's leg ran 13.7 m inside
    // its own loading dock. The nearest is still what snap() reports, and what
    // the reach and the same-place tests ask about: it is where the point is.
    // It is only no longer a way to leave it.
    const clear = ends(found, seen, found.filter((option) => !throughBuilding(coord, option.coord)));

    // The plaza lines, last and only beside what is above: the foot of each
    // within the slack of the nearest DRAWN edge, and the ends of its edge
    // within the slack, unless a leg would cross a building. Never the
    // open-ground reach — a plaza line is not a way on from across a lawn that
    // the drawn network would not have offered — and never a reason to offer
    // fewer, because nothing above was measured to them. See `plazas` above.
    const plazaFeet = (list) => {
      const there = new Set(list.map((o) => coordKey(o.coord)));
      const feet = [];
      for (const seg of plazaSegments) {
        const r = read(seg);
        if (r.d2 > reach) continue;
        const option = entry(coord, { seg, ...r });
        if (there.has(coordKey(option.coord)) || throughBuilding(coord, option.coord)) continue;
        there.add(coordKey(option.coord));
        feet.push(option);
      }
      return [...list, ...ends(feet, there)];
    };

    // A WAY ACROSS A PATH IS ALSO A WAY ONTO THAT PATH. A leg from open
    // ground that steps over a drawn path on its way to one further off
    // offers the path it steps over too, where it crosses. The emergency
    // telephone south of the Gym was offered the walkway 47.7 m off across
    // 29 m of lawn, over another walkway 21.6 m out, and the walkway it
    // stepped over was not a way on at all: the foot of the perpendicular to
    // it was further round. Beside, not instead: where two paths run side by
    // side with a verge between and no join for a hundred metres, as the
    // walkways west of the Stadium do, stepping over one to the other is the
    // walk, and taking it away made a walk to the Stadium car park 104 m
    // longer. Which of the two wins is the leg's charge (LEG_CHARGE).
    const offerWay = (out, there, option, firstReach) => {
      const over = crossing(coord, option.coord);
      const way = charged(option, firstReach);
      const past = over ? (1 - over.s) * option.metres : 0;
      out.push(past ? { ...way, cost: (way.cost ?? way.metres) + CROSSING_CHARGE * past } : way);
      there.add(coordKey(option.coord));
      if (!over) return;
      // Where the crossing is within the weld of an end of the path it
      // crosses, it is that end, and off the line of the leg.
      const onto = entry(coord, { seg: over.seg, t: over.t, len: read(over.seg).len });
      if (there.has(coordKey(onto.coord)) || throughBuilding(coord, onto.coord)) return;
      there.add(coordKey(onto.coord));
      out.push(charged(onto, firstReach));
    };

    // Open ground: see OPEN_GROUND_M. Nearest first in each direction, and
    // the first whose leg stays out of every building opens the direction — a
    // nearer way behind a wall does not hide a further one round it. Then
    // every other way in that direction about as far as that one (the slack
    // again, SNAP_SLACK_M), up to OPEN_GROUND_PER_SECTOR: a nearer way does
    // not hide one beside it that leads somewhere better either. See
    // OPEN_GROUND_SECTORS.
    ways.sort((p, q) => p.d2 - q.d2);
    const onto = (base, within, firstReach) => {
      const out = [...base];
      const opened = new Map(), there = new Set(seen);
      for (const way of ways) {
        if (way.d2 > within) break;
        const sector = Math.floor(((Math.atan2(way.fx, way.fy) / Math.PI + 1) * OPEN_GROUND_SECTORS) / 2)
          % OPEN_GROUND_SECTORS;
        const taken = opened.get(sector);
        if (taken && (taken.count >= OPEN_GROUND_PER_SECTOR || Math.sqrt(way.d2) > taken.leg + SNAP_SLACK_M)) continue;
        const option = entry(coord, way);
        if (there.has(coordKey(option.coord)) || throughBuilding(coord, option.coord)) continue;
        opened.set(sector, { leg: taken?.leg ?? Math.sqrt(way.d2), count: (taken?.count ?? 0) + 1 });
        offerWay(out, there, option, firstReach);
      }
      return out;
    };

    // Between buildings, the gaps. Every edge within `within` read every
    // GAP_STEP_M along, and in each direction the nearest of those points
    // whose leg is clear of every building: the way out of a courtyard is
    // seldom where a perpendicular lands. The bike rack among the portables
    // has paths all round it and a portable in front of every foot and corner
    // within 87 m; between two of them it is 34.6 m to the walkway west.
    const gaps = (within, firstReach) => {
      const points = [];
      for (const { seg, len } of around) {
        const steps = Math.max(1, Math.ceil(len / GAP_STEP_M));
        for (let k = 0; k <= steps; k += 1) {
          const t = k / steps;
          const fx = (seg.a[0] + t * (seg.b[0] - seg.a[0]) - coord[0]) * mx;
          const fy = (seg.a[1] + t * (seg.b[1] - seg.a[1]) - coord[1]) * my;
          const d2 = fx * fx + fy * fy;
          if (d2 <= within) points.push({ seg, t, len, fx, fy, d2 });
        }
      }
      points.sort((p, q) => p.d2 - q.d2);
      const out = [], opened = new Set(), there = new Set();
      for (const way of points) {
        if (opened.size === OPEN_GROUND_SECTORS) break;
        const sector = Math.floor(((Math.atan2(way.fx, way.fy) / Math.PI + 1) * OPEN_GROUND_SECTORS) / 2)
          % OPEN_GROUND_SECTORS;
        if (opened.has(sector)) continue;
        const option = entry(coord, way);
        if (there.has(coordKey(option.coord)) || throughBuilding(coord, option.coord)) continue;
        opened.add(sector);
        offerWay(out, there, option, firstReach);
      }
      return out;
    };

    // Where every way on above crosses a building, the point is behind one:
    // it is offered the ways round it, the nearest clear way in each
    // direction out to the reach open ground would have, whatever the ground
    // it stands on — first the feet and corners, then the gaps. Where there
    // is none of those either, the nearest join stands, through the wall or
    // not, so that no walk is lost to this.
    const offer = (wider) => {
      let out = open ? onto(clear, (wider ? far : first) ** 2, first) : [...clear];
      if (!out.length) out = onto([], gather, first);
      if (!out.length) out = gaps(gather, first);
      if (!out.length) out = [found[0]];
      return priced(plazaFeet(out), nearest);
    };
    const answer = { nearest: found[0], list: offer(false) };
    if (wide) answer.wider = () => offer(true);
    return withVertex(answer);
  }

  // Each footprint's outline and its box, for throughBuilding().
  const footprints = (buildings?.features ?? []).map((f) => {
    const ring = f.geometry.coordinates[0];
    const xs = ring.map((c) => c[0]), ys = ring.map((c) => c[1]);
    return { ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  // Which of them are each directory building's own, for a room leaving by
  // its building's ways in (doorFor()): the directory draws a building with
  // the sheet's own rings, so they are matched exactly.
  const footprintOf = new Map(footprints.map(({ ring }, index) => [JSON.stringify(ring), index]));
  for (const record of new Set(buildingAt.values())) {
    record.own = new Set(record.polygons.map(([outline]) => footprintOf.get(JSON.stringify(outline)))
      .filter((index) => index !== undefined));
  }

  /**
   * Whether the straight line from p to q goes through a building: more than
   * WALL_CLIP_M into a footprint anywhere, other than on the stretch of the
   * one p stands in that it leaves by, and other than its last SNAP_WELD_M.
   *
   * THE BUILDING A LEG ENDS AT IS NOT LET OFF. This used to pass over any
   * footprint either end was inside, and the end a leg runs to is a door or
   * where a building's walls come nearest the network: a node on its wall or
   * just inside it, so inside its footprint as often as not. Every leg to one
   * was let through that whole building. Para Transit left by a 43.7 m leg to
   * the Arts and Science door, 21 m of it through Arts and Science, in 91
   * walks; a drink machine reached the Administration Building's door by
   * 37.5 m of its 38.5 m leg inside it; a stall in lot 42 walked 35.4 m of
   * its 74.3 m leg through CTE. So the leg's last SNAP_WELD_M is what stands
   * for the door's own wall — a node closer than that to where the leg ends
   * is the same place to the build — and the rest of the leg is held to every
   * footprint.
   *
   * AND THE ONE IT STARTS IN ONLY ON THE WAY OUT. A point inside a building
   * has to leave it, so the stretch from it to the wall is no wall walked
   * through. Out and back in again round a courtyard is.
   *
   * AND NONE OF `own`, the footprints (by index) of the building a room is
   * leaving by one of its ways in: from one of a building's footprints to a
   * door on another that abuts it is the inside of the building, not a wall.
   * See doorFor().
   *
   * HOW FAR IN, NOT HOW LONG. A corner clipped, or a wall walked beside a
   * hand's width under the sheet's drawing of the roof, is the same leg; see
   * WALL_CLIP_M.
   */
  function throughBuilding(p, q, own = null) {
    const my = (EARTH_M * Math.PI) / 180;
    const mx = my * Math.cos((p[1] * Math.PI) / 180);
    const flat = (c) => [(c[0] - p[0]) * mx, (c[1] - p[1]) * my];
    const [qx, qy] = flat(q);
    const whole = Math.hypot(qx, qy);
    if (whole <= SNAP_WELD_M) return false;
    const share = (whole - SNAP_WELD_M) / whole;
    const end = [p[0] + (q[0] - p[0]) * share, p[1] + (q[1] - p[1]) * share];
    const lo = [Math.min(p[0], end[0]), Math.min(p[1], end[1])];
    const hi = [Math.max(p[0], end[0]), Math.max(p[1], end[1])];
    for (const [index, { ring, box }] of footprints.entries()) {
      if (own?.has(index)) continue;
      if (box[0] > hi[0] || box[2] < lo[0] || box[1] > hi[1] || box[3] < lo[1]) continue;
      if (deeper([0, 0], [qx * share, qy * share], ring.map(flat), WALL_CLIP_M, inRing(p, ring))) return true;
    }
    return false;
  }


  /** Which end a foot `t` of the way along a `len` m edge is the same node as, if either. */
  function atEnd(t, len) {
    const toA = t * len, toB = (1 - t) * len;
    if (Math.min(toA, toB) >= SNAP_WELD_M) return null;
    return toA <= toB ? 'a' : 'b';
  }

  /** One way onto the network: the edge `seg`, `t` of the way along it. */
  function entry(coord, { seg, t, len }) {
    const end = atEnd(t, len);
    if (end) return { ...joinAt(coord, end === 'a' ? seg.ka : seg.kb, end === 'a' ? seg.a : seg.b), seg };
    const foot = [round7(seg.a[0] + t * (seg.b[0] - seg.a[0])), round7(seg.a[1] + t * (seg.b[1] - seg.a[1]))];
    return {
      coord: foot,
      metres: distance(point(coord), point(foot)) * METRES_PER_KM,
      via: [{ key: seg.ka, km: t * seg.km }, { key: seg.kb, km: (1 - t) * seg.km }],
      edge: seg.id,
      along: (seg.flip ? 1 - t : t) * seg.km,
      seg,
    };
  }

  /**
   * A way on from the wider reach, charged for its leg beyond the first: see
   * OPEN_GROUND_WIDE_CHARGE. `metres` stays the true leg; `cost` is what
   * search() weighs.
   */
  function charged(option, firstReach) {
    if (option.metres <= firstReach) return option;
    return { ...option, cost: option.metres + OPEN_GROUND_WIDE_CHARGE * (option.metres - firstReach) };
  }

  /**
   * The list with every leg charged for its metres beyond `shortest`, the
   * nearest join: see LEG_CHARGE. `metres` stays the true leg; `cost`, on top
   * of any charge the wider reach already put on it, is what search() weighs.
   */
  function priced(list, shortest) {
    return list.map((option) => {
      const beyond = option.metres - shortest;
      return beyond > 0 ? { ...option, cost: (option.cost ?? option.metres) + LEG_CHARGE * beyond } : option;
    });
  }

  /** Joining at a vertex of the graph. */
  function joinAt(coord, key, vertex) {
    return {
      coord: vertex,
      metres: distance(point(coord), point(vertex)) * METRES_PER_KM,
      via: [{ key: key ?? keyOf(vertex), km: 0 }],
      edge: null,
      along: 0,
    };
  }

  /**
   * The nearest point on the network to a coordinate, and how far away it was.
   *
   * The distance is the whole reason this returns an object rather than a
   * coordinate. Snapping has no notion of "too far" — it will hand back the
   * closest point to somewhere on another continent just as cheerfully as to
   * somewhere on the quad — so the caller needs the number to decide whether
   * the answer means anything. Metres, which is what REACH_M is in.
   */
  function snap(coord) {
    const { nearest } = candidates(coord);
    return { coord: nearest.coord, metres: nearest.metres };
  }

  // The outer ring, read the way src/campus-clip.js's ringOf() reads it.
  const campusRing = boundary ? ringOf(boundary) : null;

  const rooms = (doors?.features ?? []).map((f) => ({
    rings: f.geometry.coordinates,
    stubs: f.properties.stubs,
  }));

  // The drawn campus edges with their boxes, for crossing().
  const paths = drawn.filter((seg) => seg.campus).map((seg) => ({
    seg,
    box: [Math.min(seg.a[0], seg.b[0]), Math.min(seg.a[1], seg.b[1]),
      Math.max(seg.a[0], seg.b[0]), Math.max(seg.a[1], seg.b[1])],
  }));

  /**
   * Where the straight line from p to q first crosses a drawn campus path
   * more than SNAP_WELD_M before q, or null: a leg that steps over one path
   * on its way to another. The path it ends on meets it at q, and is no
   * crossing. `seg` is the path crossed and `t` how far along it.
   */
  function crossing(p, q) {
    const my = (EARTH_M * Math.PI) / 180;
    const mx = my * Math.cos((p[1] * Math.PI) / 180);
    const whole = Math.hypot((q[0] - p[0]) * mx, (q[1] - p[1]) * my);
    const lo = [Math.min(p[0], q[0]), Math.min(p[1], q[1])];
    const hi = [Math.max(p[0], q[0]), Math.max(p[1], q[1])];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    let first = null;
    for (const { seg, box } of paths) {
      if (box[0] > hi[0] || box[2] < lo[0] || box[1] > hi[1] || box[3] < lo[1]) continue;
      const { a, b } = seg;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (den === 0) continue;
      const wx = a[0] - p[0], wy = a[1] - p[1];
      const s = (wx * ey - wy * ex) / den, t = (wx * dy - wy * dx) / den;
      if (s < 0 || s > 1 || t < 0 || t > 1 || (1 - s) * whole <= SNAP_WELD_M) continue;
      if (!first || s < first.s) first = { seg, t, s };
    }
    return first;
  }

  /**
   * The doors a coordinate inside a building resolves to, or null.
   *
   * THE STUB A DESTINATION USED TO SNAP TO IS GONE, AND ITS DOOR IS WHAT IS
   * LEFT OF IT. The sheet draws approach paths a few metres into the building
   * they serve, and the walls stage peels each back to the wall it crosses. A
   * room inside the building used to snap onto that stub, so the walk ended
   * where the drawn path enters; with the stub gone, the nearest point on the
   * network can be a path running past a different face of the building, with
   * no way in from it, and the walk ends on the wrong side of the wall. So a
   * coordinate inside a footprint is asked the question the old graph
   * answered: is it closer to something the walls stage took away under that
   * roof than to the network that is left (`onNetwork`, metres to the nearest
   * edge)? If not, nothing was taken from it and the network is joined the way
   * anywhere else joins it.
   *
   * If so, it goes to the building's doors — EVERY DOOR OF THAT FOOTPRINT, and
   * first the one the nearest piece left behind (the nearer of its two, where
   * a cut passage left two), which is what snap() reports. It used to be that
   * door alone, and a room has no more reason to leave by the door nearest it
   * than a person in it does: a defibrillator 33 m from the Gallery resolved
   * to its own building's east door, and the walk to the Gallery went round
   * the outside, 116 m; by the building's west door it is 48 m. Each door is
   * a way on like any other, its straight leg through the building counted
   * against it, and the walk picks.
   *
   * AND EVERY OTHER WAY INTO THE BUILDING, where those doors are a building's
   * in `entrances`: the directory lists, after the drawn doors, where the
   * building's walls come nearest the network, and a room leaves by those as
   * readily as the building is entered by them. The Evangelisti Culinary Arts
   * Center's north door is the end of walkway 1259 where the walls stage cut
   * the passage through the building, 3.7 m from walkway 1293 forking off the
   * same apex 7.5 m up; with that door alone, a walk from the emergency
   * telephone on 1293 to the Oak Café went up one arm of the fork and back down
   * the other to it, 51 m against 40 m when the room can leave by the node
   * on 1293 where the walls come nearest. The network is left as drawn — the
   * two strokes' bands do not meet at the door — and the room is given the way
   * out the building has. Not one whose straight leg goes through a
   * building, though, the rule every way on keeps: a building's ways in can
   * be on another of its footprints, across a yard from this one.
   *
   * NOR ONE ACROSS THE YARD. Those were offered wherever they were within the
   * cap below, and a room walked out of its building, across the grass and
   * over the paths outside, to where the walls come nearest somewhere else:
   * the Counseling Center, inside Administration, left for a point on the
   * lawn west of it by a node on another face of Administration, 35.9 m off
   * and over the path between. A way in that is not
   * one of this footprint's own drawn doors is offered only where its leg runs
   * no more than OPEN_GROUND_M out of doors and steps over no drawn path on
   * the way (crossing()). That turns away seven ways out of four rooms in
   * places.json, the Counseling Center, the Design Hub, Fine and Applied Arts
   * and the MCT HomeBase, 34 to 66 m off.
   *
   * OUT OF DOORS IS OUTSIDE EVERY FOOTPRINT OF THE BUILDING. It was outside
   * the one the room is in, and CTE is drawn as two that abut: the Design Hub
   * and the MCT HomeBase, in one, were refused CTE's north door on the other
   * for metres of their legs that never leave the building, and the second
   * footprint was held against the leg as a wall as well (throughBuilding()
   * lets a leg through its own building's footprints now). The MCT HomeBase
   * walked 97.5 m round to the bike rack north of CTE, and walks 48.2 m out
   * of the north door; the Design Hub 107.6 m, now 71.9 m. 38 of 36,191
   * walks between places, entrances, amenities and random points come out
   * shorter, by 701 m in all, and none longer. The seven ways above are
   * still turned away, for metres that are out of doors.
   *
   * NOR ONE FURTHER THAN OPEN_GROUND_MAX_M BEYOND THE NEAREST DOOR. The leg
   * to a way in is a straight dotted line through the room's own building,
   * and nothing checks what it crosses in there. With no bound, the emergency
   * telephones in the Parking Garage, 7.7 m from its nearest door, were
   * offered seven ways out, the furthest 132 m off, and the walk to the
   * Baseball field began with that 132 m line diagonally across the deck.
   * Over every walk between two places, 28 legs ran more than 50 m further
   * than the nearest join, 20 of them more than 100 m. The footprint's drawn
   * doors are its own ways out and stay on offer however far; where the walls
   * come nearest is offered within the cap, as open ground is, and out to
   * OPEN_GROUND_WIDE_M (`wide`) at the wider reach's price (see
   * OPEN_GROUND_WIDE_CHARGE). The garage's further ways are what it costs.
   * When the cap came in, 244 of 37,391 walks were longer for it, by 10 m at
   * the median, and none more than a quarter longer than the nearest-vertex
   * router's. Between two places the longest leg is 98.7 m, and none runs
   * more than 60 m further than the nearest join. 178 run more than 50 m
   * further, each where the charges were worth paying; 656 did before every
   * leg was charged beyond the nearest (LEG_CHARGE), and there were 18 when
   * the wider reach was searched only for a detour. `bounded` says whether the cap held
   * anything back, so the wider reach has something to offer. `reach` is the
   * first reach, which the charge is counted beyond.
   *
   * Measured against the nearest point on any edge, not the nearest vertex,
   * because that is what the build compared when it decided not to splice the
   * destination in.
   */
  function doorFor(coord, onNetwork, wide = false) {
    const inside = rooms.filter(({ rings }) => inRing(coord, rings[0])
      && !rings.slice(1).some((hole) => inRing(coord, hole)));
    if (!inside.length) return null;
    let best = null;
    for (const { rings, stubs } of inside) {
      for (const stub of stubs) {
        const d = Math.min(...stub.under.map(([a, b]) => metresToSegment(coord, a, b)));
        if (d >= onNetwork || (best && d >= best.d)) continue;
        const near = stub.doors.reduce((x, y) => (
          distance(point(coord), point(y)) < distance(point(coord), point(x)) ? y : x));
        best = { d, near, stubs, rings };
      }
    }
    if (!best) return null;
    const rest = new Map();
    for (const stub of best.stubs) {
      for (const door of stub.doors) if (keyOf(door) !== keyOf(best.near)) rest.set(keyOf(door), door);
    }
    const away = (door) => distance(point(coord), point(door)) * METRES_PER_KM;
    const reach = away(best.near) + (wide ? OPEN_GROUND_WIDE_M : OPEN_GROUND_MAX_M);
    // Metres of the leg to `way` outside the footprint the room is in and
    // every footprint of the building `way` leads into: indoors is indoors,
    // whichever of a building's footprints it is under.
    const outdoors = (way, building) => {
      const length = away(way);
      const under = [best.rings, ...building.polygons];
      const cuts = [...new Set(under.flatMap((rings) => rings.flatMap((ring) => cutsAlong(coord, way, ring))))]
        .sort((x, y) => x - y);
      let out = 0;
      for (let k = 1; k < cuts.length; k += 1) {
        const t = (cuts[k - 1] + cuts[k]) / 2;
        const p = [coord[0] + t * (way[0] - coord[0]), coord[1] + t * (way[1] - coord[1])];
        if (!under.some(([outline, ...holes]) => inRing(p, outline) && !holes.some((hole) => inRing(p, hole)))) {
          out += (cuts[k] - cuts[k - 1]) * length;
        }
      }
      return out;
    };
    let bounded = false;
    for (const door of [best.near, ...rest.values()]) {
      const building = buildingAt.get(keyOf(door));
      for (const way of building?.doors ?? []) {
        if (keyOf(way) === keyOf(best.near) || rest.has(keyOf(way)) || throughBuilding(coord, way, building.own)) continue;
        if (outdoors(way, building) > OPEN_GROUND_M || crossing(coord, way)) continue;
        if (away(way) > reach) { bounded = true; continue; }
        rest.set(keyOf(way), way);
      }
    }
    return {
      doors: [best.near, ...[...rest.values()].sort((x, y) => away(x) - away(y))],
      bounded,
      reach: away(best.near) + OPEN_GROUND_MAX_M,
    };
  }

  /**
   * The cheapest walk from any of `starts` to any of `ends`, or `found:
   * false` if there is none; and either way `across`, what the cheapest
   * pairing it passed over walks (see below, and DETOUR_SHARE), Infinity if it
   * passed none.
   *
   * Each way on or off costs its straight-line metres from the requested
   * point — with the charges on a leg beyond the nearest join, over a path
   * and from the wider reach, see LEG_CHARGE and OPEN_GROUND_WIDE_CHARGE;
   * `metres` and `across` are what is walked, `cost` what was weighed — plus
   * the part of its edge to the vertex the search
   * enters at: the walk from where you are to the path counts against the
   * path it reaches,
   * which is what stops a slightly nearer edge winning when it leads the long
   * way round. Two ways on and off the SAME edge can also just walk along it
   * to each other — a search between its ends would leave by one and come
   * back — so that pairing is costed directly.
   *
   * A WALK SHORTER THAN SNAP_WELD_M DOES NOT COUNT. With several ways on and
   * off, the cheapest pairing can be one that never uses the network: TRIO and
   * the Veterans Resource Center are 27 m apart, the Center's own node was
   * within the slack of TRIO when this was written, and "walk 36 m across to
   * it and you are there" cost less than any walk along a path. It is not a
   * route — there is nothing to draw — so pairings whose walk is shorter than
   * the weld are passed over, and the walk is the cheapest that is one.
   * Whether the two points are the same place is not decided here; route()
   * asks samePlace(), and weighs the walk against the cheapest pairing passed
   * over (`across`): see DETOUR_SHARE.
   *
   * NOR DOES A WALK THAT COMES BACK TO WHERE IT JOINED. The rule above is about
   * metres walked, and a pairing whose way on and way off are one place on the
   * network (samePlace() again) can still walk further than the weld by going
   * somewhere and coming back. Two points on a lawn 17 m apart both had a way
   * across the grass to the same few metres of path, and the cheapest walk
   * between those two feet that was not passed over went 8 m along the path to
   * its next vertex and back: 54 ft, "1 turn", a spur drawn out and back with
   * both dotted legs meeting where it began. The ways on from open ground
   * (OPEN_GROUND_M) made such pairings common: of 18,937 walks between random
   * points 10 to 70 m apart, 212 joined and left the network within 3 m of
   * each other yet walked more than 4 m, against 74 without them. A pairing of
   * two ways onto the same place is passed over like a walk under the weld,
   * whatever it would walk, and the walk is the cheapest between two places.
   * That can be a good deal longer than the pairing passed over: those two
   * points on the lawn now walk 148 m, legs and all, against 84 m by the spot
   * where their ways across the grass meet. It is an honest walk, drawn, and
   * under DETOUR_SHARE times the other; past that, route() refuses it.
   * The nearest way on and the nearest way off are never one place — route()
   * has refused the request as 'same-place' before searching if they are — so
   * this never leaves a connected graph with no walk at all.
   *
   * ONE SEARCH FROM EVERY WAY ON AT ONCE, AND ONE PER WAY ON ONLY IF THAT
   * PASSED SOMETHING OVER. A single Dijkstra seeded from all of them keeps
   * only the cheapest way to each vertex, and the cheapest way to the vertex
   * beside the destination can be exactly the pairing that gets passed over,
   * taking the honest walk to it down too. So the joint search notes whether
   * it passed anything over, and only then is the answer asked again from
   * each way on alone, which is exact; when it passed nothing over, the
   * cheapest way to every vertex was a walk, and the joint answer is the
   * exact one already. Either way the best total so far stops a search as
   * soon as nothing left on its frontier can beat it. When the plazas came
   * in it was about 0.4 ms between two places, 0.6 ms for an arbitrary point
   * on the campus and 0.9 ms from the streets around it, on a development Mac,
   * where the nearest-vertex router took 0.9 ms for one search. It is slower
   * now. Timed side by side in one process under a load average of about 3,
   * against this router as last committed, before the plaza lines (590 more
   * edges every request reads), the wider reach on every request and the
   * rooms' ways out: 0.86 against 0.53 ms between two places, 0.9 against
   * 0.68 ms between two arbitrary points on the campus, and 1.6 against
   * 1.5 ms from the streets, where most of that does not apply. The tail is a
   * percentile, not a bound: 1.4 to 2.1 ms at the 99th between two places,
   * against 0.9 to 2, and 3.5 to 6 ms for the slowest of 1,554, from one run
   * to the next. Each step was timed as it came in, below, and none
   * showed much alone. Searching from each way on alone every time,
   * as this did before the ways on from open ground were added, took 1.3 ms
   * on average and 10 ms at worst with them. The wider reach is searched
   * with the first, every time there is one (OPEN_GROUND_WIDE_CHARGE). Timed
   * side by side in one process against asking it only of a detour, under a
   * load average of 5, that adds about a tenth on the campus: 0.85 against
   * 0.77 ms between two places, 0.93
   * against 0.83 ms from an arbitrary point, 2.4 against 2.1 ms at the 99th
   * percentile. It adds nothing from the streets, where there is no wider
   * reach. Keeping every leg out of the buildings and charging the ones that
   * step over a path (candidates()) costs nothing that shows: side by side in
   * one process under a load average of 3 to 6, 0.79 against 0.74 ms between
   * two places, 0.99 against 1.02 ms from an arbitrary point and 0.83 against
   * 0.90 ms from the streets, which is noise.
   *
   * Ties go to whatever is found first, which depends only on the graph and
   * the request, so the same request always draws the same line. `km` is the
   * walk along the network alone; the legs on and off are drawn by the
   * browser, dotted, and served beside it (`legFeet` in route()).
   */
  function search(starts, ends) {
    // What a leg costs the search (see LEG_CHARGE), and what it is.
    const offNetwork = (option) => (option.cost ?? option.metres) / METRES_PER_KM;
    const legs = (s, e) => (s.metres + e.metres) / METRES_PER_KM;
    const shortest = SNAP_WELD_M / METRES_PER_KM;
    let best = null;
    // Nothing that costs this much is an answer: the best walk so far.
    const bound = () => (best ? best.total : Infinity);
    // The cheapest pairing passed over, legs and all: what it costs to get
    // from one end to the other without walking along the network. route()
    // weighs the walk against it.
    let across = Infinity;
    starts.forEach((s, i) => ends.forEach((e, j) => {
      if (!s.edge || s.edge !== e.edge) return;
      const km = Math.abs(s.along - e.along);
      const total = offNetwork(s) + km + offNetwork(e);
      if (km < shortest) across = Math.min(across, legs(s, e) + km);
      else if (total < bound()) best = { total, km, i, j, keys: [] };
    }));

    // Whether way on i and way off j are one place: asked only of a pairing
    // the search reaches, and only once. Straight-line metres first, because
    // two places closer than the weld along the network are closer than it
    // as the crow flies, and almost no pairing is.
    const spurs = new Map();
    const spur = (i, j) => {
      const k = i * ends.length + j;
      if (!spurs.has(k)) {
        spurs.set(k, distance(point(starts[i].coord), point(ends[j].coord)) < shortest
          && samePlace(starts[i], ends[j]));
      }
      return spurs.get(k);
    };

    const exits = new Map();
    ends.forEach((e, j) => {
      for (const { key, km } of e.via) {
        if (!exits.has(key)) exits.set(key, []);
        exits.get(key).push({ j, km });
      }
    });

    /** Dijkstra from the ways on numbered `from`; whether it passed a pairing over. */
    function sweep(from) {
      let passedOver = false;
      const cost = new Map();
      const prev = new Map();
      const origin = new Map();
      const queue = createHeap();
      for (const i of from) {
        const leg = offNetwork(starts[i]);
        if (leg >= bound()) continue;
        for (const { key, km } of starts[i].via) {
          if (leg + km >= (cost.get(key) ?? Infinity)) continue;
          cost.set(key, leg + km);
          origin.set(key, i);
          queue.push(leg + km, key);
        }
      }
      while (queue.size) {
        const [c, key] = queue.pop();
        if (c > cost.get(key)) continue;
        if (c >= bound()) break;
        const i = origin.get(key);
        for (const { j, km } of exits.get(key) ?? []) {
          const walked = c - offNetwork(starts[i]) + km;
          const total = c + km + offNetwork(ends[j]);
          if (total >= bound()) continue;
          if (walked < shortest || spur(i, j)) {
            passedOver = true;
            across = Math.min(across, legs(starts[i], ends[j]) + walked);
            continue;
          }
          const keys = [];
          for (let k = key; k !== undefined; k = prev.get(k)) keys.push(k);
          best = { total, km: walked, i, j, keys: keys.reverse() };
        }
        for (const [next, w] of Object.entries(adjacency[key])) {
          if (w === Infinity) continue;
          const nc = c + w;
          if (nc >= (cost.get(next) ?? Infinity)) continue;
          cost.set(next, nc);
          prev.set(next, key);
          origin.set(next, i);
          queue.push(nc, next);
        }
      }
      return passedOver;
    }

    if (sweep(starts.map((_, i) => i))) starts.forEach((_, i) => sweep([i]));
    if (!best) return { found: false, across };

    // The line is the joined point, the vertices walked, and the joined point
    // at the other end — each end added only where it is not already the
    // first or last vertex, so a walk that starts on a vertex does not begin
    // with a zero-length segment for buildManeuvers to take a bearing across.
    const coordinates = best.keys.map((k) => sourceCoordinates[k]);
    const from = starts[best.i].coord, to = ends[best.j].coord;
    if (!coordinates.length || keyOf(coordinates[0]) !== keyOf(from)) coordinates.unshift(from);
    if (keyOf(coordinates.at(-1)) !== keyOf(to)) coordinates.push(to);
    const start = starts[best.i], end = ends[best.j];
    return {
      found: true, km: best.km, cost: best.total, metres: best.km + legs(start, end), across, coordinates, from, to, start, end,
    };
  }

  /**
   * Whether two ways onto the network are one place on it: the same vertex,
   * the same edge less than SNAP_WELD_M apart along it, or two vertices joined
   * by less than that — the sub-metre joints the build leaves where it cuts a
   * path at a wall. A foot is never within the weld of its edge's ends, so
   * those are the only ways to be that close.
   */
  function samePlace(s, e) {
    const shortest = SNAP_WELD_M / METRES_PER_KM;
    if (keyOf(s.coord) === keyOf(e.coord)) return true;
    if (s.edge || e.edge) return Boolean(s.edge && s.edge === e.edge && Math.abs(s.along - e.along) < shortest);
    const target = e.via[0].key;
    const cost = new Map([[s.via[0].key, 0]]);
    const queue = createHeap();
    queue.push(0, s.via[0].key);
    while (queue.size) {
      const [c, key] = queue.pop();
      if (key === target) return true;
      if (c > cost.get(key)) continue;
      for (const [next, w] of Object.entries(adjacency[key])) {
        const nc = c + w;
        if (nc >= shortest || nc >= (cost.get(next) ?? Infinity)) continue;
        cost.set(next, nc);
        queue.push(nc, next);
      }
    }
    return false;
  }

  /**
   * A walk between two coordinates, or a stated reason there is not one.
   *
   * Three outcomes, discriminated rather than thrown, because each one is a
   * different HTTP answer and a different sentence in front of the user:
   *
   *   { ok: true, ... }                      a route
   *   { ok: false, reason: 'unreachable' }   an end too far from the graph to snap
   *   { ok: false, reason: 'no-path' }       both ends snapped; the graph does not join them
   *   { ok: false, reason: 'same-place' }    both ends snapped to the same place, or the
   *                                          walk is a detour on not walking at all
   *
   * THE FIRST REFUSAL IS THE ONE THIS FUNCTION EXISTS FOR. Snapping is
   * unconditional, so without it a request from ten miles away comes back as a
   * confident eight-minute walk between two places neither of which is where you
   * are — the distance is real, the walk is real, and it is not yours. The rule
   * was written down in src/directions.js and enforced in the browser only,
   * which left the endpoint itself answering nonsense to anything that was not
   * our own front-end. It is the graph's rule, so it belongs where the graph is.
   *
   * The line runs between the two points where the walk joins and leaves the
   * network, which are usually not vertices; `snapped` says where they are.
   * Getting from the requested point to the line is not part of it, and is not
   * in `distanceFeet`: the browser draws that bit separately, dotted (legs() in
   * src/route-state.js), and `legFeet` says how long each is, so the card can
   * give the whole walk. Between two places the two come to a median 33 m.
   */
  function route(from, to) {
    const starts = candidates(from);
    const ends = candidates(to);

    // The start is reported first because it is the one a person can be wrong
    // about: a destination is picked off the campus directory, an origin is
    // wherever the phone says you are standing.
    for (const [which, { nearest }] of [['start', starts], ['end', ends]]) {
      const problem = reachProblem(nearest.metres);
      if (problem) {
        return {
          ok: false,
          reason: 'unreachable',
          which,
          metres: nearest.metres,
          error: problem,
        };
      }
    }

    // A WALK OF ONE POINT IS NOT A WALK. When both ends snapped to the same
    // vertex — two taps inside one courtyard, a destination picked while
    // standing on it — the path finder answered with a path of a single
    // coordinate and a weight of zero. That was answered as 200 OK, and
    // everything downstream assumed at least two: `lineString()` throws
    // outright on one coordinate, so the browser's route handler died
    // mid-assignment and left the panel saying "Calculating…" for ever; had it
    // survived, `maneuvers.length - 2` would have put "Route calculated — -2
    // turns." under it.
    //
    // NOW THAT ENDS LAND BETWEEN VERTICES, "THE SAME VERTEX" IS TOO NARROW A
    // TEST. Two taps a hand's width apart beside one edge join it a hand's
    // width apart, and that is a two-coordinate line a few centimetres long —
    // drawable, and just as much not a walk. So the line is the build's own:
    // two points closer than SNAP_WELD_M along the network are one node to the
    // build's splice, and are the same place here. Asked of the NEAREST joins
    // only, because those are where the two points are; the further ones are
    // there to choose a better walk, not to decide whether there is one.
    //
    // Same shape as the reach check above, and refused for the same reason:
    // the endpoint is public, and a caller that asks for a zero-length walk
    // should be told that is what they asked for rather than handed a
    // degenerate geometry to crash on.
    //
    // AND A BUILDING IS THE SAME PLACE AS ITSELF, AND AS ANYWHERE INSIDE IT.
    // Asked of the doors and the footprint rather than the nearest join,
    // because a building's ends are all its doors at no distance: from the
    // Student Center's restroom to the Student Center, the nearest pairing of
    // doors is one door and the walk that is left over is from one of its
    // doors to another round the outside — a route, by the rule above, and not
    // one anybody standing in the building wants. (The nearest-vertex router
    // walked it 101 m.) See sameBuilding().
    //
    // The third refusal, a walk that is a detour on not walking the paths at
    // all, comes after the search, which is what finds it: see DETOUR_SHARE.
    if (samePlace(starts.nearest, ends.nearest) || sameBuilding(starts.nearest, ends.nearest, from, to)) {
      return {
        ok: false,
        reason: 'same-place',
        error: 'Start and destination are the same place — pick a destination further off.',
      };
    }

    // THE WIDER REACH IS ALWAYS ON OFFER, AT A PRICE: see
    // OPEN_GROUND_WIDE_CHARGE. On the campus, from open ground or out of a
    // room whose building has ways in beyond the usual reach, the search is
    // given the ways on the wider reach adds as well, each charged for its leg
    // beyond the first reach. One search, so a way on can only ever be one
    // more choice, and never the thing that stops a better one being asked.
    const walk = search(starts.wider?.() ?? starts.list, ends.wider?.() ?? ends.list);
    if (!walk.found) return { ok: false, reason: 'no-path', error: 'no path found on the network' };

    // AND A WALK THAT IS A DETOUR ON NOT WALKING THE NETWORK AT ALL IS NOT
    // ONE: see DETOUR_SHARE. The two ends meet the paths at one place, and the
    // network has nothing to add to getting from one to the other.
    if (walk.metres > DETOUR_SHARE * walk.across) {
      return {
        ok: false,
        reason: 'same-place',
        error: 'Start and destination are the same place as far as the paths go — walk straight over, '
          + 'or pick a destination further off.',
      };
    }

    // THE ENDS AS THEY WILL STAND. A building's pin moves to the door the
    // walk used (`door` below), so that end's leg is nothing and the walk is
    // asked about from there; anywhere else, from the point asked about.
    const ask = { from: walk.start.building ? walk.from : from, to: walk.end.building ? walk.to : to };
    const feet = (metres) => Math.round((metres * FEET_PER_KM) / METRES_PER_KM);
    return {
      ok: true,
      geometry: { type: 'LineString', coordinates: walk.coordinates },
      distanceFeet: Math.round(walk.km * FEET_PER_KM),
      // With what a walker can see at each vertex — which bends are
      // junctions, which other branches leave beside the one taken — and
      // where the walk was asked to start and end, so the first and last
      // instructions can say which way to turn off and onto the dotted legs.
      maneuvers: buildManeuvers(walk.coordinates, { degreeAt, branchesAt, ...ask }),
      // The dotted legs, in feet, which distanceFeet leaves out: from the
      // point asked about to where the line starts, and from where it ends to
      // the other. A building's is nothing, from the door it stands at.
      legFeet: { from: feet(walk.start.metres), to: feet(walk.end.metres) },
      snapped: { from: walk.from, to: walk.to },
      // Which door the walk used, at an end that asked for a building by one
      // of its doors — so the pin can stand at that door rather than at the
      // one it was asked about, with a dotted line across the building
      // between them. Null at an end that is not a building.
      door: { from: walk.start.building ? walk.from : null, to: walk.end.building ? walk.to : null },
      // What the search weighed, in metres: the walk, both legs, and the
      // charge on any leg from the wider reach (OPEN_GROUND_WIDE_CHARGE). Not
      // served; it is the number another way to walk can only lower, which is
      // what the tests hold the router to.
      cost: walk.cost * METRES_PER_KM,
    };
  }

  /**
   * Whether one end is a building and the other that building, or anywhere
   * inside it. Two rooms in one building are two places; whether they are near
   * enough to be one is samePlace()'s question, as for anywhere else.
   *
   * INSIDE ITS FOOTPRINT, NOT ONLY AT ITS DOORS. A room used to be the same
   * place as its building only when it resolved to the building's doors —
   * when it was nearer an approach path the walls stage peeled than the
   * network that is left (doorFor()). Most of what stands inside a building is
   * not: of the 87 places inside a directory building's footprint, 65 were
   * walked to their own building — the Library to the Library across 17 m of
   * dotted leg and 10 m of path, the Welcome and Support Center to itself in
   * 30 m and 6 m, its Welcome Desk in 46 m and 9 m. So a point
   * inside the footprint of the building at the other end is the same place,
   * whatever it snapped to. Not asked when both ends are buildings: a door
   * sits on a wall, and on a wall two buildings share it is inside either.
   */
  function sameBuilding(s, e, from, to) {
    const inside = (p, polygons) => (polygons ?? []).some((rings) => inRing(p, rings[0])
      && !rings.slice(1).some((hole) => inRing(p, hole)));
    if (s.building && !e.building && inside(to, s.footprint)) return true;
    if (e.building && !s.building && inside(from, e.footprint)) return true;
    const x = s.building ?? s.room, y = e.building ?? e.room;
    if (!x || !y || (s.room && e.room)) return false;
    const there = new Set(y.map(keyOf));
    return x.some((d) => there.has(keyOf(d)));
  }

  return {
    vertices,
    snap,
    route,
    segmentCount: features.length,
    // What the path finder actually built, read off its graph rather than
    // assumed: the number that showed the precision option was being ignored.
    vertexCount: Object.keys(adjacency).length,
  };
}

/**
 * A binary min-heap of [cost, key], for search().
 *
 * Twenty lines rather than a dependency. geojson-path-finder brings tinyqueue
 * with it, but as its own dependency, not this project's, and importing a
 * package the manifest does not name is a build that works until a lockfile
 * changes.
 */
function createHeap() {
  const items = [];
  return {
    get size() { return items.length; },
    push(cost, key) {
      items.push([cost, key]);
      let i = items.length - 1;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (items[up][0] <= items[i][0]) break;
        [items[up], items[i]] = [items[i], items[up]];
        i = up;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < items.length && items[l][0] < items[m][0]) m = l;
          if (r < items.length && items[r][0] < items[m][0]) m = r;
          if (m === i) break;
          [items[m], items[i]] = [items[i], items[m]];
          i = m;
        }
      }
      return top;
    },
  };
}

export { REACH_M };
