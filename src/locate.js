// The locate control, and the two-press unlock standing in front of it.
//
// Mapbox's own control is one button that asks the browser for a position. This
// wraps it in a rule the browser cannot express: the FIRST press explains what
// is about to happen and the second one does it. A permission prompt that
// arrives with no warning is a prompt most people decline, and a declined
// permission is not something the page can ask about again.
//
// `locating` is the control's own state, kept by its two track events rather
// than guessed at — see `startLocating` for why guessing is not good enough,
// and navigation for why the answer matters: dropping the control to background
// is the one gesture that keeps the dot live and gives the camera up.

/**
 * @param {object} deps
 * @param {Function} deps.control    the Mapbox control, once it exists
 */
export function createLocate({ control }) {
  // the blue dot off at the exact moment it was asked for.
  let locating = false;

  const locateButton = () => document.querySelector('.mapboxgl-ctrl-geolocate');

  // Set only when WE were the ones who re-enabled that button, so switching the
  // fixture off puts it back the way the browser left it rather than leaving a
  // live-looking control that cannot work.
  let locateUnlocked = false;

  /**
   * Let the locate button be pressed even though the browser said no.
   *
   * The control asks for the geolocation permission while it sets itself up and
   * disables its own button when the answer is "denied". That is right, and it
   * stops being the question the moment the position is coming from a fixture
   * instead — somebody who once blocked location for this origin is exactly the
   * person who needs a way to see what the blue dot does. Without this the dot
   * can still be turned on from here, but the button beside it is dead, and the
   * button's own five states are half of the interface being looked at.
   */
  function unlockLocate(button) {
    if (!button.disabled) return;
    button.disabled = false;
    locateUnlocked = true;
  }

  function relockLocate() {
    if (!locateUnlocked) return;
    const button = locateButton();
    if (button) button.disabled = true;
    locateUnlocked = false;
  }

  /**
   * Start the locate control, once it is able to start.
   *
   * Waits for the BUTTON rather than calling `trigger()` and reading its
   * refusal. The control builds that button at the end of setting itself up,
   * and setting up waits on a permissions query which has not settled when a
   * page opened with the fixture already on reaches this point — so trigger()
   * would refuse, and warn, on every single reload with the switch on. Two
   * seconds of retries and then it gives up, rather than spinning forever.
   */
  function startLocating(attempt = 0) {
    // Before the map has loaded there is no control yet. The load handler calls
    // this again once there is, so nothing is lost by returning here.
    if (!control() || locating) return;
    const button = locateButton();
    if (!button) {
      if (attempt < 20) setTimeout(() => startLocating(attempt + 1), 100);
      return;
    }
    unlockLocate(button);
    control().trigger();
  }
  return {
    start: startLocating,
    unlock: unlockLocate,
    relock: relockLocate,
    /** Whether the control currently holds the camera. */
    isLocating: () => locating,
    setLocating: (on) => { locating = on; },
    button: locateButton,
  };
}
