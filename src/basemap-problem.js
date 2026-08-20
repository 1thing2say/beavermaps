// What to say when the ground refuses to draw.
//
// Both halves of the provider switch can fail, and until this app was pointed
// at a phone only one of them ever said so.
//
// GOOGLE'S FAILURE ARRIVES AS A REJECTED PROMISE. googleGround() cannot even
// request a tile until a session token has been minted, so a refusal comes back
// once, as one object, carrying Google's own sentence — "API not enabled",
// "referrer not allowed" — and that sentence goes straight to the panel. See
// addGoogleGround in main.js.
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
// The point of this file is that a refusal names the way forward. A visitor
// cannot act on any of this, but the person setting the app up is the only one
// who will ever see it, and for them "403" and "add this origin to the token"
// are very different sentences. Same rule as the routing refusals in
// directions.js.

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
