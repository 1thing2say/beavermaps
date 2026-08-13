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

/*
 * Apple's night ground, and the one place in this app where it is actually SEEN
 * as Apple draws it.
 *
 * The Standard basemap's night preset takes about four fifths back out of
 * whatever it is given — see the note on APPLE.dark.basemapConfig — so on that
 * path the city around the campus lands near black whatever is written. A
 * raster tile arrives already lit and there is no preset in front of it, so
 * these are targets: what is written here is what appears. Under the Google
 * provider this table IS the dark map.
 *
 * Cool blue-grey, not the warm olive this used to be. See APPLE.dark in
 * palette.js for what changed and why; the values are the same ones, and they
 * have to stay the same ones — the campus overlay is drawn on top of these
 * tiles and a warm campus on a cool city is a seam at the boundary.
 */
const APPLE_DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#3c4c5e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#e6e8ec' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#20242e' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#67788e' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#155658' }] },
  // Apple does not set a night map in one ink. A place name is near-white, a
  // street name is the blue #bdcdea below, and a POI is coloured by what it
  // SELLS: measured off the reference, a shop is #f6df73 at C 55.4, a clinic
  // #ff8e92 at C 46.2, a park #7de08c at C 56.6. Three inks at three times the
  // chroma of anything we were setting, and the reason their city reads as
  // populated where ours read as a wiring diagram.
  //
  // Google's raster gives us one ink per feature type rather than per category,
  // so this takes the two the schema can address. `poi` has to come BEFORE
  // `poi.park` — these rules resolve last-match-wins, not most-specific-wins.
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#f6df73' }] },
  { featureType: 'poi.medical', elementType: 'labels.text.fill', stylers: [{ color: '#ff8e92' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#00615b' }] },
  // The same green the campus prints its own area names in, so a park label
  // does not change colour at the boundary. Lifted off Apple's #7de08c for the
  // contrast reason set out beside `areaLabel` in src/palette.js.
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#95f8a2' }] },
  // GROUND, not buildings — and this one line was most of why the city around
  // campus came out a pale lavender field with the college sitting on it as a
  // dark stain, which is the exact inverse of the reference.
  //
  // `landscape.man_made` reads like "the built things" and is not: in Google's
  // schema it is all developed LAND, so nearly every block outside the campus
  // was being painted in the building colour. Google has no separate building
  // feature to move that colour onto, so the pale-block effect lives where we
  // have real footprints — on the campus sheet — and out here the city is
  // simply ground, which is what it reads as on the reference anyway.
  // The city outside, and it is the one ground colour the reference gives us
  // TWICE: L 31.9 out here against L 31.7 under the campus. Two tenths of a
  // point apart in lightness, and told apart only by chroma — 16.1 against
  // 12.6, the city very slightly the bluer of the two. That is the whole
  // treatment, and it is worth being exact about in both directions: matched
  // any closer and the campus is a hole where the map failed to load, pushed
  // any further and the boundary becomes a seam between two maps.
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#374d64' }] },
  // The city was reading as an empty field: a third of the frame, one flat
  // slate, with nothing on it but a web of roads. The obvious fix is building
  // footprints and this API will not give them — painting
  // `landscape.man_made` geometry.stroke a loud magenta and counting the
  // result put ZERO pixels on screen, as did landscape.natural.landcover.
  // Google's raster has no block-level detail here to reveal at this zoom.
  //
  // What it does have is POI polygons, which the same probe found covering
  // about five per cent of the frame — the schools, the golf course and the
  // shopping parcels around the campus. A step off the land gives the city
  // some parcel structure without inventing anything. It stays a small step:
  // at five per cent of the frame a strong tint reads as blotching.
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#415367' }] },
  // LIGHT ribbons, and the note that used to be here was measured at the wrong
  // zoom. It said "dark ribbons — measured at L 21.6, the darkest thing on
  // Apple's night map", which is true and is about z17 and closer.
  //
  // Apple inverts the network between z16 and z17. Counting the two tones
  // across three captures of the same place: the light #526074 is 4.65% of the
  // frame at z16 and 0.02% at z17, and the dark #313d4d is 0.87% at z16 and
  // 1.76% at z17. At overview zooms the network is a DIAGRAM — light lines you
  // navigate by, over dark land — and only when you are close enough for a
  // street to have width does it become asphalt.
  //
  // These tiles cannot follow that. A Google style is fixed for the life of a
  // session token, so one value has to serve every zoom, and the zoom to serve
  // is the one where the city is the subject: this app opens at z15.79, where
  // the dark value left the surroundings a flat empty field with a campus
  // sitting on it. Above z17 the city is a margin a few hundred pixels wide,
  // mostly behind the panel, and it stays a shade light there. That is the
  // trade, taken deliberately and in the direction of the opening view.
  // Google's roads are drawn about twice Apple's width at this zoom — a cut
  // across a residential street measures 8 px against the reference's 4 — and
  // that is not adjustable from here. `weight` is the only width control the
  // style schema offers, it applies to `geometry.stroke`, and it does nothing
  // to the fill: at weight 1 the cut came back byte-identical, and at weight 5
  // createSession fails and the whole provider falls back to Standard. The
  // colour is exact and the width is Google's; that is the deal with a raster.
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#526074' }] },
  // Barely a casing. The reference draws none — a cross-section of a residential
  // street at z16 is 2 to 4 px of flat #526074 with nothing but antialiasing at
  // its edges — so this sits close enough to the fill to shape the ribbon
  // without drawing an outline around it.
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#46536a' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#bdcdea' }] },
  // One tier of hierarchy, which is the other half of why the city looked
  // flat: every street was drawn at the one value, so a four-lane arterial and
  // a cul-de-sac were the same mark. Apple's night map lifts the bigger road
  // rather than widening it — and now that the base is light, lifting still
  // means lighter. Only the arterials move.
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#5b6a80' }] },
  { featureType: 'road.arterial', elementType: 'geometry.stroke', stylers: [{ color: '#4d5b71' }] },
  // Highways keep a warm cast at night on Apple's map, the one thing that does.
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#6b5b3f' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#353948' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#3b4f67' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#1c347a' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#8fa6d6' }] },
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

/**
 * What makes one session distinct from another, and the key both caches use.
 *
 * A finite set — two map types over two themes over two skins — which is the
 * property the attribution cache below leans on to stay bounded.
 */
const sessionId = (mapType, theme, skin) => `${mapType}:${theme}:${skin}`;

function session(key, mapType, theme, skin) {
  const id = sessionId(mapType, theme, skin);
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
// Cached because the copyright is a property of what a session serves, and
// without this every provider toggle paid a second round trip for a string that
// had not changed since the first one.
//
// Keyed on the session ID and holding the token it was fetched under, rather
// than keyed on the token itself. Those are the same cache while a session
// lasts; they differ when one is re-minted, because a token is a fresh opaque
// string every time. Keyed on the token, a re-mint added a row and orphaned the
// old one — unbounded in principle, and only bounded in practice by sessions
// outliving the tab. Keyed this way it replaces its own row, so the map holds
// at most one entry per mapType/theme/skin and a stale copyright cannot survive
// the session it described.
const attributions = new Map();

async function attribution(key, id, token, bounds, zoom) {
  const cached = attributions.get(id);
  if (cached?.token === token) return cached.promise;

  // Safe to cache before it settles: fetchAttribution resolves to the fallback
  // on every failure path rather than rejecting, so there is no rejected promise
  // to get stuck in here.
  const promise = fetchAttribution(key, token, bounds, zoom);
  attributions.set(id, { token, promise });
  return promise;
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
  const id = sessionId(mapType, theme, skin);
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
    attribution: await attribution(key, id, token, bounds, 17),
  };
}
