// Google's ground, painted under Mapbox's renderer.
//
// The Map Tiles API serves plain XYZ raster tiles, which is what makes this a
// small change rather than a rewrite: the provider swap costs one raster source
// and touches nothing else. Routing, the campus sheet, the labels, the pins, the
// 3D buildings and the navigation banner are all our own layers, and none of
// them care what is painted beneath. Loading Google's *JavaScript* SDK instead —
// the obvious reading of "switch to the Google Maps API" — would have meant a
// second renderer on the page and a second implementation of every one of those
// layers, for the same pixels underneath.
//
// Three things about this API are easy to get wrong:
//
//   - Tiles are not addressable by key alone. Every tile request carries a
//     session token minted by POSTing to createSession, and that token encodes
//     the map type, the language and any custom styling. Restyle and you need a
//     new session, which is why the cache below is keyed on the whole request
//     rather than on the map type.
//   - The key has to reach the browser, because it is a query parameter on the
//     tile URL. Nothing here can hide it. The only real protection is an
//     HTTP-referrer restriction set on the key in the Cloud console.
//   - Attribution is not optional and is not a constant: Google serves the
//     required copyright line per viewport, because whose data is under you
//     changes with where you are looking.

const CREATE_SESSION = 'https://tile.googleapis.com/v1/createSession';
const TILES = 'https://tile.googleapis.com/v1/2dtiles';
const VIEWPORT = 'https://tile.googleapis.com/tile/v1/viewport';

/** Our basemap toggle's vocabulary, in Google's. */
export const GOOGLE_MAP_TYPE = {
  map: 'roadmap',
  satellite: 'satellite',
};

// Shown until the viewport call answers, and kept if it never does. Google
// requires an attribution; a slightly less specific one beats none, and beats
// blocking the basemap on a second network round trip.
const FALLBACK_ATTRIBUTION = 'Map data ©Google';

/**
 * Dark styling for the roadmap tiles under the CLASSIC look, in Google's own
 * style-array schema.
 *
 * Without this the dark theme would be a seam: our overlay drawn in near-black
 * inside the campus, Google's daylight roadmap everywhere outside it, and the
 * mask edge dividing them. The values are lifted straight off THEMES.dark so the
 * two agree — but off the *targets*, not the numbers in `basemapConfig`. Those
 * are authored ~1.33x light to survive Mapbox Standard's night lighting, and a
 * raster tile has no lighting to survive.
 *
 * Only the roadmap is styled. Satellite imagery has no geometry to recolour.
 */
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#212121' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa0a6' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#3f4448' }] },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#d0d3d6' }],
  },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#9aa0a6' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1d2f24' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#4fbe90' }] },
  // Fill lighter than the land and stroke darker, which is the inversion that
  // keeps a network legible once everything else has gone to near-black. Same
  // pair of values the campus network is drawn with.
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#3c4043' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#191919' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9aa0a6' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#5f5340' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#191919' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3336' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17313f' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a6a7a' }] },
];

/**
 * The same job for the Apple look, and a bigger one: this styles the LIGHT map
 * too, where the classic look could leave it alone.
 *
 * Google's daylight roadmap already agrees with our classic palette closely
 * enough to need no styling at all — the campus sheet was drawn from a Google
 * Maps screenshot in the first place. It agrees with Apple's about nothing: the
 * land is neutral where Apple's is warm, the greens are mint where Apple's are
 * yellow, and the labels are slate where Apple's are black. Left unstyled, the
 * campus would sit on it as an obviously foreign patch.
 *
 * Values are the same table as APPLE in main.js, straight across. Roads are the
 * one place the two deliberately differ: a road here is a *road*, and Apple
 * draws those white with a grey casing, while the grey ribbon inside the campus
 * is what they use for a path. The distinction is theirs, and keeping it is what
 * makes the boundary read as campus-versus-city rather than as a seam.
 *
 * Unlike main.js's night table these are targets rather than pre-compensated
 * values: a raster tile arrives already lit, and there is no light preset in
 * front of it to correct for.
 */
const APPLE_LIGHT_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#efece2' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#000000' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#fefdf6' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#d9d5c8' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#e3ecd2' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#bee298' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#40631f' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#dfdfda' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6f6d65' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#f6d5a2' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#e9c58e' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#e0ded4' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#9fd2f6' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a7f9e' }] },
];

const APPLE_DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#2f2e2a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#ddddd9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1e1e1b' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#494741' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#333429' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#36412a' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#98b17d' }] },
  // The same inversion the campus network uses at night: the ways go lighter
  // than the ground rather than darker, with a near-black edge under them.
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#4e4e4b' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1e1e1b' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#a2a09b' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#503f2b' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1e1e1b' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#3a3934' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#1c3d4f' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#5d8296' }] },
];

/**
 * Which style array a look wants for a theme.
 *
 * The classic light entry is empty on purpose rather than missing: Google's own
 * daylight roadmap IS the classic light palette, so there is nothing to say.
 * Writing it out keeps the table total, so a new theme or look is a row here
 * rather than a lookup that quietly falls through to unstyled tiles.
 */
export const GROUND_STYLE = {
  classic: { light: [], dark: DARK_STYLE },
  apple: { light: APPLE_LIGHT_STYLE, dark: APPLE_DARK_STYLE },
};

/**
 * Nobody else's business on a campus map.
 *
 * Google's roadmap labels every organisation it knows about, and around my campus that
 * is a mortgage broker, an HVAC firm, a dog trainer, an adult school and the
 * SALAM Islamic Center — none of which have anything to do with the college, and
 * all of which read, on a map that is otherwise entirely my campus's, as though they
 * were part of it. A wayfinder for one campus should not be quietly advertising
 * its neighbours.
 *
 * It has to be done HERE and not by clipping. Everywhere else this app removes
 * the basemap's own data with a `clip` layer over the campus polygon, but that
 * only works on vector features: Google's are painted into the raster before it
 * reaches us, and a tile is a picture. The session request is the only place a
 * label can still be talked out of existing — which is also why this costs a new
 * session token rather than a style change, and why the cache below is keyed on
 * everything that goes into the body.
 *
 * `labels` rather than the whole feature, so parkland keeps its green: the fill
 * is geography and only the name is an establishment. Compare the two renders
 * and that is the entire difference — the green shapes are identical, the words
 * on top of them are gone.
 *
 * Park names were an exception here for one draft, on the reasoning that a park
 * is a place rather than an organisation. Rendering it settled it: what Google
 * prints over the green west of campus is "Arcade Creek Recreation & Park
 * District", which is a public agency with a board and a budget. There is no
 * line to draw between the kinds of organisation, so none is drawn.
 */
const NO_ORGANISATIONS = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
];

/**
 * A session per distinct request, held for as long as Google says it is good
 * for. Sessions last about two weeks, so re-minting one on every provider
 * toggle would be a wasted round trip before the first tile could be asked for.
 *
 * The promise is cached rather than the result, so two toggles in quick
 * succession share one in-flight request instead of racing to mint two.
 */
const sessions = new Map();

function sessionBody(mapType, theme, skin) {
  const body = {
    mapType,
    language: 'en-US',
    region: 'US',
    // Billing is per tile request, not per byte, so the sharper tile is free.
    // Mapbox samples the 512px image into a 256-unit tile slot, which is what
    // makes labels on Google's raster hold up next to our vector ones.
    ...(window.devicePixelRatio > 1 ? { scale: 'scaleFactor2x', highDpi: true } : {}),
  };
  // Only the roadmap carries styling; satellite imagery has no geometry or
  // labels of its own to restyle. The dark palette goes first so the POI rules
  // land after it and win — a `poi` colour set above must not put back a label
  // this has just switched off.
  if (mapType === 'roadmap') {
    const ground = (GROUND_STYLE[skin] ?? GROUND_STYLE.classic)[theme] ?? [];
    body.styles = [...ground, ...NO_ORGANISATIONS];
  }
  return body;
}

async function mintSession(key, mapType, theme, skin) {
  const response = await fetch(`${CREATE_SESSION}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody(mapType, theme, skin)),
  });

  // Google puts the actionable part in the body, not the status line: a
  // disabled API and a referrer-rejected key are both 403, and only the message
  // says which. Surfacing it is the whole difference between "enable Map Tiles
  // API in the console" and a blank grey rectangle.
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `createSession failed (HTTP ${response.status})`);
  }
  if (!payload?.session) throw new Error('createSession returned no session token');
  return payload;
}

function session(key, mapType, theme, skin) {
  const id = `${mapType}:${theme}:${skin}`;
  const cached = sessions.get(id);
  // `expiry` is a unix timestamp in seconds, as a string. A minute of slack, so
  // a session cannot expire between this check and the tile requests it feeds.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.promise;

  const promise = mintSession(key, mapType, theme, skin);
  // Assume the documented two weeks until the response says otherwise, then
  // correct. Guessing short is safe — the worst case is one extra mint.
  const entry = { promise, expiresAt: Date.now() + 12 * 24 * 3600 * 1000 };
  sessions.set(id, entry);

  promise
    .then((payload) => {
      if (payload.expiry) entry.expiresAt = Number(payload.expiry) * 1000;
    })
    // A failed mint must not be cached, or enabling the API in the console
    // would not fix the map until a reload.
    .catch(() => sessions.delete(id));

  return promise;
}

/**
 * Google's required copyright line for the area being shown.
 *
 * Best-effort by design: it is an extra round trip on a separate endpoint, and
 * a basemap that will not draw because its attribution string is late is a
 * worse outcome than a slightly generic attribution.
 */
// Keyed on the session, because the copyright is a property of what that
// session serves. Without this every provider toggle paid a second round trip
// for a string that had not changed since the first one.
const attributions = new Map();

async function attribution(key, token, bounds, zoom) {
  if (!attributions.has(token)) attributions.set(token, fetchAttribution(key, token, bounds, zoom));
  return attributions.get(token);
}

async function fetchAttribution(key, token, [[west, south], [east, north]], zoom) {
  const query = new URLSearchParams({
    session: token,
    key,
    zoom: String(zoom),
    north: String(north),
    south: String(south),
    east: String(east),
    west: String(west),
  });
  try {
    const response = await fetch(`${VIEWPORT}?${query}`);
    if (!response.ok) return FALLBACK_ATTRIBUTION;
    const payload = await response.json();
    return payload?.copyright || FALLBACK_ATTRIBUTION;
  } catch {
    return FALLBACK_ATTRIBUTION;
  }
}

/**
 * Everything `map.addSource` needs for a Google raster basemap.
 *
 * Rejects with Google's own message when the key, the project or the referrer
 * restriction is wrong, so the caller can put that message in front of the user
 * instead of leaving them with an empty map and no reason for it.
 *
 * @param {object}   options
 * @param {string}   options.key      Browser API key, referrer-restricted.
 * @param {string}   options.basemap  'map' | 'satellite'.
 * @param {string}   options.theme    'light' | 'dark'.
 * @param {string}   options.skin     'apple' | 'classic'.
 * @param {number[][]} options.bounds [[w, s], [e, n]], for the attribution call.
 */
export async function googleGround({ key, basemap, theme, skin, bounds }) {
  if (!key) throw new Error('No Google Maps API key — set VITE_GOOGLE_MAPS_KEY in .env');

  const mapType = GOOGLE_MAP_TYPE[basemap] ?? GOOGLE_MAP_TYPE.map;
  const { session: token } = await session(key, mapType, theme, skin);
  const auth = `session=${encodeURIComponent(token)}&key=${encodeURIComponent(key)}`;

  return {
    type: 'raster',
    tiles: [`${TILES}/{z}/{x}/{y}?${auth}`],
    // The scheme, not the image. Google's 2dtiles are standard web-mercator
    // XYZ, so each one covers a 256-unit slot however many pixels it arrives
    // with — telling Mapbox 512 here would cost a whole zoom level of detail.
    tileSize: 256,
    // Measured against the live endpoint over my campus rather than taken from the
    // docs: 18-22 all return real tiles, 23 is a hard 400 "Invalid Value".
    // Setting this short is not free — Mapbox would oversample the last level
    // it thinks exists and blur the deepest navigation zooms.
    maxzoom: 22,
    attribution: await attribution(key, token, bounds, 17),
  };
}
