// What to say when the app cannot start at all.
//
// Same rule as src/basemap-problem.js and the routing refusals in
// src/directions.js: a refusal names the way forward. This file exists because
// one refusal did not — it was a console.warn, and the whole app was the `else`
// branch behind it.
//
// THE FAILURE IT REPLACES. `VITE_MAPBOX_TOKEN` is inlined at build time, so a
// deploy whose --build-arg was missing produces a bundle with `undefined` where
// the token goes. main.js noticed, wrote one line to the console, and stopped.
// Everything after that point — the map, the chrome, the sheet, the search
// field — is inside the branch that did not run, so what reaches the screen is
// the empty page index.html starts as. No map, no error, nothing to click, and
// the one sentence explaining it is behind a developer-tools panel that the
// person who deployed it is not looking at on their phone.
//
// It is also the one failure in this app with NO working degraded mode. A
// refused Google key falls back to Mapbox; a missing overlay costs one layer; a
// dead routing server still leaves a map you can look at. Without a Mapbox
// token there is no map to put anything on. So this does not try to be part of
// the app's chrome — it replaces the map with the reason there isn't one.

/**
 * Whether this is a token at all, and what to say if it is not.
 *
 * The placeholder is checked by value because it is what the README tells you
 * to copy into .env, so "I did the setup step but not the one after it" is a
 * real state a person gets into and deserves a different sentence from having
 * skipped the file entirely.
 *
 * @param {string|undefined} token  whatever VITE_MAPBOX_TOKEN was inlined as
 * @returns {string|null}  null when the token is present and worth trying
 */
export function tokenRefusal(token) {
  if (token === 'YOUR_MAPBOX_TOKEN_HERE') {
    return 'The Mapbox token is still the placeholder. Put a real pk.… token in '
      + '.env as VITE_MAPBOX_TOKEN, then restart the dev server.';
  }
  if (!token) {
    return 'No Mapbox token was built in. Set VITE_MAPBOX_TOKEN in .env for a '
      + 'local run, or pass it to `fly deploy --build-arg` — it is inlined at '
      + 'build time, so a restart alone will not pick it up.';
  }
  return null;
}

/**
 * What to say when the browser cannot draw the map at all.
 *
 * The second failure with no degraded mode. Mapbox GL v3 asks for a WebGL 2
 * context and throws from its constructor when it does not get one — hardware
 * acceleration switched off, a GPU on the browser's blocklist, a locked-down
 * work machine — and that throw used to escape startApp() before a single
 * control existed, which left exactly the blank page this file was written to
 * replace. Unlike the token, this one IS the visitor's to fix, so it is written
 * to them.
 */
export const WEBGL_PROBLEM = 'This map needs WebGL 2, which this browser has turned off '
  + 'or does not support. Turn on hardware acceleration in your browser settings, or '
  + 'open the page in a current Chrome, Safari, Firefox or Edge.';

/**
 * Whether this browser will refuse the map its WebGL 2 context.
 *
 * Asked before the map is built, because the answer decides whether there is
 * anything to build — and a probe that fails is a sentence on screen, where the
 * constructor's failure was a stack trace in a console. The probe's context is
 * released at once: browsers cap how many a page may hold, and the map is about
 * to want one.
 *
 * A check that itself throws counts as missing. The constructor would have
 * thrown at the same point.
 *
 * @param {Document} [doc]  for tests
 */
export function webglMissing(doc = globalThis.document) {
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    gl.getExtension?.('WEBGL_lose_context')?.loseContext();
    return false;
  } catch {
    return true;
  }
}

/**
 * Put a setup failure on the screen, in place of the map.
 *
 * Styled inline rather than from input.css, and that is deliberate: this runs
 * when the app did not start, and one of the ways an app does not start is that
 * its stylesheet did not load. A message that depends on the thing that might
 * be broken is a message that is not there when it is needed.
 *
 * THE CARD STILL WEARS THE GLASS when it can. Its fill, blur, sheen, rim,
 * radius and ink are the same `--g-card-*` tokens every other card is drawn
 * from, each with the old plain value as its `var()` fallback — so with the
 * stylesheet loaded this is one more card in the app's own material, and
 * without it the fallbacks are exactly the card it used to be. Same blur as
 * the rest, and the same rule: no saturate(), which is not what Apple ships.
 *
 * `role="alert"` so it is announced rather than silently painted, and the
 * colours are drawn from the theme and skin attributes if they were set before
 * the failure — otherwise from the plain defaults, which is the light one.
 *
 * @param {string} message    the sentence from tokenRefusal, or another like it
 * @param {Element} container where to put it; the map's own box by default
 */
export function showSetupProblem(message, container = document.getElementById('map')) {
  if (!container) return null;

  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'position:absolute', 'inset:0', 'display:flex', 'align-items:center',
    'justify-content:center', 'padding:24px', 'box-sizing:border-box',
    'background:var(--g-surface-2,#f3f4f6)', 'color:var(--g-text,#1f2937)',
    'font:400 15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'max-width:34rem', 'padding:20px 22px',
    'background-color:var(--g-card-bg,#fff)',
    'background-image:var(--g-sheen,none)',
    '-webkit-backdrop-filter:var(--g-card-filter,none)',
    'backdrop-filter:var(--g-card-filter,none)',
    'border-radius:var(--g-radius,12px)',
    'box-shadow:var(--g-shadow,0 1px 3px rgba(0,0,0,.16),0 8px 24px rgba(0,0,0,.10)),'
      + 'var(--g-rim,0 0 0 0 transparent)',
  ].join(';');

  const title = document.createElement('p');
  title.textContent = 'This map cannot start.';
  title.style.cssText = 'margin:0 0 8px;font-weight:600;font-size:16px';

  // textContent, not innerHTML. Nothing here is user input today, and the day
  // somebody passes this an error message off the wire it should still be text.
  const body = document.createElement('p');
  body.textContent = message;
  body.style.cssText = 'margin:0;color:var(--g-text-dim,#4b5563)';

  card.append(title, body);
  box.append(card);
  container.replaceChildren(box);
  return box;
}
