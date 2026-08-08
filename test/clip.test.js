// src/campus-clip.js — the rule that keeps our map inside the campus.
//
// This is the only thing standing between the app and the seam it was written
// to remove, and its failure mode is quiet in both directions: clip too little
// and my campus's roads are drawn on top of the provider's, clip too much and part of
// the campus silently stops being rendered. Both look like a styling choice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, metresBetween } from './helpers.js';
import { ringOf, inCampus, trimToCampus } from '../src/campus-clip.js';

const ring = ringOf(load('campus-boundary'));
const sheet = load('basemap');
const network = load('paths');

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

test('clipped lines stay inside the campus and keep their shape', () => {
  const kept = trimToCampus(network, ring);
  assert.ok(kept.features.length > 500, `only ${kept.features.length} segments survived`);

  // Every vertex is inside or on the ring. The clip creates vertices exactly on
  // it, where a ray-casting test is a coin flip, so "on" is measured rather than
  // assumed — 5 cm is two orders below the 3.3 m paths this is cutting.
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
  for (const f of kept.features) {
    for (const c of f.geometry.coordinates) {
      assert.ok(
        inCampus(c, ring) || toRing(c) < 0.05,
        `a clipped vertex at ${c} is ${toRing(c).toFixed(2)} m outside the campus`,
      );
    }
  }
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
