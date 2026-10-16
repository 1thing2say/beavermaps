// src/navigation.js — the first test this code has ever had.
//
// Thirteen functions and ten variables that used to live in the middle of
// startApp(), where nothing could reach them. The camera aim, the step counter
// and the banner's swap were all correct by inspection and by nobody having
// complained, which is the same evidence the Paris bug had.
//
// The collaborators are all fakes. That is the point of the factory: navigation
// needs a camera it can ease, a dot it can move and a route it can read, and
// none of those has to be Mapbox's.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNavigation,
  LOOK_AHEAD_KM,
  MANEUVER_PASSED_KM,
  JUMP_FIXES,
  OFF_ROUTE_M,
  OFF_ROUTE_FIXES,
  GIVE_BACK_M,
  GIVE_BACK_FIXES,
  BANNER_SWAP_MS,
} from '../src/navigation.js';
import { instructionFor } from '../src/maneuvers.js';
import { REACH_M } from '../src/directions.js';
import { createRoute } from '../src/route-state.js';
import { buildManeuvers, FEET_PER_KM } from '../src/maneuvers.js';
import { walkLabel, walkSeconds } from '../src/directions.js';
import { element, withDocument } from './fake-dom.js';
import { point } from '@turf/helpers';
import { along } from '@turf/along';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';

/** A walk with three corners, long enough that the aim clamp has work to do. */
const WALK = {
  geometry: {
    type: 'LineString',
    coordinates: [
      [-121.3465, 38.6486],
      [-121.3455, 38.6486],
      [-121.3455, 38.6496],
      [-121.3440, 38.6496],
    ],
  },
  maneuvers: [
    { index: 0, type: 'depart' },
    { index: 1, type: 'right' },
    { index: 2, type: 'left' },
    { index: 3, type: 'arrive' },
  ],
};

/** A sign, shaped the way nav-sign-template is shaped in index.html. */
function signTemplate() {
  const sign = element('nav-sign');
  sign.appendChild(element('nav-arrow'));
  sign.appendChild(element('nav-distance'));
  sign.appendChild(element('nav-instruction'));
  sign.appendChild(element('nav-exit'));
  return { content: { firstElementChild: sign } };
}

/** Everything createNavigation asks for, with every call recorded. */
function harness({ fixture = null, route = createRoute() } = {}) {
  const log = [];
  const dom = {
    sidePanel: element(),
    banner: element('hidden'),
    footer: element('hidden'),
    stack: element(),
    signTemplate: signTemplate(),
    remaining: element(),
    eta: element(),
  };
  const dot = {
    at: null,
    added: false,
    setLngLat(c) { dot.at = c; return dot; },
    addTo() { dot.added = true; return dot; },
    remove() { dot.added = false; },
  };
  const geolocation = {
    fixture,
    fixes: [],
    useFixture(at, opts) { geolocation.fixes.push({ at, ...opts }); },
  };
  const map = {
    eases: [],
    resizes: 0,
    easeTo(opts) { map.eases.push(opts); },
    resize() { map.resizes++; },
  };
  const nav = createNavigation({
    map,
    route,
    geolocation,
    dom,
    buildings: { add: () => log.push('buildings.add'), remove: () => log.push('buildings.remove') },
    onStart: () => log.push('onStart'),
    restCamera: () => log.push('restCamera'),
    releaseCameraLock: () => log.push('releaseCameraLock'),
    makeUserDot: () => { log.push('makeUserDot'); return dot; },
  });
  return { nav, route, map, dom, dot, geolocation, log };
}

const walking = (extra) => {
  const route = createRoute();
  route.set(WALK);
  return harness({ route, ...extra });
};

/**
 * Walk from wherever the last fix left you to `target`, a fix every 10 m.
 *
 * These tests used to hand `moved` the destination straight after `start`, and
 * a single fix three hundred metres up the route is exactly what navigation no
 * longer believes on its own — see `track` in src/navigation.js and the
 * U-shaped walks at the bottom of this file. A walker gets there one stride at
 * a time, so that is how the tests get there too.
 */
function walkTo(h, target, { accuracy } = {}) {
  const toKm = nearestPointOnLine(h.route.line, point(target)).properties.location;
  for (let km = h.walkedKm ?? 0; km < toKm; km += 0.01) {
    h.nav.moved(along(h.route.line, km).geometry.coordinates, { accuracy });
  }
  h.nav.moved(target, { accuracy });
  h.walkedKm = toKm;
}

test('a walk cannot start without a route', () => {
  withDocument(() => {
    const h = harness();                       // route never set
    h.nav.start();
    assert.equal(h.nav.isActive(), false);
    assert.deepEqual(h.log, [], 'it touched the map with nothing to walk');
    assert.ok(h.dom.banner.classList.contains('hidden'));
  });
});

test('a one-coordinate route is not walkable', () => {
  withDocument(() => {
    const route = createRoute();
    route.set({
      geometry: { type: 'LineString', coordinates: [[-121.3465, 38.6486]] },
      maneuvers: [{ index: 0, type: 'arrive' }],
    });
    const h = harness({ route });
    h.nav.start();
    assert.equal(h.nav.isActive(), false);
  });
});

test('starting puts the chrome away, stands the buildings up and takes the camera', () => {
  withDocument((body) => {
    const h = walking();
    h.nav.start();

    assert.equal(h.nav.isActive(), true);
    assert.ok(h.log.includes('buildings.add'));
    assert.ok(h.log.includes('onStart'), 'the legend and the lifted pin were left up');
    assert.ok(h.log.includes('releaseCameraLock'));
    assert.ok(body.classList.contains('navigating'));
    assert.ok(h.dom.sidePanel.classList.contains('hidden'));
    assert.ok(!h.dom.banner.classList.contains('hidden'));
    assert.ok(!h.dom.footer.classList.contains('hidden'));
  });
});

test('ending puts all of it back', () => {
  withDocument((body) => {
    const h = walking();
    h.nav.start();
    h.nav.end();

    assert.equal(h.nav.isActive(), false);
    assert.ok(h.log.includes('buildings.remove'), 'the extrusions were left standing');
    assert.ok(h.log.includes('restCamera'));
    assert.ok(!body.classList.contains('navigating'));
    assert.ok(!h.dom.sidePanel.classList.contains('hidden'));
    assert.ok(h.dom.banner.classList.contains('hidden'));
    assert.equal(h.dot.added, false);
  });
});

test('ending a walk that never started does not move the camera', () => {
  withDocument(() => {
    const h = walking();
    h.nav.end();
    assert.ok(!h.log.includes('restCamera'));
  });
});

test('the dot is made once and moved after that', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    assert.equal(h.log.filter((x) => x === 'makeUserDot').length, 1);
    assert.deepEqual(h.dot.at, WALK.geometry.coordinates[0]);
    assert.equal(h.dot.added, true);

    h.nav.end();
    h.nav.start();
    assert.equal(h.log.filter((x) => x === 'makeUserDot').length, 1, 'a second dot was built');
  });
});

test('with the virtual location on there is one dot, not two', () => {
  // The control's own blue dot IS the position when the fixture is driving it.
  withDocument(() => {
    const h = walking({ fixture: [-121.3465, 38.6486] });
    h.nav.start();
    assert.ok(!h.log.includes('makeUserDot'));
  });
});

test('a position is ignored until the walk is running', () => {
  withDocument(() => {
    const h = walking();
    h.nav.moved([-121.3460, 38.6486]);
    assert.equal(h.map.eases.length, 0);
  });
});

test('walking retires the maneuvers it has passed', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    // NOT zero. `depart` sits at distance zero, so it is already behind you the
    // moment you start and the banner points at the first real corner. Getting
    // this wrong the other way would show "depart" on the sign for the whole
    // first leg.
    assert.equal(h.nav.stepIndex(), 1);

    // Past the first corner, which is at the second vertex.
    walkTo(h, [-121.3455, 38.6490]);
    assert.ok(h.nav.stepIndex() >= 2, 'the banner is still pointing at a corner behind us');

    // All the way to the end.
    walkTo(h, WALK.geometry.coordinates[3]);
    assert.equal(h.nav.stepIndex(), WALK.maneuvers.length - 1);
  });
});

test('the step counter never runs off the end of the maneuvers', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    for (let i = 0; i < 20; i++) h.nav.moved(WALK.geometry.coordinates[3]);
    assert.equal(h.nav.stepIndex(), WALK.maneuvers.length - 1);
  });
});

test('the camera never aims past the corner it is walking toward', () => {
  // The one piece of arithmetic in here that is easy to get wrong and invisible
  // when it is: aiming beyond a maneuver starts swinging the camera while you
  // are still travelling straight at it.
  withDocument(() => {
    const h = walking();
    h.nav.start();

    for (let along = 0; along < h.route.totalKm; along += h.route.totalKm / 40) {
      const aim = h.nav.aimKm(along);
      assert.ok(aim <= h.route.maneuverKm(h.nav.stepIndex()) + 1e-12,
        `aimed past the next corner at ${along} km`);
      assert.ok(aim <= h.route.totalKm + 1e-12, 'aimed past the end of the walk');
      assert.ok(aim <= along + LOOK_AHEAD_KM + 1e-12, 'looked further than LOOK_AHEAD_KM');
    }
  });
});

test('on a long straight the aim is the full look-ahead', () => {
  // Otherwise the clamp is doing all the work and the constant is decoration.
  withDocument(() => {
    const h = walking();
    h.nav.start();
    walkTo(h, WALK.geometry.coordinates[2]);     // onto the last, longest leg
    // A second fix at the corner. The sign turns over only once two fixes in
    // a row want it to (see `advanceSteps`), and walked at a fix every 10 m
    // the corner fix is the first of them to be within a stride of it.
    h.nav.moved(WALK.geometry.coordinates[2]);
    const aim = h.nav.aimKm(h.route.maneuverKm(2));
    assert.ok(aim > h.route.maneuverKm(2), 'the aim collapsed onto our own position');
  });
});

test('MANEUVER_PASSED_KM is a stride, not a block', () => {
  // About 3 m. It was 25 ft, and a step retired 25 ft before its corner was
  // a step 15% of walks never saw.
  assert.ok(MANEUVER_PASSED_KM > 0);
  assert.ok(MANEUVER_PASSED_KM * FEET_PER_KM <= 12, `${MANEUVER_PASSED_KM} km is not a stride`);
});

test('the first sign arrives without a swap, and the second swaps', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();                                   // renders step 0

    assert.equal(h.dom.stack.children.length, 1);
    assert.ok(h.dom.stack.children[0].classList.contains('nav-sign--first'));
    assert.equal(h.dom.stack.querySelectorAll('.nav-sign--out').length, 0);

    walkTo(h, [-121.3455, 38.6490]);                 // past the first corner
    assert.equal(h.dom.stack.children.length, 2, 'the finished sign was not kept for the swap');
    assert.equal(h.dom.stack.querySelectorAll('.nav-sign--out').length, 1);
    assert.equal(h.dom.stack.querySelectorAll('.nav-sign--in').length, 1);
  });
});

test('the banner is emptied between walks', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    h.nav.moved([-121.3455, 38.6490]);
    assert.ok(h.dom.stack.children.length > 0);

    h.nav.end();
    assert.equal(h.dom.stack.children.length, 0, 'signs from the last walk survived');
  });
});

test('arriving says so, and says it on the sign as well as the footer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const h = walking();
    h.nav.start();
    walkTo(h, WALK.geometry.coordinates[3]);
    // Walked rather than teleported, the last corner's sign is still sliding
    // in when the door is reached, and a sign mid-swap keeps its countdown
    // still. Let it land; the next fix at the door is the one that says so.
    t.mock.timers.tick(BANNER_SWAP_MS);
    h.nav.moved(WALK.geometry.coordinates[3]);

    const sign = h.dom.stack.children.at(-1);
    assert.equal(sign.querySelector('.nav-distance').textContent, 'Arrived');
    assert.match(sign.querySelector('.nav-instruction').textContent, /reached your destination/i);
    assert.equal(h.dom.remaining.textContent, '0 ft');
  });
});

test('the ETA is words, not a bare zero', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    assert.match(h.dom.eta.textContent, /min/);
  });
});

test('the End button on any sign ends the walk', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    h.dom.stack.children[0].querySelector('.nav-exit').fire('click');
    assert.equal(h.nav.isActive(), false);
  });
});

test('the simulator walks the fixture when there is one', async () => {
  await withDocument(async () => {
    const h = walking({ fixture: [-121.3465, 38.6486] });
    try {
      h.nav.start({ simulate: true });
      assert.equal(h.nav.isSimulating(), true);

      await new Promise((done) => setTimeout(done, 700));
      assert.ok(h.geolocation.fixes.length >= 2, 'the fixture never moved');
      // It moves along the route rather than jumping about.
      const [first, second] = h.geolocation.fixes;
      assert.notDeepEqual(first.at, second.at);
    } finally {
      h.nav.end();       // or the interval outlives the test and holds the runner open
    }
    assert.equal(h.nav.isSimulating(), false);
  });
});

test('without a fixture the simulator drives the dot directly', async () => {
  await withDocument(async () => {
    const h = walking();
    try {
      h.nav.start({ simulate: true });
      const startedAt = h.dot.at;

      await new Promise((done) => setTimeout(done, 700));
      assert.notDeepEqual(h.dot.at, startedAt, 'the dot stayed at the start');
    } finally {
      h.nav.end();
    }
  });
});

test('a simulated walk is published so the sign can tell', async () => {
  await withDocument(async (body) => {
    const h = walking();
    h.nav.start({ simulate: true });
    assert.ok(body.classList.contains('simulating'));
    h.nav.end();
    assert.ok(!body.classList.contains('simulating'));
  });
});

test('arriving stops the simulator', () => {
  // Driven rather than waited out. At 4x a 300 m walk still takes the best part
  // of a minute in real time, and a test that sleeps through it is a test
  // nobody runs. Arrival is decided in renderBanner, which is what `moved`
  // calls, so pushing the positions up to the last asks exactly the same
  // question — synchronously, so the interval never gets a tick in.
  withDocument(() => {
    const h = walking();
    try {
      h.nav.start({ simulate: true });
      assert.equal(h.nav.isSimulating(), true);

      walkTo(h, WALK.geometry.coordinates[3]);
      assert.equal(h.nav.isSimulating(), false, 'the interval survived arrival');
    } finally {
      h.nav.end();
    }
  });
});

test('ending a walk always stops the simulator', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start({ simulate: true });
    h.nav.end();
    assert.equal(h.nav.isSimulating(), false);
  });
});

// ---------------------------------------------------------------------------
// GPS noise — the walk that doubles back
// ---------------------------------------------------------------------------

/**
 * Out along one side of a quad and back along the other, 20 m apart, so the
 * door is 20 m north of where you set off. About 120 m a leg, 265 m in all.
 *
 * This is the shape that broke progress: a fix by the start that has drifted
 * a dozen metres north is nearer the RETURN leg than the outbound one, and the
 * nearest point on the whole line is then most of the way to the door.
 */
const U_LAT_GAP = 0.00018;                     // ~20 m of latitude
const U_WALK = {
  geometry: {
    type: 'LineString',
    coordinates: [
      [-121.3465, 38.6486],
      [-121.3451, 38.6486],
      [-121.3451, 38.6486 + U_LAT_GAP],
      [-121.3465, 38.6486 + U_LAT_GAP],
    ],
  },
  maneuvers: [
    { index: 0, type: 'depart' },
    { index: 1, type: 'left' },
    { index: 2, type: 'left' },
    { index: 3, type: 'arrive' },
  ],
};

const walkingTheU = () => {
  const route = createRoute();
  route.set(U_WALK);
  return harness({ route });
};

/** `at`, moved `metres` north. A metre of latitude is about 1/111 000 of a degree. */
const north = ([lon, lat], metres) => [lon, lat + metres / 111_000];

// 12 m north is inside SNAP_FIT_M, so the window places it; 16 m is outside
// it, and the poor fit makes the door a candidate leap — one that three
// agreeing fixes used to carry out, from a phone that had not moved.
for (const [metres, accuracy] of [[12, 10], [16, 15], [16, 10]]) {
  test(`a fix by the start ${metres} m toward the return leg (accuracy ${accuracy}) does not skip the walk`, () => {
    withDocument(() => {
      const h = walkingTheU();
      h.nav.start();
      const drifted = north(U_WALK.geometry.coordinates[0], metres);

      // The precondition, so this test cannot pass for the wrong reason: the
      // nearest point on the whole line really is near the far end.
      const naive = nearestPointOnLine(h.route.line, point(drifted)).properties.location;
      assert.ok(naive > h.route.totalKm * 0.9, `the fixture is not ambiguous (${naive} km)`);

      // A phone held still at the start, every fix pulled the same way.
      for (let i = 0; i < 10; i++) h.nav.moved(drifted, { accuracy });

      assert.equal(h.nav.stepIndex(), 1, 'corners were retired from the start line');
      const sign = h.dom.stack.children.at(-1);
      assert.notEqual(sign.querySelector('.nav-distance').textContent, 'Arrived');
      assert.notEqual(h.dom.remaining.textContent, '0 ft');
    });
  });
}

test('a noisy walk round the U still arrives, one corner at a time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    const seen = [h.nav.stepIndex()];
    let side = 1;
    for (let km = 0; km < h.route.totalKm; km += 0.008) {
      const on = along(h.route.line, km).geometry.coordinates;
      h.nav.moved(north(on, 8 * side), { accuracy: 12 });   // 8 m either side, alternating
      side = -side;
      seen.push(h.nav.stepIndex());
    }
    t.mock.timers.tick(BANNER_SWAP_MS);           // the last sign lands; see 'arriving says so'
    h.nav.moved(U_WALK.geometry.coordinates[3], { accuracy: 12 });
    seen.push(h.nav.stepIndex());

    assert.equal(h.nav.stepIndex(), U_WALK.maneuvers.length - 1);
    // Every corner came up on the way, rather than being jumped over.
    for (let i = 1; i < U_WALK.maneuvers.length; i++) {
      assert.ok(seen.includes(i), `step ${i} never came up`);
    }
    assert.equal(h.dom.stack.children.at(-1).querySelector('.nav-distance').textContent, 'Arrived');
  });
});

test('a fix too vague to place you moves nothing', () => {
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    const eases = h.map.eases.length;
    for (let i = 0; i < 5; i++) h.nav.moved(U_WALK.geometry.coordinates[3], { accuracy: 50 });
    assert.equal(h.nav.stepIndex(), 1);
    assert.equal(h.map.eases.length, eases, 'the camera followed a 50 m fix');
  });
});

test('a real leap up the route is believed once enough fixes agree, and not before', () => {
  // The radio lost under a roof, found again round the second corner.
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    const corner = U_WALK.geometry.coordinates[2];

    // One stray fix, then one back where we were: the run starts over.
    h.nav.moved(corner, { accuracy: 5 });
    h.nav.moved(U_WALK.geometry.coordinates[0], { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 1);

    for (let i = 1; i < JUMP_FIXES; i++) {
      h.nav.moved(corner, { accuracy: 5 });
      assert.equal(h.nav.stepIndex(), 1, `believed after ${i} fix(es)`);
    }
    h.nav.moved(corner, { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), U_WALK.maneuvers.length - 1,
      'the walker is round the second corner and the sign never caught up');
  });
});

test('walking away from the route says so, and coming back puts the sign back', () => {
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    // A fix at the start first: the walker has been on the route. Without one,
    // fixes 60 m off are someone still walking to it from where the route was
    // asked for — see the off-network starts further down.
    h.nav.moved(U_WALK.geometry.coordinates[0], { accuracy: 8 });
    const away = north(U_WALK.geometry.coordinates[0], -60);   // 60 m south, off the line
    const sign = () => h.dom.stack.children.at(-1);

    for (let i = 1; i < OFF_ROUTE_FIXES; i++) {
      h.nav.moved(away, { accuracy: 8 });
      assert.equal(h.nav.isOffRoute(), false, `off route after ${i} fix(es)`);
    }
    h.nav.moved(away, { accuracy: 8 });
    assert.equal(h.nav.isOffRoute(), true);
    assert.match(sign().querySelector('.nav-instruction').textContent, /back to the route/i);
    assert.equal(h.nav.stepIndex(), 1, 'a fix off the route moved you along it');
    assert.deepEqual(h.map.eases.at(-1).center, away, 'the camera stayed on the line');

    h.nav.moved(U_WALK.geometry.coordinates[0], { accuracy: 8 });
    assert.equal(h.nav.isOffRoute(), false);
    assert.equal(sign().querySelector('.nav-instruction').textContent, instructionFor('left'));
  });
});

// ---------------------------------------------------------------------------
// GPS noise — what one fix may and may not do to the sign
// ---------------------------------------------------------------------------

/** The point `km` along the route `h` is walking. */
const at = (h, km) => along(h.route.line, km).geometry.coordinates;

/** The sign that owns the countdown: the newest one, mid-swap or not. */
const liveSign = (h) => {
  const el = h.dom.stack.children.at(-1);
  return {
    arrow: el.querySelector('.nav-arrow').innerHTML,
    distance: el.querySelector('.nav-distance').textContent,
    instruction: el.querySelector('.nav-instruction').textContent,
  };
};

/** How far along the route the camera was last put, in km — where navigation believes you are. */
const believedKm = (h) =>
  nearestPointOnLine(h.route.line, point(h.map.eases.at(-1).center)).properties.location;

/** Accurate fixes every `stepKm` from `fromKm` up to `toKm`, both ends included. */
function strideAlong(h, fromKm, toKm, { stepKm = 0.01, accuracy = 5 } = {}) {
  for (let km = fromKm; km < toKm; km += stepKm) h.nav.moved(at(h, km), { accuracy });
  h.nav.moved(at(h, toKm), { accuracy });
}

test('one fix drifted toward the return leg at the bottom of the U skips no corner', () => {
  // The reviewer's case. Walked accurately to 105 m, the first corner 17 m
  // ahead, then one fix 11 m north with accuracy 10: 11 m from the path you are
  // on and 9 m from the way home. The first windowed version snapped it onto
  // the way home, took both corners and read "Arrive at destination", and
  // accurate fixes afterwards never gave the corners back.
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    strideAlong(h, 0, 0.105);
    assert.equal(h.nav.stepIndex(), 1);

    const drifted = north(at(h, 0.105), 11);
    // The precondition: the whole line's nearest point really is the way home.
    const naive = nearestPointOnLine(h.route.line, point(drifted)).properties.location;
    assert.ok(naive > h.route.maneuverKm(2), `the fix is not ambiguous (${naive} km)`);

    h.nav.moved(drifted, { accuracy: 10 });
    assert.equal(h.nav.stepIndex(), 1, 'one drifted fix retired a corner');
    assert.equal(liveSign(h).instruction, instructionFor('left'));
    assert.notEqual(liveSign(h).instruction, instructionFor('arrive'));

    // And the accurate fixes after it carry on from the outbound leg.
    strideAlong(h, 0.106, 0.11);
    assert.equal(h.nav.stepIndex(), 1);
    assert.ok(Math.abs(believedKm(h) - 0.11) < 0.002, `believed at ${believedKm(h)} km, not 0.11`);
  });
});

test('a corner retired too early comes back once fixes put you well short of it', () => {
  // Two fixes in a row at the corner while the walker is really 30 m short of
  // it — enough, by design, to turn the sign over. The next accurate fixes
  // have to be able to turn it back, or the mistake is as permanent as it was
  // when the sign only ever counted up.
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const corner = h.route.maneuverKm(1);
    strideAlong(h, 0, corner - 0.03);

    for (const km of [corner - 0.015, corner - 0.002, corner - 0.002]) h.nav.moved(at(h, km), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 2, 'the precondition: the corner was retired');
    assert.equal(liveSign(h).instruction, instructionFor('left'));

    // Short of where it was retired, but by less than GIVE_BACK_M: a walker
    // standing at a corner in noise does not see it come and go.
    const retiredAt = corner - MANEUVER_PASSED_KM;
    for (let i = 0; i < 3; i++) h.nav.moved(at(h, retiredAt - GIVE_BACK_M / 2000), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 2, 'given back inside the slack');

    // GIVE_BACK_M short of it and more, GIVE_BACK_FIXES times running: the
    // corner is yours again.
    const back = retiredAt - GIVE_BACK_M / 1000 - 0.002;
    for (let i = 1; i < GIVE_BACK_FIXES; i++) {
      h.nav.moved(at(h, back), { accuracy: 5 });
      assert.equal(h.nav.stepIndex(), 2, `given back after ${i} fix(es)`);
    }
    h.nav.moved(at(h, back), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 1, 'the corner never came back');
    assert.equal(liveSign(h).instruction, instructionFor('right'));
  });
});

test('a single stray fix never changes the sign', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const corner = h.route.maneuverKm(1);
    strideAlong(h, 0, corner - 0.012);
    const before = liveSign(h);
    const signs = h.dom.stack.children.length;

    const strays = [
      at(h, corner - 0.002),                       // inside the window, a stride from the corner
      at(h, h.route.totalKm - 0.01),               // on the line, nearly at the door
      north(at(h, corner - 0.012), -60),           // nowhere near the line
      north(at(h, corner - 0.012), 14),            // beside you, on the second leg's side
    ];
    for (const stray of strays) {
      h.nav.moved(stray, { accuracy: 8 });
      h.nav.moved(at(h, corner - 0.012), { accuracy: 5 });   // and straight back
      assert.equal(h.nav.stepIndex(), 1, `${stray} moved the step`);
      assert.equal(liveSign(h).instruction, before.instruction, `${stray} rewrote the sign`);
      assert.equal(liveSign(h).arrow, before.arrow);
      assert.equal(h.dom.stack.children.length, signs, `${stray} started a swap`);
    }
  });
});

for (const stride of [25, 30]) {
  test(`fixes ${stride} m apart still carry you up the route, every one of them`, () => {
    // A brisk walk with a phone that reports every few seconds, or a jog. The
    // window ahead is short on purpose (see SNAP_AHEAD_M), and a fix beyond it
    // must not have to wait for JUMP_FIXES others to agree before it counts:
    // that is two fixes in every three standing still. It is followed up the
    // line to where it fits. Round a corner from the window's end it may fit
    // the end better than anywhere further on, and is held there, so it can
    // lag — by less than the stride, and the next fix catches up.
    withDocument(() => {
      const h = walking();
      h.nav.start();
      let last = 0;
      for (let km = stride / 1000; km < h.route.totalKm; km += stride / 1000) {
        h.nav.moved(at(h, km), { accuracy: 5 });
        const now = believedKm(h);
        assert.ok(now > last, `stalled at ${last} km with a fix at ${km} km`);
        assert.ok(km - now < stride / 1000, `believed at ${now} km, walking at ${km} km`);
        last = now;
      }
      h.nav.moved(at(h, h.route.totalKm), { accuracy: 5 });
      assert.equal(h.nav.stepIndex(), WALK.maneuvers.length - 1);
    });
  });
}

test('a real leap far up the route is believed on the third agreeing fix', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    strideAlong(h, 0, 0.03);
    const far = h.route.maneuverKm(2) + 0.02;     // past the last corner, 200 m on
    for (let i = 0; i < JUMP_FIXES - 1; i++) {
      h.nav.moved(at(h, far + i * 0.005), { accuracy: 5 });
      assert.equal(h.nav.stepIndex(), 1, `believed after ${i + 1} fix(es)`);
      assert.ok(believedKm(h) < 0.05, 'the camera went with an unagreed fix');
    }
    h.nav.moved(at(h, far + (JUMP_FIXES - 1) * 0.005), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), WALK.maneuvers.length - 1);
    assert.ok(Math.abs(believedKm(h) - (far + (JUMP_FIXES - 1) * 0.005)) < 0.002);
    assert.equal(liveSign(h).instruction, instructionFor('arrive'));
  });
});

test('starting as far off the network as a route may start is not being off the route', () => {
  // The server routes from anywhere within REACH_M of the network, and the
  // line it sends back starts where the walk joins the network, not where you
  // are standing. Every fix on the way to it is further than OFF_ROUTE_M from
  // the line, and none of them is a walker who has left the route.
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const start = WALK.geometry.coordinates[0];
    const before = liveSign(h);

    // Down to OFF_ROUTE_M out; nearer than that the fix is on the line's
    // doorstep and is placed on it like any other.
    for (let m = REACH_M; m > OFF_ROUTE_M; m -= 20) {
      const fix = north(start, -m);                 // due south, straight at the start
      h.nav.moved(fix, { accuracy: 10 });
      assert.equal(h.nav.isOffRoute(), false, `off route ${m} m out`);
      assert.doesNotMatch(liveSign(h).instruction, /back to the route/i, `warned ${m} m out`);
      assert.equal(liveSign(h).instruction, before.instruction);
      assert.equal(h.nav.stepIndex(), 1);
      assert.deepEqual(h.map.eases.at(-1).center, fix, 'the camera stayed at the start of the line');
    }

    // On the line now, and it is an ordinary walk.
    strideAlong(h, 0, h.route.maneuverKm(1) + 0.01);
    assert.equal(h.nav.stepIndex(), 2);
    assert.equal(liveSign(h).instruction, instructionFor('left'));
  });
});

test('walking away before reaching the route still says so', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const start = WALK.geometry.coordinates[0];
    h.nav.moved(north(start, -150), { accuracy: 10 });
    h.nav.moved(north(start, -120), { accuracy: 10 });            // the nearest you have been
    for (let i = 0; i < OFF_ROUTE_FIXES; i++) {
      h.nav.moved(north(start, -(120 + OFF_ROUTE_M + 20)), { accuracy: 10 });
    }
    assert.equal(h.nav.isOffRoute(), true);
    assert.match(liveSign(h).instruction, /back to the route/i);
  });
});

test('coming back onto the line somewhere new never freezes the sign', () => {
  // Off the route, then back onto it further up — a shortcut across a lawn.
  // The place you rejoin is outside the window, so `track` waits for
  // JUMP_FIXES to agree on it; the sign must keep saying something true and
  // the camera keep following while it waits.
  withDocument(() => {
    const h = walking();
    h.nav.start();
    strideAlong(h, 0, 0.03);
    const away = north(at(h, 0.03), -70);
    for (let i = 0; i < OFF_ROUTE_FIXES; i++) h.nav.moved(away, { accuracy: 8 });
    assert.equal(h.nav.isOffRoute(), true);

    // Back toward the line, rejoining 60 m further along the first leg.
    const rejoin = h.route.maneuverKm(1) - 0.005;
    const fixes = [north(at(h, rejoin), -30), north(at(h, rejoin), -15), at(h, rejoin), at(h, rejoin + 0.002), at(h, rejoin + 0.004)];
    const shown = [];
    for (const fix of fixes) {
      const eases = h.map.eases.length;
      h.nav.moved(fix, { accuracy: 8 });
      assert.equal(h.map.eases.length, eases + 1, `the camera stopped following at ${fix}`);
      shown.push(`${liveSign(h).distance} ${liveSign(h).instruction}`);
    }
    // Every fix said something different until the sign was back — no frozen
    // distance — and it is back by the end, pointing at the right corner.
    const warnings = shown.filter((s) => /back to the route/i.test(s));
    assert.equal(new Set(warnings).size, warnings.length, `the warning froze: ${shown.join(' | ')}`);
    assert.equal(h.nav.isOffRoute(), false);
    assert.doesNotMatch(liveSign(h).instruction, /back to the route/i);
    assert.equal(h.nav.stepIndex(), 2);
    assert.equal(liveSign(h).instruction, instructionFor('left'));
  });
});

// ---------------------------------------------------------------------------
// GPS noise — short legs, hairpins, sparse fixes and the way onto the line
// ---------------------------------------------------------------------------

/**
 * A point `x` m east and `y` m north of the corner of campus the fixtures
 * start from, on the sphere turf measures on — so a route drawn in metres
 * here is that many metres long to `route.cumulative`.
 */
const METRES_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;
const ORIGIN = U_WALK.geometry.coordinates[0];
const local = ([x, y]) => [
  ORIGIN[0] + x / (METRES_PER_DEGREE * Math.cos((ORIGIN[1] * Math.PI) / 180)),
  ORIGIN[1] + y / METRES_PER_DEGREE,
];

/** A harness walking a route drawn in local metres, one maneuver per vertex. */
function walkingLocal(points, turns) {
  const route = createRoute();
  route.set({
    geometry: { type: 'LineString', coordinates: points.map(local) },
    maneuvers: ['depart', ...turns, 'arrive'].map((type, index) => ({ index, type })),
  });
  return harness({ route });
}

test('two fixes beside a short jog take its corners one at a time', () => {
  // A left, an 8 m leg, a right, a left. Two fixes 9.4 m to the side of a
  // walker 3 m short of the first corner — each inside its own accuracy
  // circle — used to land on the leg after the jog and take both corners at
  // once, and the right turn between them was never shown.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [60, 0], [60, 8], [120, 8], [120, 50]], ['left', 'right', 'left']);
    h.nav.start();
    strideAlong(h, 0, 0.05, { stepKm: 0.0014 });
    assert.equal(h.nav.stepIndex(), 1);

    const seen = [];
    for (const fix of [[53, 9.4], [54, 9.4]]) {
      h.nav.moved(local(fix), { accuracy: 10 });
      seen.push(h.nav.stepIndex());
    }
    for (let m = 52; m <= h.route.totalKm * 1000; m += 1.4) {
      h.nav.moved(at(h, m / 1000), { accuracy: 5 });
      seen.push(h.nav.stepIndex());
    }
    assert.ok(seen.includes(2), `the right turn was never shown: ${[...new Set(seen)]}`);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(Math.abs(seen[i] - seen[i - 1]) <= 1, `the sign jumped ${seen[i - 1]} -> ${seen[i]}`);
    }
    assert.equal(h.nav.stepIndex(), 4);
  });
});

test('fixes pulled toward the way out of a hairpin do not walk you back down it', () => {
  // Legs 10 m apart. Two fixes 5.5 m off the way home, on the way-out side,
  // used to put you on the way out; accurate fixes after that were 10 m from
  // it, inside SNAP_FIT_M, and slid you back along it, giving back both
  // corners — and the sign reached the third corner pointing at the first.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [100, 0], [100, 10], [0, 10], [0, 80]], ['left', 'left', 'right']);
    h.nav.start();
    strideAlong(h, 0, 0.12, { stepKm: 0.0014 });
    assert.equal(h.nav.stepIndex(), 3);

    h.nav.moved(local([88, 4.5]), { accuracy: 6 });
    h.nav.moved(local([86, 4.5]), { accuracy: 6 });
    for (let x = 84; x >= 10; x -= 2) {
      h.nav.moved(local([x, 10]), { accuracy: 5 });
      assert.equal(h.nav.stepIndex(), 3, `the sign went back to step ${h.nav.stepIndex()} at x=${x}`);
      assert.equal(liveSign(h).instruction, instructionFor('right'));
    }
    assert.ok(Math.abs(believedKm(h) - 0.2) < 0.005, `believed at ${believedKm(h)} km, walking at 0.2`);
  });
});

test('a walker the GPS put on the wrong leg of a hairpin is put back on the right one', () => {
  // Here the noise wins: fixes biased toward the way out while the walker
  // goes round the bend keep the window on the way out, and from there every
  // fix on the way home is a few metres away and fits. The believed position
  // walks backward while the line ahead fits better, and that is the wrong
  // leg, put right once JUMP_FIXES agree.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [100, 0], [100, 10], [0, 10], [0, 80]], ['left', 'left', 'right']);
    h.nav.start();
    strideAlong(h, 0, 0.095, { stepKm: 0.0014 });
    // Round the bend with every fix 4 m south and 5 m west of the walker.
    for (let m = 96; m <= 125; m += 1.4) {
      const [x, y] = m <= 100 ? [m, 0] : m <= 110 ? [100, m - 100] : [210 - m, 10];
      h.nav.moved(local([x - 5, y - 4]), { accuracy: 6 });
    }
    // The precondition: the bias did put the walker on the way out.
    assert.ok(believedKm(h) < 0.1, `the fixture never went wrong (${believedKm(h)} km)`);

    // Accurate fixes up the way home: back on it within a few of them.
    let caught = null;
    for (let x = 84; x >= 0 && caught === null; x -= 1.4) {
      h.nav.moved(local([x, 10]), { accuracy: 5 });
      if (Math.abs(believedKm(h) - (0.21 - x / 1000)) < 0.005) caught = x;
    }
    assert.ok(caught !== null && caught > 60, `still on the wrong leg (caught at x=${caught})`);
    assert.equal(h.nav.stepIndex(), 3);
  });
});

test('three fixes beside the way out are not a leap to the way home', () => {
  // Accurate to 60 m up the outbound leg, then three fixes 17 m north — a
  // poor fit for the leg you are on, and 3 m from the way home. The way home
  // there is 143 m on along the route and 17 m away in a straight line: an
  // ambiguity, not a leap, and the window keeps it. It used to read "Arrive at
  // destination", and a steady 6 m bias afterwards kept it there.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [121.6, 0], [121.6, 20], [0, 20]], ['left', 'left']);
    h.nav.start();
    strideAlong(h, 0, 0.06, { stepKm: 0.0014 });
    for (const x of [60, 61.4, 62.8]) h.nav.moved(local([x, 17]), { accuracy: 10 });
    assert.equal(h.nav.stepIndex(), 1, 'the corners went with three fixes beside you');
    assert.equal(liveSign(h).instruction, instructionFor('left'));

    for (let x = 64; x <= 110; x += 1.4) {
      h.nav.moved(local([x, 6]), { accuracy: 10 });
      assert.equal(h.nav.stepIndex(), 1, `step ${h.nav.stepIndex()} at x=${x}`);
    }
  });
});

test('a leap to the door is not arriving; the next fix there is', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const h = walking();
    h.nav.start();
    strideAlong(h, 0, 0.03);
    const door = WALK.geometry.coordinates[3];
    for (let i = 0; i < JUMP_FIXES; i++) h.nav.moved(door, { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), WALK.maneuvers.length - 1, 'the precondition: the leap was believed');
    t.mock.timers.tick(BANNER_SWAP_MS);
    assert.notEqual(liveSign(h).distance, 'Arrived', 'a leap said you had arrived');
    assert.equal(liveSign(h).instruction, instructionFor('arrive'));

    h.nav.moved(door, { accuracy: 5 });
    assert.equal(liveSign(h).distance, 'Arrived');
  });
});

test('standing at the door in noise never shows a distance beside "you have arrived"', (t) => {
  // Fixes either side of ARRIVED_FEET used to take "Arrived" down by
  // rewriting only the distance: "50 ft | You have reached your destination".
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    strideAlong(h, 0, h.route.totalKm);
    t.mock.timers.tick(BANNER_SWAP_MS);
    h.nav.moved(at(h, h.route.totalKm), { accuracy: 12 });
    assert.equal(liveSign(h).distance, 'Arrived');

    for (const back of [15, 2, 18, 0, 12, 40, 40, 40, 0, 0]) {
      h.nav.moved(at(h, h.route.totalKm - back / 1000), { accuracy: 12 });
      t.mock.timers.tick(BANNER_SWAP_MS);
      const sign = liveSign(h);
      if (/reached your destination/i.test(sign.instruction)) {
        assert.equal(sign.distance, 'Arrived', `"${sign.distance} | ${sign.instruction}" ${back} m back`);
      } else {
        assert.notEqual(sign.distance, 'Arrived');
      }
      // A few metres back in noise does not take it down at all.
      if (back <= 18) assert.equal(sign.distance, 'Arrived', `unsaid ${back} m back`);
    }
  });
});

for (const stride of [25, 30, 40]) {
  test(`fixes ${stride} m apart round the U keep the camera and the sign moving`, () => {
    // On a walk that doubles back, the back of the window sits on the way out
    // and can be nearer the fix than its front: catching up has to follow the
    // fix up the line all the same. It used to freeze the camera for two
    // fixes after the second corner, with the sign on "Turn left 20 ft".
    for (const phase of [0, 7, 14]) {
      withDocument(() => {
        const h = walkingTheU();
        h.nav.start();
        const seen = new Set([h.nav.stepIndex()]);
        let last = 0;
        for (let km = (stride + phase) / 1000; km < h.route.totalKm; km += stride / 1000) {
          const eases = h.map.eases.length;
          h.nav.moved(at(h, km), { accuracy: 5 });
          assert.equal(h.map.eases.length, eases + 1, `the camera froze at ${km} km (phase ${phase})`);
          const now = believedKm(h);
          assert.ok(now > last, `stalled at ${last} km with a fix at ${km} km (phase ${phase})`);
          assert.ok(km - now < stride / 1000, `believed at ${now} km, walking at ${km} km`);
          last = now;
          seen.add(h.nav.stepIndex());
        }
        h.nav.moved(at(h, h.route.totalKm), { accuracy: 5 });
        assert.equal(h.nav.stepIndex(), U_WALK.maneuvers.length - 1);
        if (stride < 40) assert.ok(seen.has(2), `the second corner was never shown (phase ${phase})`);
      });
    }
  });
}

test('a jogger whose phone reports every twenty seconds is followed on every fix', () => {
  // 61 m and 70 m a fix: further than SNAP_CATCH_UP_M, and further apart than
  // any fixed agreement distance. With the fixes' own times the catch-up
  // reaches as far as SNAP_PACE_MPS would carry you since the last one.
  for (const stride of [61, 70]) {
    withDocument(() => {
      const h = walkingLocal([[0, 0], [564, 0]], []);
      h.nav.start();
      let last = 0;
      for (let k = 1; k * stride < 564; k++) {
        h.nav.moved(at(h, (k * stride) / 1000), { accuracy: 5, timestamp: k * 20_000 });
        const now = believedKm(h);
        assert.ok(Math.abs(now - (k * stride) / 1000) < 0.002, `believed at ${now} km, walking at ${k * stride} m`);
        assert.ok(now > last);
        last = now;
      }
    });
  }
});

test('without times, a jogger far ahead of the window waits for one leap and is then followed', () => {
  // Further on than SNAP_CATCH_UP_M with no time to say it could be, so the
  // first JUMP_FIXES - 1 wait to be agreed like any leap. The run of agreeing
  // leaps then carries on once believed, rather than starting again from one
  // at every fix.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [564, 0]], []);
    h.nav.start();
    strideAlong(h, 0, 0.01);
    let stalled = 0;
    for (let k = 1; k <= 8; k++) {
      const before = believedKm(h);
      h.nav.moved(at(h, 0.01 + k * 0.061), { accuracy: 5 });
      if (believedKm(h) === before) stalled++;
    }
    assert.equal(stalled, JUMP_FIXES - 1);
    assert.ok(Math.abs(believedKm(h) - (0.01 + 8 * 0.061)) < 0.002);
  });
});

test('a sparse fix past a corner turns the sign at once', () => {
  // A phone reporting every 30 m is not jitter: waiting for a second fix kept
  // the sign on a corner the walker was already 40 m past.
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const steps = {};
    for (let k = 0; k <= 10; k++) {
      const m = 10 + k * 30;
      h.nav.moved(at(h, m / 1000), { accuracy: 5 });
      steps[m] = h.nav.stepIndex();
    }
    assert.equal(steps[70], 1);
    assert.equal(steps[100], 2, 'the first corner is at 87 m');
    assert.equal(steps[190], 2);
    assert.equal(steps[220], 3, 'the second corner is at 198 m');
  });
});

test('standing short of a corner in noise does not flip the sign back and forth', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    const corner = h.route.maneuverKm(1);
    strideAlong(h, 0, corner - 0.01);
    const seen = [];
    for (const d of [-6, -6, -19, -19, -6, -6, -19, -19, -19]) {
      h.nav.moved(at(h, corner + d / 1000), { accuracy: 16 });
      seen.push(h.nav.stepIndex());
    }
    const changes = seen.filter((s, i) => i > 0 && s !== seen[i - 1]).length;
    assert.ok(changes <= 1, `the sign changed ${changes} times: ${seen.join('')}`);
  });
});

test('hovering around OFF_ROUTE_M on the way to the line is still approaching it', () => {
  // One fix at 39 m used to join the walk to the line, and the next three at
  // 41-43 m — ordinary noise on a walker heading straight for it — said you
  // had left the route.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [87, 0], [87, 111], [217, 111]], ['right', 'left']);
    h.nav.start();
    for (let m = REACH_M; m >= 60; m -= 20) h.nav.moved(local([0, -m]), { accuracy: 20 });
    for (const m of [39, 43, 42, 41, 38, 44, 42, 41]) {
      h.nav.moved(local([0, -m]), { accuracy: 20 });
      assert.equal(h.nav.isOffRoute(), false, `off route ${m} m out`);
      assert.doesNotMatch(liveSign(h).instruction, /back to the route/i);
    }
  });
});

test('one optimistic fix on the way to the line does not make standing still "walking away"', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
    for (const m of [300, 255, 300, 300, 300, 300]) {
      h.nav.moved(north(WALK.geometry.coordinates[0], -m), { accuracy: 30 });
      assert.equal(h.nav.isOffRoute(), false, `off route at ${m} m`);
    }
  });
});

test('back on the line while a rejoin is agreed, the sign does not say "0 ft, head back"', () => {
  withDocument(() => {
    const h = walkingLocal([[0, 0], [400, 0]], []);
    h.nav.start();
    strideAlong(h, 0, 0.05);
    for (let i = 0; i < OFF_ROUTE_FIXES + 1; i++) h.nav.moved(local([50, -60]), { accuracy: 5 });
    assert.equal(h.nav.isOffRoute(), true);

    for (const km of [0.15, 0.152]) {
      const eases = h.map.eases.length;
      h.nav.moved(at(h, km), { accuracy: 5 });
      assert.doesNotMatch(liveSign(h).instruction, /back to the route/i, `at ${km} km`);
      assert.match(liveSign(h).instruction, /rejoining/i);
      assert.equal(h.map.eases.length, eases + 1, 'the camera stopped following');
    }
    h.nav.moved(at(h, 0.154), { accuracy: 5 });
    assert.equal(liveSign(h).instruction, instructionFor('arrive'));
  });
});

test('joining the line away from its start keeps the camera following', () => {
  // An off-network start whose walk first meets the line 100 m along it: the
  // fix that joins is outside the window, so it waits for JUMP_FIXES like a
  // leap, and with nothing yet believed the camera used to stop for them.
  withDocument(() => {
    const h = walkingLocal([[0, 0], [400, 0]], []);
    h.nav.start();
    for (let m = 250; m >= 0; m -= 10) {
      const eases = h.map.eases.length;
      h.nav.moved(local([100, -m]), { accuracy: 8 });
      assert.equal(h.map.eases.length, eases + 1, `the camera stopped ${m} m from the line`);
    }
    assert.ok(Math.abs(believedKm(h) - 0.1) < 0.002);
  });
});

// ---------------------------------------------------------------------------
// Corners close together, and the dotted legs. Built from metres and handed to
// buildManeuvers, so the shapes are the ones the router actually answers with.
// ---------------------------------------------------------------------------

const O = [-121.3460, 38.6490];
const en = (e, n) => [O[0] + e / 86940, O[1] + n / 110980];
const FT = 0.3048;

/**
 * A route over `coords`, its pins `ends` if given, held the way main.js holds
 * it. The maneuvers are buildManeuvers' unless given.
 */
function routeOver(coords, ends = {}, maneuvers = buildManeuvers(coords, ends)) {
  const route = createRoute();
  route.set({ geometry: { type: 'LineString', coordinates: coords }, maneuvers }, ends);
  return route;
}

const signText = (h) => {
  const sign = h.dom.stack.children.at(-1);
  return `${sign.querySelector('.nav-distance').textContent} | ${sign.querySelector('.nav-instruction').textContent}`;
};

test('a first turn ten feet from the start is shown, not skipped', () => {
  // North 10 ft, then east. The old 25 ft rule retired it on the first fix.
  withDocument(() => {
    const route = routeOver([en(0, 0), en(0, 10 * FT), en(60, 10 * FT)]);
    assert.equal(route.maneuvers[1].type, 'right');
    const h = harness({ route });
    h.nav.start();
    assert.equal(h.nav.stepIndex(), 1);
    assert.match(signText(h), /Turn right/);

    h.nav.moved(en(0, 3 * FT));                      // seven feet short of it
    assert.equal(h.nav.stepIndex(), 1, 'retired while still ahead');
    h.nav.moved(en(5, 10 * FT));                     // round it
    assert.equal(h.nav.stepIndex(), 2);
  });
});

test('two turns fifteen feet apart go on one sign, and neither is skipped', () => {
  withDocument(() => {
    // North 60 m, east 15 ft, north again. buildManeuvers would call a jog
    // this short one bend and say nothing; given as two, the way a router
    // that reads it otherwise would hand it over.
    const coords = [en(0, 0), en(0, 60), en(15 * FT, 60), en(15 * FT, 120)];
    const route = routeOver(coords, {}, [
      { type: 'depart', index: 0 }, { type: 'right', index: 1 },
      { type: 'left', index: 2 }, { type: 'arrive', index: 3 },
    ]);
    const h = harness({ route });
    h.nav.start();
    assert.match(signText(h), /Turn right, then turn left/);

    // Twenty feet short of the first corner: the old rule had already jumped
    // to the second one here, five feet short of retiring that too.
    h.nav.moved(en(0, 60 - 20 * FT));
    assert.equal(h.nav.stepIndex(), 1);

    h.nav.moved(en(2, 60));                          // round the first
    assert.equal(h.nav.stepIndex(), 2);
    assert.match(signText(h), /^\S+ ft \| Turn left$/);
  });
});

test('a last turn twenty feet before the end is shown before the arrival', () => {
  withDocument(() => {
    const route = routeOver([en(0, 0), en(0, 60), en(20 * FT, 60)]);
    const h = harness({ route });
    h.nav.start();
    h.nav.moved(en(0, 60 - 20 * FT));
    assert.equal(route.maneuvers[h.nav.stepIndex()].type, 'right', 'the corner was skipped for the arrival');
    h.nav.moved(en(20 * FT, 60));
    assert.equal(route.maneuvers[h.nav.stepIndex()].type, 'arrive');
  });
});

test('depart is on the sign until the walker is on the path', () => {
  withDocument(() => {
    // A pin 30 m west of a path that runs north: walk east to it, turn left.
    const from = en(-30, 0);
    const route = routeOver([en(0, 0), en(0, 100)], { from, to: en(0, 100) });
    assert.equal(route.maneuvers[0].turn, 'left');
    const h = harness({ route });
    h.nav.start();
    assert.equal(h.nav.stepIndex(), 0, 'depart was retired at the pin');
    assert.match(signText(h), /Walk to the path, then turn left/);
    assert.match(signText(h), /^100 ft/);

    h.nav.moved(en(-15, 0));
    assert.equal(h.nav.stepIndex(), 0);
    h.nav.moved(en(-1, 1));
    assert.equal(h.nav.stepIndex(), 1);
  });
});

test('the remaining distance and the ETA include the dotted legs, in the card\'s words', async () => {
  await withDocument(async () => {
    const route = routeOver([en(0, 0), en(0, 100)], { from: en(-30, 0), to: en(40, 100) });
    const legs = route.legFeet;
    assert.ok(Math.abs(legs.from - 30 / FT) < 1 && Math.abs(legs.to - 40 / FT) < 1, JSON.stringify(legs));
    const h = harness({ route });
    h.nav.start();
    const whole = route.totalKm * FEET_PER_KM + legs.from + legs.to;
    assert.equal(h.dom.eta.textContent, walkLabel(walkSeconds(whole)));
    // 170 m is 558 ft, which niceFeet calls 550 here and on the card alike.
    assert.equal(h.dom.remaining.textContent, '550 ft');

    // At the end of the line the destination is still 40 m off. Walked there
    // a few metres a fix, as a phone reports it: one fix a hundred metres on
    // is a leap the tracker rightly waits to believe.
    for (let n = 0; n <= 100; n += 5) h.nav.moved(en(0, n));
    assert.notEqual(h.dom.stack.children.at(-1).querySelector('.nav-distance').textContent, 'Arrived');
    assert.match(signText(h), /Destination on your right/);
    await new Promise((done) => setTimeout(done, 400));   // let the sign land
    for (const e of [10, 20, 30, 39]) h.nav.moved(en(e, 100));
    assert.equal(h.dom.stack.children.at(-1).querySelector('.nav-distance').textContent, 'Arrived');
    assert.equal(h.dom.remaining.textContent, '0 ft');
  });
});

test('a walk of 1 min 29 s reads the same on the banner as on the card', () => {
  // The banner rounded and the card rounds up: "1 min" against "2 min".
  withDocument(() => {
    const metres = 89 * 1.4;
    const route = routeOver([en(0, 0), en(0, metres)]);
    const h = harness({ route });
    h.nav.start();
    assert.equal(h.dom.eta.textContent, '2 min');
    assert.equal(walkLabel(walkSeconds(metres / FT)), '2 min');
  });
});
