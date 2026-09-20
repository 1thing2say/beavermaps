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
 * Put a setup failure on the screen, in place of the map.
 *
 * Styled inline rather than from input.css, and that is deliberate: this runs
 * when the app did not start, and one of the ways an app does not start is that
 * its stylesheet did not load. A message that depends on the thing that might
 * be broken is a message that is not there when it is needed.
 *
 * `role="alert"` so it is announced rather than silently painted, and the
 * colours are drawn from the theme attribute if one was set before the failure
 * — otherwise from the plain defaults, which is the light one.
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
    'background:#f3f4f6', 'color:#1f2937',
    'font:400 15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'max-width:34rem', 'background:#fff', 'border-radius:12px', 'padding:20px 22px',
    'box-shadow:0 1px 3px rgba(0,0,0,.16),0 8px 24px rgba(0,0,0,.10)',
  ].join(';');

  const title = document.createElement('p');
  title.textContent = 'This map cannot start.';
  title.style.cssText = 'margin:0 0 8px;font-weight:600;font-size:16px';

  // textContent, not innerHTML. Nothing here is user input today, and the day
  // somebody passes this an error message off the wire it should still be text.
  const body = document.createElement('p');
  body.textContent = message;
  body.style.cssText = 'margin:0;color:#4b5563';

  card.append(title, body);
  box.append(card);
  container.replaceChildren(box);
  return box;
}
