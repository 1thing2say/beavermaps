// Where the campus is, and how far the camera may go.
//
// Two boxes, both hardcoded, both describing files that a build script owns.
// That is a smell and it is not an avoidable one: `bounds` and `maxBounds` are
// wanted when the map is CONSTRUCTED, which is before /api/vertices has landed.
// So the numbers have to be in the bundle.
//
// Its own module rather than two consts in main.js because that file has no
// exports and pulls in mapbox-gl, deck.gl and the DOM the moment it is loaded,
// so nothing could check these against the data they claim to describe.
// test/bounds.test.js now can. Same arrangement REACH_M has in
// src/directions.js and test/directions.test.js: the number lives where it is
// needed, and a test keeps it honest.

/**
 * Bounding box of the walkable campus network, [[west, south], [east, north]].
 *
 * Printed by scripts/build-walk-network.mjs — regenerate src/paths.json and
 * update this. The map opens fitted to it.
 */
export const CAMPUS_BOUNDS = [
  [-121.350452, 38.644706],
  [-121.342319, 38.653606],
];

/**
 * How far the camera may travel, [[west, south], [east, north]].
 *
 * THE INVARIANT THREE OTHER COMMENTS ALREADY ASSUMED. `maxTileCacheSize: 60` in
 * main.js is argued for on the grounds that "the camera cannot leave
 * CAMPUS_BOUNDS: there is no long pan across a city to refetch" — and nothing
 * set a bound. `bounds:` in the map constructor is the opening fit, not a fence.
 *
 * So the camera could go anywhere on earth. Two things followed from that. The
 * tile-cache trade became a guess, since Google bills per tile request and a pan
 * across Sacramento is a great many of them. And a press-and-hold could drop a
 * start point in another county, where the router would snap it to the nearest
 * vertex and announce a confident eight-minute walk — the exact failure REACH_M
 * was written to stop, arriving through the one door REACH_M was not checked at.
 *
 * THE APPROACH NETWORK'S BOX, not the campus's. A route may legitimately start
 * on the pavement outside and run in through a gate, and `frame(routeCoords)`
 * has to be able to fit that; fenced to CAMPUS_BOUNDS the map could not show the
 * first half of a walk it had just calculated. So the fence is the area the
 * server can actually route over, padded enough that a route touching the edge
 * still frames with its margin. Everything reachable is inside; nothing else is.
 */
export const ROUTABLE_BOUNDS = [
  [-121.3625, 38.6350],
  [-121.3306, 38.6633],
];
