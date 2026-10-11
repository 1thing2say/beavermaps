// Draw into the map only while there is a style to draw into.
//
// The campus overlays arrive on their own schedule, and the map's style is
// not always there to receive them: before the first style has loaded, and
// for the whole of every setStyle — the Google ground falling back to
// Standard, a satellite or provider toggle — mapbox-gl holds a new Style that
// is not loaded, and its addSource throws "Style is not done loading". That is
// not an error worth having: style.load's rebuild draws every layer from
// whatever data has been stored by then, so a layer skipped now is drawn then.
//
// Pure, so a test can hold the style down and throw from a builder without a
// map. See the overlay handlers in src/main.js.

/**
 * @param {() => boolean} ready     whether a style is built and ours to write to
 * @param {(error: unknown) => void} [report]  where a builder's own error goes
 * @returns {(...builders: Function[]) => void}
 */
export function createDrawGate(ready, report = (error) => console.error(error)) {
  return (...builders) => {
    if (!ready()) return;
    // Each one on its own, so a builder that still throws costs its own layer
    // and not the ones after it — nor, more to the point, the state the
    // handler calling this goes on to set.
    for (const build of builders) {
      try { build(); } catch (error) { report(error); }
    }
  };
}
