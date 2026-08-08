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
 * Dark styling for the roadmap tiles, in Google's own style-array schema.
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
 * A session per distinct request, held for as long as Google says it is good
 * for. Sessions last about two weeks, so re-minting one on every provider
 * toggle would be a wasted round trip before the first tile could be asked for.
 *
 * The promise is cached rather than the result, so two toggles in quick
 * succession share one in-flight request instead of racing to mint two.
 */
const sessions = new Map();

function sessionBody(mapType, theme) {
  const body = {
    mapType,
    language: 'en-US',
    region: 'US',
    // Billing is per tile request, not per byte, so the sharper tile is free.
    // Mapbox samples the 512px image into a 256-unit tile slot, which is what
    // makes labels on Google's raster hold up next to our vector ones.
    ...(window.devicePixelRatio > 1 ? { scale: 'scaleFactor2x', highDpi: true } : {}),
  };
  if (mapType === 'roadmap' && theme === 'dark') body.styles = DARK_STYLE;
  return body;
}

async function mintSession(key, mapType, theme) {
  const response = await fetch(`${CREATE_SESSION}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody(mapType, theme)),
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

function session(key, mapType, theme) {
  const id = `${mapType}:${theme}`;
  const cached = sessions.get(id);
  // `expiry` is a unix timestamp in seconds, as a string. A minute of slack, so
  // a session cannot expire between this check and the tile requests it feeds.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.promise;

  const promise = mintSession(key, mapType, theme);
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
 * @param {number[][]} options.bounds [[w, s], [e, n]], for the attribution call.
 */
export async function googleGround({ key, basemap, theme, bounds }) {
  if (!key) throw new Error('No Google Maps API key — set VITE_GOOGLE_MAPS_KEY in .env');

  const mapType = GOOGLE_MAP_TYPE[basemap] ?? GOOGLE_MAP_TYPE.map;
  const { session: token } = await session(key, mapType, theme);
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
