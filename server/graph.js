// The routing graph, and the one question it answers.
//
// Its own module because server/index.js could not be tested without it. That
// file builds the graph at import time and calls app.listen() on the way past,
// so "does the router refuse a start point in Paris" was a question you could
// only ask by standing a server up and talking HTTP to it — which is why nobody
// asked it, and why it did not refuse.
//
// Everything here is a pure function of the two FeatureCollections handed in.
// No file reads, no express, no port. index.js reads the files and owns the
// HTTP contract; this owns the geometry.

import pathFinderModule from 'geojson-path-finder';
import { point, featureCollection } from '@turf/helpers';
import { nearestPoint } from '@turf/nearest-point';
import { buildManeuvers, FEET_PER_KM } from '../src/maneuvers.js';
import { REACH_M, reachProblem } from '../src/directions.js';

// geojson-path-finder ships CommonJS with no "exports" map, so under bare Node
// the default import is the module namespace rather than the class itself.
// Vite's bundler papers over this; node does not.
const PathFinder = pathFinderModule.default ?? pathFinderModule;

/**
 * How close two coordinates must be before the graph treats them as one vertex.
 *
 * The library's default is 1e-5 degrees, and the closest pair of distinct campus
 * nodes is 1.24e-5 apart — a 24% margin. Tightening it to 1e-7 (~1cm, matching
 * the precision paths.json is written at) keeps tight junctions like stair
 * landings from being welded into a single vertex.
 */
export const VERTEX_PRECISION = 1e-7;

const METRES_PER_KM = 1000;

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
 */
export function createGraph({ network, approach }) {
  const features = [...network.features, ...approach.features];
  const pathFinder = new PathFinder(
    { type: 'FeatureCollection', features },
    { precision: VERTEX_PRECISION },
  );

  // Every unique vertex, so incoming coordinates can be snapped onto the graph.
  // findPath only accepts points that are actually nodes in the network.
  const vertices = uniqueVertices(features);
  const networkPoints = featureCollection(vertices.map((v) => point(v)));

  /**
   * The nearest graph vertex to a coordinate, and how far away it was.
   *
   * The distance is the whole reason this returns an object rather than a
   * coordinate. `nearestPoint` has no notion of "too far" — it will hand back
   * the closest vertex to a point on another continent just as cheerfully as to
   * one on the quad — so the caller needs the number to decide whether the
   * answer means anything. turf reports it in km; metres is what REACH_M is in.
   */
  function snap(coord) {
    const found = nearestPoint(point(coord), networkPoints);
    return {
      coord: found.geometry.coordinates,
      metres: found.properties.distanceToPoint * METRES_PER_KM,
      feature: found,
    };
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
   *   { ok: false, reason: 'same-place' }    both ends snapped to the SAME vertex
   *
   * THE FIRST REFUSAL IS THE ONE THIS FUNCTION EXISTS FOR. Snapping is
   * unconditional, so without it a request from ten miles away comes back as a
   * confident eight-minute walk between two places neither of which is where you
   * are — the distance is real, the walk is real, and it is not yours. The rule
   * was written down in src/directions.js and enforced in the browser only,
   * which left the endpoint itself answering nonsense to anything that was not
   * our own front-end. It is the graph's rule, so it belongs where the graph is.
   */
  function route(from, to) {
    const start = snap(from);
    const end = snap(to);

    // The start is reported first because it is the one a person can be wrong
    // about: a destination is picked off the campus directory, an origin is
    // wherever the phone says you are standing.
    for (const [which, snapped] of [['start', start], ['end', end]]) {
      const problem = reachProblem(snapped.metres);
      if (problem) {
        return {
          ok: false,
          reason: 'unreachable',
          which,
          metres: snapped.metres,
          error: problem,
        };
      }
    }

    const result = pathFinder.findPath(start.feature, end.feature);
    if (!result) return { ok: false, reason: 'no-path', error: 'no path found on the network' };

    // A WALK OF ONE POINT IS NOT A WALK. When both ends snap to the same vertex
    // — two taps inside one courtyard, a destination picked while standing on
    // it — findPath succeeds and returns a path of a single coordinate with a
    // weight of zero. That was answered as 200 OK, and everything downstream
    // assumed at least two: `lineString()` throws outright on one coordinate,
    // so the browser's route handler died mid-assignment and left the panel
    // saying "Calculating…" for ever; had it survived, `maneuvers.length - 2`
    // would have put "Route calculated — -2 turns." under it.
    //
    // Same shape as the reach check above, and refused for the same reason:
    // the endpoint is public, and a caller that asks for a zero-length walk
    // should be told that is what they asked for rather than handed a
    // degenerate geometry to crash on.
    if (result.path.length < 2) {
      return {
        ok: false,
        reason: 'same-place',
        error: 'Start and destination are the same place — pick a destination further off.',
      };
    }

    return {
      ok: true,
      geometry: { type: 'LineString', coordinates: result.path },
      distanceFeet: Math.round(result.weight * FEET_PER_KM),
      maneuvers: buildManeuvers(result.path),
      snapped: { from: start.coord, to: end.coord },
    };
  }

  return { vertices, snap, route, segmentCount: features.length };
}

export { REACH_M };
