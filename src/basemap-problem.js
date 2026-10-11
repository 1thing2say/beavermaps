// What to say when the ground refuses to draw.
//
// Both halves of the provider switch can fail, and until this app was pointed
// at a phone only one of them ever said so.
//
// GOOGLE'S FAILURE ARRIVES AS A REJECTED PROMISE. googleGround() cannot even
// request a tile until a session token has been minted, so a refusal comes back
// once, as one object, carrying Google's own sentence — "API not enabled",
// "referrer not allowed" — and that sentence is what the deployer is shown.
// See addGoogleGround in src/ground.js, and forVisitor below for who else.
//
// MAPBOX'S ARRIVES AS WEATHER. There is no handshake to refuse: the style names
// its sources and the renderer asks for tiles, so a rejected token produces one
// `map.on('error')` event per tile, forever, as the map is panned and zoomed.
// Measured against a real referrer-restricted token on a 390x660 viewport: 29
// events for two camera moves, every one an AJAXError whose `status` is 403,
// whose `url` names api.mapbox.com — and whose `message` is the empty string.
//
// So the app logged twenty-nine blank lines and drew a black rectangle. Worse,
// it logged them from inside an `import.meta.env.DEV` branch, which is to say
// it said nothing whatsoever in a build. The two failures were never different
// in kind; one of them was just louder in a way nobody was listening to.
//
// The point of this file is that a refusal names the way forward. For the
// person setting the app up, "403" and "add this origin to the token" are very
// different sentences. Same rule as the routing refusals in directions.js.
//
// BUT A VISITOR CANNOT ACT ON ANY OF IT, and on the deployed site they are
// nearly everybody who sees it. "Mapbox refused this origin: https://… Add it
// to the token's URL restrictions" is a configuration screen read aloud to the
// public — and Google's own sentences quote the key's settings back. So the
// detailed sentence goes to the console every time, and to the screen only for
// the people who can use it: the dev server, or anybody who opened the page
// with `?debug` (the same switch that opens the back room — see src/debug.js).
// Everybody else gets a plain line. See forVisitor.

/** Every failure here comes from Mapbox's API host; nothing else is ours to explain. */
export const MAPBOX_HOST = 'api.mapbox.com';

/**
 * The one line to put on screen when Mapbox turns a tile request down.
 *
 * The two statuses are measured against the live API rather than read off the
 * documentation, because they are the whole of what this function knows:
 *
 *   401  no token, or a token that is not a token — a rotated key, a typo, an
 *        empty VITE_MAPBOX_TOKEN. The origin is irrelevant; it fails from
 *        localhost too.
 *   403  a real token, refused at this origin. This is the URL-restriction
 *        list, and it is the failure that only ever shows up the first time the
 *        app is opened from somewhere other than localhost — a phone on the
 *        LAN, a tunnel, a deploy.
 *
 * Anything else — a 429, a 500, a tile that simply is not there — gets null.
 * Those are transient or specific to one tile, and a sentence that appeared on
 * screen every time a single tile failed would be noise covering the two cases
 * that actually mean the map is not going to work.
 *
 * @param {number} status  HTTP status Mapbox answered with
 * @param {string} origin  where the app is being served from, to be pasted
 * @returns {string|null}  null when there is nothing useful to say
 */
export function mapboxRefusal(status, origin) {
  if (status === 401) {
    return 'Mapbox rejected the access token. Check VITE_MAPBOX_TOKEN in .env — '
      + 'a rotated or mistyped token fails this way from every origin.';
  }
  if (status === 403) {
    return `Mapbox refused this origin: ${origin}. Add it to the token's URL `
      + 'restrictions, or use a token that has none.';
  }
  return null;
}

/**
 * Whether this page is being looked at by somebody who can act on a detail.
 *
 * The dev server, or a URL carrying `?debug` or `#debug` — read the way
 * src/debug.js reads it, as a query KEY, so a search for something called
 * "debug" cannot switch it on. Not the debug menu's stored state: this is about
 * who is reading the sentence right now, and a link without the flag is a
 * visitor's link.
 *
 * `import.meta.env?.DEV` because node runs this file for the tests with no
 * Vite in front of it, and there `import.meta.env` is undefined.
 *
 * @param {object}  [options]  both injectable, for tests
 * @param {boolean} [options.dev]
 * @param {{search?: string, hash?: string}} [options.location]
 */
export function showsDetail({
  dev = Boolean(import.meta.env?.DEV),
  location = globalThis.location,
} = {}) {
  if (dev) return true;
  try {
    return new URLSearchParams(location?.search ?? '').has('debug')
      || (location?.hash ?? '').replace('#', '') === 'debug';
  } catch {
    return false;
  }
}

/**
 * The sentence to put on screen: the detail for somebody who can use it, the
 * plain line for everybody else. See the note at the top of this file.
 *
 * Does not log. Every caller console.errors the detail itself, next to the
 * error object it came from — which is the thing worth having in a console,
 * and which a string passed through here would have lost.
 *
 * @param {string} detail  what actually went wrong, provider's words included
 * @param {string} plain   what a visitor is told instead
 * @param {object} [options]  see showsDetail
 */
export function forVisitor(detail, plain, options) {
  return showsDetail(options) ? detail : plain;
}

/** What a visitor is told when the map's own tiles are refused. */
export const PLAIN_MAP_PROBLEM = 'The map could not load right now. Please try again later.';

/** ...when Google's ground was refused and the map fell back to Mapbox's. */
// Named by the provider because the layers menu names them that way — its
// toggle reads "Google" and "Mapbox" — so this is the word on the button that
// just flipped back.
export const PLAIN_GOOGLE_FALLBACK = 'The Google basemap is unavailable right now, so the Mapbox one is showing instead.';

/** ...and when the aerial view on a building card cannot be drawn. */
export const PLAIN_AERIAL_PROBLEM = 'Aerial view unavailable right now.';

/**
 * Whether an unhandled rejection is the 3D tileset's root being refused.
 *
 * deck.gl's Tile3DLayer loads its root itself and does not catch what that
 * throws, so a refused root — which src/flyover-view.js has already noticed and
 * said on the card — ALSO arrives as an uncaught rejection: a red line in the
 * console for something the page has handled. loaders.gl's FetchError carries
 * the URL it failed on, so the match is on that URL's host and path rather than
 * on a message, whose wording is the library's and changes. Nothing else is
 * matched: a tile below the root failing, or any other rejection on the page,
 * is still somebody's bug and stays loud.
 *
 * @param {unknown} reason  the rejection's reason
 * @param {string}  rootUrl the tileset root
 */
export function isTilesetRootFailure(reason, rootUrl) {
  const url = reason?.url;
  if (typeof url !== 'string' || !url) return false;
  try {
    const failed = new URL(url);
    const root = new URL(rootUrl);
    return failed.host === root.host && failed.pathname === root.pathname;
  } catch {
    return false;
  }
}
