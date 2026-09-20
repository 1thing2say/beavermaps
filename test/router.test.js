// server/graph.js — the router, and the question it used to get wrong.
//
// This file exists because server/index.js could not be imported. It built the
// graph at module scope and called app.listen() on the way past, so every
// question about the router was a question you could only ask over HTTP, and
// the one that mattered — "what does this answer somebody who is not near the
// campus" — went unasked for as long as the endpoint existed.
//
// The answer was a route. `nearestPoint` has no notion of too far, so a request
// from Paris came back 200 with a real 7,520 ft walk starting at a vertex in
// Sacramento. src/directions.js had had REACH_M written down the whole time,
// with a comment describing that exact failure; it was enforced in the browser
// and nowhere else, which means it was enforced for our own front-end and for
// nothing else that can reach the endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, VERTEX_PRECISION } from '../server/graph.js';
import { REACH_M } from '../src/directions.js';
import { load } from './helpers.js';

// The real committed artifacts, because a router built out of a fixture would
// answer questions about the fixture. The build is ~300 ms, once, for the file.
const graph = createGraph({
  network: load('paths'),
  approach: load('approach-paths'),
});

/** Somewhere on the campus network, taken from the data rather than typed. */
const ON_CAMPUS = load('paths').features[0].geometry.coordinates[0];
const ALSO_ON_CAMPUS = load('paths').features.at(-1).geometry.coordinates.at(-1);

const PARIS = [2.3522, 48.8566];
// Sacramento's own downtown: a few miles away, which is the realistic version
// of this mistake. Somebody opens the app from home.
const ACROSS_TOWN = [-121.4944, 38.5816];

test('the graph welds the campus and approach networks into one', () => {
  // The two files share vertices at seven decimals and geojson-path-finder
  // builds topology from coordinates, so concatenation IS the merge. If that
  // ever stopped being true this is where it would show: a route between two
  // campus points would still work, and every route that leaves by a gate
  // would not.
  assert.equal(graph.segmentCount, load('paths').features.length + load('approach-paths').features.length);
  assert.ok(graph.vertices.length > 6000, `only ${graph.vertices.length} vertices`);
});

test('a walk between two campus points is found', () => {
  const result = graph.route(ON_CAMPUS, ALSO_ON_CAMPUS);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.equal(result.geometry.type, 'LineString');
  assert.ok(result.geometry.coordinates.length >= 2);
  assert.ok(result.distanceFeet > 0);
  // Every route carries a maneuver list, and it always has both ends in it.
  assert.ok(result.maneuvers.length >= 2);
});

test('a start on the other side of the world is refused, not routed', () => {
  const result = graph.route(PARIS, ALSO_ON_CAMPUS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.equal(result.which, 'start');
  // The sentence is directions.js's, not one invented here — the browser and
  // the server refuse in the same words because it is the same rule.
  assert.match(result.error, /too far to walk from here/);
});

test('a start a few miles away is refused too — this is the realistic case', () => {
  // Paris is the version of this bug that is obvious once you see it. This is
  // the version that shipped: near enough that the numbers look plausible.
  const result = graph.route(ACROSS_TOWN, ALSO_ON_CAMPUS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
});

test('an unreachable DESTINATION is refused as well, and says which end', () => {
  const result = graph.route(ON_CAMPUS, PARIS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.equal(result.which, 'end');
});

test('the start is reported first when both ends are unreachable', () => {
  // Not arbitrary: a destination is picked off the campus directory and an
  // origin is wherever the phone says you are standing, so the origin is the
  // one a person can be wrong about and the one worth naming.
  const result = graph.route(PARIS, ACROSS_TOWN);
  assert.equal(result.which, 'start');
});

test('REACH_M is the line the router actually draws', () => {
  // The property worth asserting is not where the boundary falls on the map —
  // the network is dense enough that stepping 450 m off one vertex usually
  // lands you near another — but that the router's decision IS reachProblem's
  // decision. One rule, one constant, written down in src/directions.js and
  // obeyed on both sides of the wire.
  //
  // Sampled over a wide box so the set covers both answers: points on the
  // campus, points out in the fields around it, and points well past anything
  // this server has ever heard of.
  let refused = 0;
  let allowed = 0;

  for (let dLon = -0.25; dLon <= 0.25; dLon += 0.05) {
    for (let dLat = -0.25; dLat <= 0.25; dLat += 0.05) {
      const at = [-121.3465 + dLon, 38.6486 + dLat];
      const snapped = graph.snap(at);
      const result = graph.route(at, ALSO_ON_CAMPUS);
      const tooFar = snapped.metres > REACH_M;

      assert.equal(
        result.reason === 'unreachable', tooFar,
        `${at} snaps ${snapped.metres.toFixed(0)} m away — REACH_M is ${REACH_M}`,
      );
      if (tooFar) refused++; else allowed++;
    }
  }

  // Both answers have to actually occur, or the assertion above is vacuous.
  assert.ok(refused > 0 && allowed > 0, `refused ${refused}, allowed ${allowed}`);
});

test('snap reports metres, which is what REACH_M is in', () => {
  // turf answers in km and the constant is in metres. That conversion living in
  // the wrong place would make every refusal a thousand times too generous —
  // which is indistinguishable from no check at all.
  const near = graph.snap(graph.vertices[0]);
  assert.equal(near.metres, 0);

  const far = graph.snap(PARIS);
  assert.ok(far.metres > 1e6, `Paris is ${far.metres} m away — that is not metres`);
});

test('a snapped point is a vertex of the graph, exactly', () => {
  // findPath only accepts points that ARE nodes. A snap that returned something
  // near a vertex rather than the vertex would fail on every route.
  const keys = new Set(graph.vertices.map((v) => `${v[0]},${v[1]}`));
  const snapped = graph.snap([ON_CAMPUS[0] + 0.0001, ON_CAMPUS[1] + 0.0001]);
  assert.ok(keys.has(`${snapped.coord[0]},${snapped.coord[1]}`));
});

test('the vertex precision is tight enough not to weld distinct junctions', () => {
  // The library's default is 1e-5 and the closest pair of distinct campus nodes
  // is 1.24e-5 apart, which is a 24% margin — one re-survey from being wrong.
  // This is the assertion that makes that number answerable to the data.
  let closest = Infinity;
  const campus = load('paths').features.flatMap((f) => f.geometry.coordinates);
  for (let i = 0; i < campus.length; i++) {
    for (let j = i + 1; j < campus.length; j++) {
      const d = Math.hypot(campus[i][0] - campus[j][0], campus[i][1] - campus[j][1]);
      if (d > 0 && d < closest) closest = d;
    }
  }
  assert.ok(VERTEX_PRECISION < closest / 10,
    `precision ${VERTEX_PRECISION} vs closest distinct pair ${closest.toExponential(3)}`);
});
