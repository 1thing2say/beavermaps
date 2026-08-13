// src/geolocation.js and centreOf — the fixture the debug menu stands in for a
// GPS fix, and the point it stands at.
//
// Worth testing for a reason most debug code is not: this object is handed to
// somebody else's control as a `Geolocation`, and a shape that is nearly right
// fails silently. A `watchPosition` that returns nothing, a success callback
// that fires before the id it belongs to has been handed back, a `coords`
// missing a field the interface guarantees — none of those throw. They just
// leave the blue dot off and no explanation anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, metresBetween } from './helpers.js';
import { ringOf, inCampus, centreOf } from '../src/campus-clip.js';
import { createGeolocation } from '../src/geolocation.js';

const ring = ringOf(load('campus-boundary'));

/** The next turn of the event loop, which is where the fixture answers. */
const settled = () => new Promise((resolve) => { setTimeout(resolve, 1); });

test('the middle of the campus is on the campus', () => {
  const centre = centreOf(ring);
  assert.ok(inCampus(centre, ring), `the centroid at ${centre} is outside the boundary`);

  // And it is the middle of the SHAPE, not of the box around it. my campus's boundary
  // is an L, so the two answers differ; if this ever stops being true the
  // centroid has quietly been replaced by a bounding-box midpoint.
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const boxMid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const apart = metresBetween(centre, boxMid);
  assert.ok(apart > 20, `the centroid is ${apart.toFixed(0)} m from the box centre — is it the box?`);

  // Close enough to a walked path to pass as somebody standing on the campus.
  // A fix planted in the middle of a car park roof would still light the GUI up,
  // but nobody looking at it would believe what they were looking at.
  const network = load('paths');
  let nearest = Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') nearest = Math.min(nearest, metresBetween(centre, c));
    else c.forEach(walk);
  };
  network.features.forEach((f) => walk(f.geometry.coordinates));
  assert.ok(nearest < 25, `the centre is ${nearest.toFixed(0)} m from the nearest path`);
});

test('a degenerate ring gets a point back rather than a NaN', () => {
  // Three identical corners have no area and so no centroid. The failure worth
  // guarding is not the exception — it is [NaN, NaN] travelling all the way to
  // setLngLat and blanking the map.
  const [x, y] = centreOf([[1, 2], [1, 2], [1, 2]]);
  assert.equal(x, 1);
  assert.equal(y, 2);
});

test('with no fixture set, every call goes to the real thing', () => {
  const calls = [];
  const real = {
    getCurrentPosition: (...args) => calls.push(['get', args]),
    watchPosition: () => { calls.push(['watch']); return 77; },
    clearWatch: (id) => calls.push(['clear', id]),
  };
  const geo = createGeolocation({ real });

  geo.getCurrentPosition(() => {});
  const id = geo.watchPosition(() => {});
  geo.clearWatch(id);

  assert.equal(calls[0][0], 'get');
  assert.equal(calls[1][0], 'watch');
  // The id handed OUT is ours; the id handed BACK to the browser is the one the
  // browser gave us. Passing the browser's through would work until two watches
  // existed at once, which is exactly when it would stop.
  assert.deepEqual(calls[2], ['clear', 77]);
  assert.notEqual(id, 77);
  assert.equal(geo.fixture, null);
});

test('a watch reports the fixture, asynchronously, in the shape the API promises', async () => {
  const geo = createGeolocation({ real: null });
  const centre = centreOf(ring);
  geo.useFixture(centre);

  const seen = [];
  const id = geo.watchPosition((position) => seen.push(position));

  // The id first. A success callback that fires before watchPosition has
  // returned is a shape no caller is written for, and Mapbox is one of the
  // callers that would store the id after the fix had already arrived.
  assert.equal(typeof id, 'number');
  assert.equal(seen.length, 0, 'the fixture answered synchronously');

  await settled();
  assert.equal(seen.length, 1);

  const { coords, timestamp } = seen[0];
  assert.equal(coords.longitude, centre[0]);
  assert.equal(coords.latitude, centre[1]);
  assert.ok(coords.accuracy > 0);
  assert.ok(typeof timestamp === 'number');
  // Every field the interface guarantees, and null rather than absent. A
  // consumer testing `position.coords.speed !== null` gets a different answer
  // from `undefined` than from `null`, and this exists to not be that.
  for (const key of ['altitude', 'altitudeAccuracy', 'heading', 'speed']) {
    assert.ok(key in coords, `coords has no ${key}`);
    assert.equal(coords[key], null, `coords.${key} should be null`);
  }
});

test('one fix per switch, not a stream', async () => {
  // A stationary phone really does keep reporting, and copying that would be
  // faithful and wrong: the locate control re-runs fitBounds on every fix while
  // it is locked on, so a ticking fixture is a camera that snaps back to a fixed
  // zoom for as long as the panel is open.
  const geo = createGeolocation({ real: null });
  geo.useFixture([-121.347, 38.6495]);

  let count = 0;
  geo.watchPosition(() => { count += 1; });
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(count, 1, `the fixture delivered ${count} fixes while standing still`);
});

test('switching the fixture on and off moves a live watch without breaking it', async () => {
  let realWatchers = 0;
  const real = {
    getCurrentPosition: () => {},
    watchPosition: () => { realWatchers += 1; return realWatchers; },
    clearWatch: () => { realWatchers -= 1; },
  };
  const geo = createGeolocation({ real });

  const seen = [];
  const id = geo.watchPosition((position) => seen.push(position.coords.longitude));
  assert.equal(realWatchers, 1, 'the watch did not start against the real GPS');

  geo.useFixture([-121.347, 38.6495]);
  await settled();
  // The real watch is released and the fixture answers under THE SAME ID. That
  // is the whole reason the switch lives inside this object: the control never
  // learns that anything happened, so its button, its state machine and its
  // marker all carry straight across.
  assert.equal(realWatchers, 0, 'the real watch was left running');
  assert.deepEqual(seen, [-121.347]);
  assert.deepEqual(geo.fixture, [-121.347, 38.6495]);

  geo.useFixture(null);
  assert.equal(realWatchers, 1, 'the watch did not go back to the real GPS');
  assert.equal(geo.fixture, null);

  geo.clearWatch(id);
  assert.equal(realWatchers, 0, 'clearWatch left the real watch running');
});

test('setting the same fixture twice is not a change', async () => {
  const geo = createGeolocation({ real: null });
  geo.useFixture([-121.347, 38.6495]);

  let count = 0;
  geo.watchPosition(() => { count += 1; });
  await settled();

  // Re-applying the identical position must not restart the watch. applyDebug
  // hands the whole state back on every change including ones this flag had no
  // part in, so this runs on every press of every other control in the panel.
  geo.useFixture([-121.347, 38.6495]);
  await settled();
  assert.equal(count, 1, `the fixture re-fired ${count - 1} times for no change`);
});

test('a cleared watch stays quiet', async () => {
  const geo = createGeolocation({ real: null });
  geo.useFixture([-121.347, 38.6495]);

  let count = 0;
  const id = geo.watchPosition(() => { count += 1; });
  geo.clearWatch(id);
  await settled();
  assert.equal(count, 0, 'a watch cleared before its first fix still delivered one');
});
