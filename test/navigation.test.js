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
  MANEUVER_REACHED_KM,
  JUMP_FIXES,
  OFF_ROUTE_M,
  OFF_ROUTE_FIXES,
  GIVE_BACK_M,
  BANNER_SWAP_MS,
} from '../src/navigation.js';
import { instructionFor } from '../src/maneuvers.js';
import { REACH_M } from '../src/directions.js';
import { createRoute } from '../src/route-state.js';
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

test('MANEUVER_REACHED_KM is a stride, not a block', () => {
  // 25 ft. If this ever grows to something like the distance between corners,
  // advanceSteps skips whole maneuvers on the first fix.
  assert.ok(MANEUVER_REACHED_KM > 0);
  assert.ok(MANEUVER_REACHED_KM < 0.02, `${MANEUVER_REACHED_KM} km is not a stride`);
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

test('a fix by the start that drifts toward the return leg does not skip the walk', () => {
  withDocument(() => {
    const h = walkingTheU();
    h.nav.start();
    const drifted = north(U_WALK.geometry.coordinates[0], 12);   // 8 m from the return leg

    // The precondition, so this test cannot pass for the wrong reason: the
    // nearest point on the whole line really is near the far end.
    const naive = nearestPointOnLine(h.route.line, point(drifted)).properties.location;
    assert.ok(naive > h.route.totalKm * 0.9, `the fixture is not ambiguous (${naive} km)`);

    // A phone held still at the start, every fix pulled the same way.
    for (let i = 0; i < 10; i++) h.nav.moved(drifted, { accuracy: 10 });

    assert.equal(h.nav.stepIndex(), 1, 'corners were retired from the start line');
    const sign = h.dom.stack.children.at(-1);
    assert.notEqual(sign.querySelector('.nav-distance').textContent, 'Arrived');
    assert.notEqual(h.dom.remaining.textContent, '0 ft');
  });
});

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

    for (const km of [corner - 0.015, corner - 0.004, corner - 0.004]) h.nav.moved(at(h, km), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 2, 'the precondition: the corner was retired');
    assert.equal(liveSign(h).instruction, instructionFor('left'));

    // Short of where it was retired, but by less than GIVE_BACK_M: a walker
    // standing at a corner in noise does not see it come and go.
    const retiredAt = corner - MANEUVER_REACHED_KM;
    for (let i = 0; i < 3; i++) h.nav.moved(at(h, retiredAt - GIVE_BACK_M / 2000), { accuracy: 5 });
    assert.equal(h.nav.stepIndex(), 2, 'given back inside the slack');

    // GIVE_BACK_M short of it and more: the corner is yours again.
    const back = retiredAt - GIVE_BACK_M / 1000 - 0.002;
    h.nav.moved(at(h, back), { accuracy: 5 });
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
    // that is two fixes in every three standing still. A fix just past the
    // window, or just round a corner from its end, fits there and is held
    // there, so it can lag — by less than the stride, and the next fix
    // catches up.
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
