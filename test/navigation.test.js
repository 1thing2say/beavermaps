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
import { createNavigation, LOOK_AHEAD_KM, MANEUVER_REACHED_KM } from '../src/navigation.js';
import { createRoute } from '../src/route-state.js';
import { element, withDocument } from './fake-dom.js';

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
    h.nav.moved([-121.3455, 38.6490]);
    assert.ok(h.nav.stepIndex() >= 2, 'the banner is still pointing at a corner behind us');

    // All the way to the end.
    h.nav.moved(WALK.geometry.coordinates[3]);
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
    h.nav.moved(WALK.geometry.coordinates[2]);   // onto the last, longest leg
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

    h.nav.moved([-121.3455, 38.6490]);               // past the first corner
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

test('arriving says so, and says it on the sign as well as the footer', () => {
  withDocument(() => {
    const h = walking();
    h.nav.start();
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
  // calls, so pushing the last position asks exactly the same question.
  withDocument(() => {
    const h = walking();
    try {
      h.nav.start({ simulate: true });
      assert.equal(h.nav.isSimulating(), true);

      h.nav.moved(WALK.geometry.coordinates[3]);
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
