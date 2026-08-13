// Where the app thinks you are.
//
// Mapbox's GeolocateControl reads `navigator.geolocation` by default, but it
// takes the object as an option — `new GeolocateControl({ geolocation })` — and
// only ever calls three methods on it. That is the seam this module fills. Hand
// it one of these and the control can be told, truthfully as far as it is
// concerned, that the phone is standing in the middle of the campus.
//
// WHY A FIXTURE RATHER THAN A SECOND DOT. The question being asked is "how does
// the GPS interface look", and the GPS interface is Mapbox's: the blue dot with
// its white ring, the accuracy circle sized from the fix, the heading wedge, and
// the locate button's five states — waiting, active, background, and the two
// error variants. Drawing our own marker at the centre of the campus would put a
// blue dot on the screen and answer none of that. Driving the real control with
// a made-up position exercises every one of those paths, because from inside the
// control nothing about the situation is made up.
//
// WHY THE SWITCH IS INSIDE. The alternative is to build a second control when
// the fixture is turned on and throw the first away. That orphans the watch
// already in flight, loses the button's state, and means the thing on screen
// after the switch is not the thing that was on screen before it — which is the
// one property a debug toggle has to have. Delegating per call instead means the
// control never learns that anything happened: a watch opened against the real
// GPS becomes a watch against the fixture under the same id.

// What a decent phone reports standing still outdoors, and the radius the
// accuracy circle is drawn at. Small enough that the circle is a halo around the
// dot rather than a disc covering a building.
const ACCURACY_M = 8;

/**
 * A Geolocation, real or fixed.
 *
 * `real` is what it delegates to while no fixture is set — normally the
 * browser's own, and injectable so this is testable off a browser.
 */
export function createGeolocation({ real = globalThis.navigator?.geolocation ?? null } = {}) {
  // [lon, lat] while the fixture is on, null while the real GPS is in charge.
  let fixed = null;
  let heading = 0;
  const watches = new Map();
  let nextId = 1;

  const fix = () => ({
    coords: {
      latitude: fixed[1],
      longitude: fixed[0],
      accuracy: ACCURACY_M,
      // Every field the interface promises, because the consumer is somebody
      // else's code: a missing `altitude` reads as `undefined` where the real
      // API guarantees `null`, and that difference is exactly the kind of thing
      // a fixture exists to not introduce.
      altitude: null,
      altitudeAccuracy: null,
      // The compass, not the course. A phone that is not moving has no speed and
      // no direction of travel to report, and says so; the heading the wedge is
      // drawn from arrives as an orientation event instead. See pulseCompass.
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  });

  /**
   * The compass half of the fixture.
   *
   * The heading wedge is not driven by the position at all — the control adds a
   * window listener for device orientation and reads the angle from there — so a
   * fixture that only supplied a position would light every part of the GPS
   * interface except the one that says which way you are facing.
   *
   * `alpha` is measured anticlockwise from north and the control negates it, so
   * this negates it back. `absolute` has to be true or the control ignores the
   * event, which is correct of it: a relative orientation is not a bearing.
   */
  function pulseCompass() {
    if (typeof DeviceOrientationEvent !== 'function') return;
    // The same name the control chose when it subscribed. Chrome fires
    // `deviceorientationabsolute` and listens for that one in preference, so an
    // event sent under the other name would be delivered to nobody.
    const name = 'ondeviceorientationabsolute' in globalThis
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
    let event;
    try {
      event = new DeviceOrientationEvent(name, {
        alpha: (360 - heading) % 360,
        beta: 0,
        gamma: 0,
        absolute: true,
      });
    } catch {
      // Firefox has the interface but not the constructor. The wedge is the one
      // thing that goes missing, and the dot underneath it does not care.
      return;
    }
    globalThis.dispatchEvent(event);
  }

  function deliver(entry) {
    if (!watches.has(entry.id) || !fixed) return;
    entry.ok?.(fix());
    pulseCompass();
  }

  function start(entry) {
    if (fixed) {
      // Asynchronously, because the real API is. A success callback that fires
      // before `watchPosition` has returned its id is a shape no caller is
      // written for, and the control is one of the callers that would break.
      entry.timer = setTimeout(() => deliver(entry), 0);
      return;
    }
    if (real) {
      entry.realId = real.watchPosition(entry.ok, entry.err, entry.options);
      return;
    }
    setTimeout(() => {
      entry.err?.({ code: 2, message: 'Geolocation is unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    }, 0);
  }

  function stop(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.realId !== undefined) {
      real?.clearWatch(entry.realId);
      entry.realId = undefined;
    }
  }

  return {
    getCurrentPosition(ok, err, options) {
      if (!fixed) {
        if (real) real.getCurrentPosition(ok, err, options);
        else setTimeout(() => err?.({ code: 2, message: 'Geolocation is unavailable' }), 0);
        return;
      }
      setTimeout(() => { ok?.(fix()); pulseCompass(); }, 0);
    },

    watchPosition(ok, err, options) {
      const entry = { id: nextId, ok, err, options };
      nextId += 1;
      watches.set(entry.id, entry);
      start(entry);
      return entry.id;
    },

    clearWatch(id) {
      const entry = watches.get(id);
      if (!entry) return;
      stop(entry);
      watches.delete(id);
    },

    /**
     * Put the fixture at `coords`, or pass null to hand every watch back to the
     * real GPS.
     *
     * ONE FIX PER SWITCH, not a heartbeat. A watch on a phone standing still
     * does keep reporting, and copying that here would be faithful and wrong:
     * the control re-runs `fitBounds` on every fix it receives while it is
     * locked on, so a stationary fixture ticking once a second is a camera that
     * snaps back to a fixed zoom every second while you are trying to look at
     * something. One fix leaves the dot exactly where a stationary walker's dot
     * would be, which is the whole of what was asked for.
     */
    useFixture(coords, { heading: bearing = 0 } = {}) {
      const same = (!coords && !fixed)
        || (coords && fixed && coords[0] === fixed[0] && coords[1] === fixed[1] && bearing === heading);
      if (same) return;
      fixed = coords ? [coords[0], coords[1]] : null;
      heading = bearing;
      for (const entry of watches.values()) {
        stop(entry);
        start(entry);
      }
    },

    /** Whether the fixture is currently standing in for the real thing. */
    get fixture() {
      return fixed ? [...fixed] : null;
    },
  };
}
