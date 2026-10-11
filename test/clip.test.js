// src/campus-clip.js — the rule that keeps our map inside the campus.
//
// This is the only thing standing between the app and the seam it was written
// to remove, and its failure mode is quiet in both directions: clip too little
// and my campus's roads are drawn on top of the provider's, clip too much and part of
// the campus silently stops being rendered. Both look like a styling choice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, metresBetween } from './helpers.js';
import {
  ringOf, inCampus, trimToCampus, trimPointsAlong, EXCURSION_M,
} from '../src/campus-clip.js';

const ring = ringOf(load('campus-boundary'));
const sheet = load('basemap');
const network = load('paths');
const lamps = load('lamps');

const everyCoord = (geometry, test_) => {
  const walk = (c) => (typeof c[0] === 'number' ? test_(c) : c.every(walk));
  return walk(geometry.coordinates);
};
const whollyOutside = (g) => everyCoord(g, (c) => !inCampus(c, ring));

test('the sheet loses exactly the elements drawn beyond the campus', () => {
  const kept = trimToCampus(sheet, ring);
  const dropped = new Map();
  for (const f of sheet.features) {
    if (f.geometry.type === 'LineString' || !whollyOutside(f.geometry)) continue;
    dropped.set(f.properties.kind, (dropped.get(f.properties.kind) ?? 0) + 1);
  }

  // Named rather than counted in aggregate, because which classes leave is the
  // claim. `offsite_road` is my campus's own drawing of Auburn Blvd and College Oak
  // Dr, `north_arrow` is a print convention with nothing to point at on a
  // rotatable map, and the trees are the ones along the public verge.
  assert.ok(dropped.get('north_arrow') === 2, 'both north arrows should go');
  assert.ok(dropped.get('tree') > 20, `only ${dropped.get('tree')} verge trees dropped`);
  assert.ok(kept.features.length < sheet.features.length, 'nothing was trimmed at all');

  // Whatever survived has at least one foot on the campus.
  for (const f of kept.features) {
    if (f.geometry.type === 'LineString') continue;
    assert.ok(!whollyOutside(f.geometry), `${f.properties.kind} survived wholly outside`);
  }
});

test('offsite_road is drawn by the basemap, so we stop drawing it entirely', () => {
  const before = sheet.features.filter((f) => f.properties.kind === 'offsite_road');
  const after = trimToCampus(sheet, ring).features
    .filter((f) => f.properties.kind === 'offsite_road');
  assert.ok(before.length > 20, `only ${before.length} offsite_road elements to begin with`);
  assert.equal(after.length, 0, `${after.length} offsite_road elements are still drawn`);
});

/** Metres from a point to the ring. */
const toRing = (p) => {
  let best = Infinity;
  for (let i = 1; i < ring.length; i += 1) {
    const [a, b] = [ring[i - 1], ring[i]];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
    best = Math.min(best, metresBetween(p, [a[0] + t * vx, a[1] + t * vy]));
  }
  return best;
};

const key = (c) => `${c[0]},${c[1]}`;
const endDegrees = (features) => {
  const degree = new Map();
  for (const f of features) {
    const cs = f.geometry.coordinates;
    for (const c of [cs[0], cs[cs.length - 1]]) degree.set(key(c), (degree.get(key(c)) ?? 0) + 1);
  }
  return degree;
};

test('clipped lines stay on the campus, or come back to it', () => {
  const kept = trimToCampus(network, ring);
  assert.ok(kept.features.length > 500, `only ${kept.features.length} segments survived`);

  // Every vertex is inside, on the ring, or on a stretch that strays past it
  // and returns — never further out than EXCURSION_M. The clip creates
  // vertices exactly on the ring, where a ray-casting test is a coin flip, so
  // "on" is measured rather than assumed — 5 cm is two orders below the 3.3 m
  // paths this is cutting.
  for (const f of kept.features) {
    for (const c of f.geometry.coordinates) {
      assert.ok(
        inCampus(c, ring) || toRing(c) <= EXCURSION_M,
        `a clipped vertex at ${c} is ${toRing(c).toFixed(2)} m outside the campus`,
      );
    }
  }

  // ...and the only ends the clip makes are at the fence. A dead end the trim
  // created anywhere else would be a path cut short in the middle of the
  // campus — the 123 m hole in the south-east corner was two of these, left
  // dangling either side of a walkway that had wandered over the line.
  const before = endDegrees(network.features);
  const after = endDegrees(kept.features);
  for (const [k, d] of after) {
    if (d !== 1 || before.get(k) === 1) continue;
    const c = k.split(',').map(Number);
    assert.ok(toRing(c) < 0.05, `the clip left a dead end ${toRing(c).toFixed(2)} m from the fence at ${k}`);
  }

  // The 20 m bound above holds every kept vertex, so on its own it would wave
  // through a spur out to the street — the very thing the clip cuts — as long
  // as it stopped within 20 m, and the dead-end check skips ends that were
  // dead ends before the trim, which a spur's tip is. So: past the fence,
  // nothing kept is an end of anything. Every vertex outside has a way on in
  // both directions, which is what a stretch that comes back is made of; the
  // only ends allowed are the cuts, and those are on the ring.
  const neighbours = new Map();
  for (const f of kept.features) {
    const cs = f.geometry.coordinates;
    for (let i = 1; i < cs.length; i += 1) {
      for (const [p, q] of [[cs[i - 1], cs[i]], [cs[i], cs[i - 1]]]) {
        if (!neighbours.has(key(p))) neighbours.set(key(p), new Set());
        neighbours.get(key(p)).add(key(q));
      }
    }
  }
  for (const [k, next] of neighbours) {
    const c = k.split(',').map(Number);
    if (inCampus(c, ring) || toRing(c) < 0.05) continue;
    assert.ok(next.size >= 2, `a kept line ends ${toRing(c).toFixed(2)} m past the fence at ${k}`);
  }
});

// A small square campus and the four things a line can do at its edge, so the
// rule is pinned down on its own and not only on whatever the network is
// this week. The east edge is lon E; DX is a metre of longitude there.
const W = -121.35, E = -121.34, S = 38.645, N = 38.653;
const square = [[W, S], [E, S], [E, N], [W, N], [W, S]];
const DX = 1 / 86_940;
const line = (props, ...coordinates) => ({
  type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates },
});
const lengthOf = (features) => features.reduce((sum, f) => {
  const cs = f.geometry.coordinates;
  return sum + cs.slice(1).reduce((s, c, i) => s + metresBetween(cs[i], c), 0);
}, 0);

test('a path that strays over the fence and comes back is drawn whole', () => {
  // Three edges, the middle one entirely outside: no single edge can tell it
  // comes home, which is why the rule works on the network and not per line.
  const a = [E - 30 * DX, 38.647], b = [E + 10 * DX, 38.6475], c = [E + 10 * DX, 38.6485];
  const d = [E - 30 * DX, 38.649];
  const stray = [line({ e: 1 }, a, b), line({ e: 2 }, b, c), line({ e: 3 }, c, d)];
  const kept = trimToCampus({ type: 'FeatureCollection', features: stray }, square).features;
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((f) => f.geometry.coordinates), stray.map((f) => f.geometry.coordinates));
  assert.deepEqual(kept.map((f) => f.properties), stray.map((f) => f.properties));

  // One sheet stroke doing the same thing in a single LineString stays one line.
  const stroke = line({ kind: 'walkway' }, a, b, c, d);
  const one = trimToCampus({ type: 'FeatureCollection', features: [stroke] }, square).features;
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].geometry.coordinates, [a, b, c, d]);
});

test('a path that runs out to the street is still cut at the fence', () => {
  const inside = [E - 30 * DX, 38.647];
  // Out and not back: the driveway to the public road.
  const spur = line({}, inside, [E + 8 * DX, 38.647]);
  // Out and back, but 40 m out — further than any campus path strays, so it is
  // treated as using the street and cut at both crossings.
  const deep = [
    line({}, inside, [E + 40 * DX, 38.6475]),
    line({}, [E + 40 * DX, 38.6475], [E - 30 * DX, 38.648]),
  ];
  for (const features of [[spur], deep]) {
    const kept = trimToCampus({ type: 'FeatureCollection', features }, square).features;
    for (const f of kept) {
      for (const c of f.geometry.coordinates) {
        assert.ok(c[0] <= E + 1e-9, `${c} is past the fence`);
      }
    }
    assert.ok(lengthOf(kept) > 0, 'the inside part went too');
  }

  // A loop just past the fence with a spur off it: the loop is a way back in
  // and stays, the spur is a road out and goes.
  const o1 = [E + 6 * DX, 38.6475];
  const tail = line({ tail: true }, o1, [E + 15 * DX, 38.6475]);
  const loop = [line({}, inside, o1), line({}, o1, [E - 30 * DX, 38.648]), tail];
  const kept = trimToCampus({ type: 'FeatureCollection', features: loop }, square).features;
  assert.equal(kept.filter((f) => f.properties.tail).length, 0, 'the spur off the loop survived');
  assert.equal(lengthOf(kept), lengthOf(loop.slice(0, 2)));
});

test('two lines that meet just past the fence are not a way back in', () => {
  // The College Oak Dr gate: a walkway and a hand link cross the fence a
  // few decimetres apart and meet 3 m outside, where the drawn line carries on
  // out to the street. With the street end pruned, what is left touches the
  // ring twice and is 3 m deep — out and back by count — and it was kept: the
  // ribbon ran 3 m onto the provider's sidewalk and a lamp glowed at its tip.
  // It goes out further than it runs along, which no real stray does.
  const meet = [E + 3 * DX, 38.649];
  const gate = [
    line({ arm: 1 }, [E - 20 * DX, 38.6489], meet),
    line({ arm: 2 }, [E - 20 * DX, 38.6491], meet),
    line({ tail: true }, meet, [E + 12 * DX, 38.649]),
  ];
  const kept = trimToCampus({ type: 'FeatureCollection', features: gate }, square).features;
  for (const f of kept) {
    for (const c of f.geometry.coordinates) assert.ok(c[0] <= E + 1e-9, `${c} is past the fence`);
  }
  assert.equal(kept.filter((f) => f.properties.arm).length, 2, 'the arms went too, not just their tips');

  // ...and the lamp at the meeting point goes with them.
  const lamp = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: meet } };
  const shown = trimPointsAlong({ type: 'FeatureCollection', features: [lamp] }, { type: 'FeatureCollection', features: kept }, square);
  assert.equal(shown.features.length, 0, 'a lamp still glows past the fence');
});

test('a crossing is kept or dropped whole, never sliced', () => {
  // Two painted crossings straddling the east fence, one mostly on the campus
  // and one mostly on the street.
  const onCampus = line({ kind: 'crossing' }, [E - 8 * DX, 38.648], [E + 3 * DX, 38.648]);
  const onStreet = line({ kind: 'crossing' }, [E - 3 * DX, 38.649], [E + 8 * DX, 38.649]);
  const kept = trimToCampus({ type: 'FeatureCollection', features: [onCampus, onStreet] }, square);
  assert.deepEqual(kept.features, [onCampus]);

  // On the real sheet: no crossing comes out as a sliver.
  const crossings = trimToCampus(sheet, ring).features
    .filter((f) => f.properties.kind === 'crossing' && f.geometry.type === 'LineString');
  for (const f of crossings) {
    const original = sheet.features.find((g) => g.properties.i === f.properties.i);
    assert.deepEqual(f.geometry, original.geometry, `crossing ${f.properties.i} was cut`);
  }
});

test('the lamps that are drawn stand on the drawn network or the campus', () => {
  const drawn = trimToCampus(network, ring);
  const shown = trimPointsAlong(lamps, drawn, ring).features;
  const segments = drawn.features.flatMap((f) => {
    const cs = f.geometry.coordinates;
    return cs.slice(1).map((c, i) => [cs[i], c]);
  });
  const toNetwork = (p) => Math.min(...segments.map(([a, b]) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
    return metresBetween(p, [a[0] + t * vx, a[1] + t * vy]);
  }));
  for (const f of shown) {
    const c = f.geometry.coordinates;
    assert.ok(inCampus(c, ring) || toNetwork(c) <= 1, `a lamp glows ${toRing(c).toFixed(1)} m past the fence with no path under it`);
  }
  // Every lamp inside the fence is drawn; the trim only ever takes from outside.
  const inside = lamps.features.filter((f) => inCampus(f.geometry.coordinates, ring));
  assert.ok(shown.length >= inside.length);

  // A lamp on a stub that the trim cut away goes with it.
  const outside = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [E + 5 * DX, 38.647] } };
  const spur = line({}, [E - 30 * DX, 38.647], [E + 8 * DX, 38.647]);
  const cut = trimToCampus({ type: 'FeatureCollection', features: [spur] }, square);
  assert.equal(trimPointsAlong({ type: 'FeatureCollection', features: [outside] }, cut, square).features.length, 0);
});

test('clipping shortens the network without hollowing it out', () => {
  const length = (features) => features.reduce((sum, f) => {
    const cs = f.geometry.coordinates;
    return sum + cs.slice(1).reduce((s, c, i) => s + metresBetween(cs[i], c), 0);
  }, 0);

  const before = length(network.features);
  const after = length(trimToCampus(network, ring).features);
  assert.ok(after < before, 'the clip removed nothing — is the boundary right?');
  // my campus's linework is drawn for my campus's campus; only the driveways running out to
  // the public road cross the line, so this is a trim and not a haircut. A big
  // loss here means the ring has moved or its winding has flipped, either of
  // which would leave most of the campus unrendered.
  const lost = (before - after) / before;
  assert.ok(lost < 0.02, `the clip removed ${(lost * 100).toFixed(1)}% of the network`);
  assert.ok(lost > 0.0001, 'the clip removed less than a metre — it is not running');
});
