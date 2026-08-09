// The two looks, as value tables.
//
// Pure data and two pure functions over it: no DOM, no map, no imports. That is
// the point of the file rather than an accident of it — these tables decide what
// every layer on the map is coloured, and until they lived somewhere importable
// the only way to check one against another was to read them. See
// test/skin.test.js, which is now able to assert the things that used to be
// promised in comments: that a skin overrides every colour it claims to, that
// the ground the campus is drawn on matches the ground drawn around it, and that
// a label is legible on every surface it can land on.

// Mapbox Standard rather than the classic light-v11/dark-v11 pair. Standard is
// a style *package*: its internal layers are not addressable, so nothing here
// can call removeLayer or setFilter on the basemap. What it gives back is a
// configuration API and named slots to insert into, which is what the campus
// mask below is built on.
//
// It also collapses light and dark into one style under two light presets, so
// the theme toggle is now a config change rather than a setStyle. Custom
// sources and layers survive it instead of being rebuilt.
export const STANDARD = 'mapbox://styles/mapbox/standard';

// Per-theme layer colours, tuned to read like Google Maps.
//
// The reference is Google's own hierarchy, which is what makes their sheets
// legible at a glance: pale neutral ground, saturated green for planting, and
// circulation drawn *lighter* than the ground it crosses. Nothing on a Google
// map is a bare line — every road is a white ribbon inside a grey casing, and
// that casing is what separates it from the land without needing a hue of its
// own.
//
// This replaces a palette that gave the network a deliberate blue cast so it
// read as *our* data rather than Mapbox's. That was right while the campus was
// bare, and wrong now that my campus's drawn pavement sits underneath it: the ribbon
// and the pavement are the same paths and have to look like one thing.
//
// `mask` is the colour painted over the campus once Mapbox's own data inside it
// has been taken out. It is deliberately a shade off the surrounding land
// rather than an exact match: matching exactly would make the campus look like
// a hole where the map failed to load, and would drift the moment Mapbox
// retunes Standard.
//
// These render as authored only because the mask sets fill-emissive-strength.
// Without it Standard lights the fill through its own lighting model, and under
// the `night` preset that swallowed it: an authored #141922 came back as
// #0e111d, and raising the authored value threefold moved the rendered pixel by
// about a tenth — so it is not a multiply that can be pre-compensated for. The
// fix belongs in the paint spec, not in these numbers.
//
// `land` recolours the printed my campus sheet. It is keyed by the `kind` written by
// scripts/build-basemap.mjs, and a kind with no entry here keeps my campus's own print
// colour, which is the right fallback for the things that have no theme opinion
// — court markings, sign faces, the HOME BASE badges — and the wrong one for
// ground, so every ground class needs a key.
//
// `basemapConfig` is the same palette pushed into Mapbox Standard's own
// configuration, so the city around the campus is drawn in Google's colours
// too. Without it the mask edge is a visible seam between two different maps.
//
// IMPORTANT: those values are NOT emissive, so unlike everything above they go
// through Standard's lighting. The night set is therefore authored light and
// lands dark — see the note on the dark palette.
export const THEMES = {
  dark: {
    style: STANDARD,
    lightPreset: 'night',
    // Google's dark map inverts the light one's contrast: roads are lighter
    // than the land rather than darker, which is what keeps the network
    // readable when everything else has gone to near-black.
    network: '#3c4043',
    networkCasing: '#191919',
    casing: '#174ea6',
    route: '#4285f4',
    building: '#2f3336',
    buildingLine: '#3f4448',
    mask: '#212121',
    // Same two hues, inverted for a dark ground: the slate lightens and the
    // greenspace teal is lifted rather than re-hued.
    label: '#c6d1dc',
    labelHalo: '#1a1a1a',
    areaLabel: '#4fbe90',
    // Pitch and court markings. my campus prints them white, which at
    // fill-emissive-strength 1 glares against night ground.
    sportLine: '#5a6b52',
    parkingLabel: '#9aa0a6',
    // What a legend row paints on the shapes it is asking about.
    //
    // Purple because every other meaning on this map is already spoken for:
    // blue is the route, green the start pin, red the destination, white the
    // path ribbon, cream the buildings. A hue nothing else uses cannot be
    // mistaken for a route or a marker, which matters when the thing it is
    // drawn on top of is a whole car park.
    //
    // Lightened for the night ground rather than re-hued, the same way the
    // label and greenspace colours are.
    highlight: '#c58af9',
    land: {
      lawn: '#1d2f24',
      tree: '#274934',
      shrub: '#223a2b',
      paving: '#2b2b2b',
      parking: '#262626',
      parking_stripe: '#333333',
      walkway: '#3c4043',
      driveway: '#35393c',
      offsite_road: '#2f3234',
      crossing: '#4a4d50',
      sport: '#223529',
      track: '#3a2e26',
      closed: '#2a2a2a',
      pool: '#17313f',
      building: '#2f2f2f',
    },
    // Authored lighter than the target, because the night preset lands these
    // well below their written value — the same lighting that forced
    // fill-emissive-strength on the layers above. Our own fills opt out of it;
    // Standard's config cannot, so it is pre-compensated here instead.
    //
    // The ~1.33x this was originally authored at is not enough, and the note
    // that used to claim these arrive "at roughly three quarters" was wrong:
    // sampling the rendered land outside the campus puts colorLand at #08090c,
    // which is 0.18 of the #2c2c2c written here, not 0.75. See the note on the
    // Apple night table for why that gap cannot be closed from this end.
    basemapConfig: {
      colorLand: '#2c2c2c',        // renders ~#08090c, not the ~#212121 intended
      colorGreenspace: '#273f30',
      colorWater: '#1f4254',
      colorRoads: '#50555a',       // -> ~#3c4043, lighter than the land
      colorMotorways: '#5f5340',
      colorTrunks: '#544c3d',
      colorBuildings: '#3f3f3f',
      colorRoadLabels: '#9aa0a6',
      colorPlaceLabels: '#d0d3d6',
      colorPointOfInterestLabels: '#9aa0a6',
      roadsBrightness: 1,
    },
  },
  light: {
    style: STANDARD,
    lightPreset: 'day',
    // The Google road: white core, grey casing. Both are drawn from the same
    // source in addNetworkLayers, the casing simply wider and underneath.
    network: '#ffffff',
    networkCasing: '#d2d5d9',
    // Google's navigation blue, and the darker blue they case it with.
    casing: '#1967d2',
    route: '#4285f4',
    // Campus buildings on Google are a warm cream, distinct from the neutral
    // grey they give ordinary city blocks. That contrast is most of what makes
    // an institution read as one place rather than a district.
    building: '#e8e0cd',
    buildingLine: '#d8cfb8',
    mask: '#f1f1ef',
    // Sampled off the screenshot, not assumed. Google's label ink is a cool
    // blue-grey slate (H 195-212, L~38%), not the neutral charcoal #3c4043 an
    // earlier pass used; and their greenspace names are the same teal-green as
    // their park icons, #17a773, not an olive.
    label: '#42586b',
    labelHalo: '#ffffff',
    areaLabel: '#17a773',
    sportLine: '#ffffff',
    parkingLabel: '#67788a',
    // Google's own purple, which is the saturated end of the same hue the dark
    // theme lifts. See the note there for why this map had a spare colour.
    highlight: '#a142f4',
    land: {
      // Sampled off a Google Maps screenshot of a comparable campus rather than
      // picked by eye. Google's greens are not the yellow-olive you get by
      // reaching for "grass": they sit at hue 143 — a cool mint — at 79-90%
      // lightness, and they use exactly three tiers by area. An earlier pass
      // authored these around hue 94-108, which is what made the campus read as
      // heavily green when 62% of its surface is planting.
      // Assigned by AREA, not by how dense the thing is in life. my campus's sheet
      // draws 509 individual tree canopies over the lawn, so putting trees on
      // Google's darkest tier made that tier 41% of our green where it is 11%
      // of theirs — the same three colours reading far heavier. Trees take the
      // middle tier and the rare shrubs take the dark one, which lands our
      // proportions near Google's while still using their exact values.
      lawn: '#d3f8e2',   // Google's 67.9% tier: the base park fill
      tree: '#c3f1d5',   // their 15.6% tier: 509 canopies, one step down only
      shrub: '#a9eac2',  // their 11.0% tier: 46 features, so it stays rare
      paving: '#f0f0ee',
      parking: '#eaeaea',
      parking_stripe: '#f7f7f7',
      // Pavement is left white and the grey arrives as the network casing on
      // top, exactly as Google builds a road. Colouring the pavement grey as
      // well would double the casing and thicken every path.
      walkway: '#ffffff',
      driveway: '#ffffff',
      offsite_road: '#ffffff',
      crossing: '#e9e9e9',
      sport: '#c3f1d5',
      track: '#e3c9b6',
      closed: '#e4e4e4',
      pool: '#a5d8f3',
      building: '#e8e0cd',
    },
    basemapConfig: {
      colorLand: '#f3f3f1',
      colorGreenspace: '#d3f8e2',
      colorWater: '#a5d8f3',
      colorRoads: '#ffffff',
      colorMotorways: '#fbd9a0',
      colorTrunks: '#fce8c2',
      colorBuildings: '#e9e6df',
      colorRoadLabels: '#5f6368',
      colorPlaceLabels: '#3c4043',
      colorPointOfInterestLabels: '#5f6368',
      // Default is 0.4, which greys Standard's roads down until they read as
      // land. Google's do not — they are the brightest thing on the sheet.
      roadsBrightness: 1,
    },
  },
};

/**
 * The label face for each look, in the three weights the map asks for.
 *
 * Roboto is the face Google Maps actually sets its labels in, and Mapbox serves
 * it from its own font endpoint, so it costs no webfont and no extra request
 * from the page.
 *
 * Apple's SF Pro is not ours to serve, and the endpoint agrees: "SF Pro Text
 * Regular" and "Helvetica Neue Regular" both 404 there — licensed faces Mapbox
 * does not host — while Inter Regular, Medium and Bold all return 200, which is
 * exactly the three this table needs. Inter was drawn in the same neo-grotesque
 * line as SF and is the closest face available. The browser chrome still asks
 * for the real thing first (see --g-font in input.css), because on a Mac it is
 * already installed; only the labels Mapbox rasterises are stuck with the
 * substitute.
 *
 * The fallback in each stack is the Arial Unicode face Mapbox ships for glyphs
 * the primary has no coverage for; without it a missing codepoint is tofu.
 */
export const FONTS = {
  classic: {
    regular: ['Roboto Regular', 'Arial Unicode MS Regular'],
    medium: ['Roboto Medium', 'Arial Unicode MS Regular'],
    bold: ['Roboto Bold', 'Arial Unicode MS Bold'],
  },
  apple: {
    regular: ['Inter Regular', 'Arial Unicode MS Regular'],
    medium: ['Inter Medium', 'Arial Unicode MS Regular'],
    bold: ['Inter Bold', 'Arial Unicode MS Bold'],
  },
};

// Imagery is dark, busy and its own fixed brightness, so it does not follow the
// light/dark theme and needs high-contrast line colours of its own.
export const SATELLITE = {
  style: 'mapbox://styles/mapbox/standard-satellite',
  lightPreset: 'day',
  // Sky blue rather than white: the imagery basemap draws its own roads in
  // cream, and a white network is indistinguishable from them over pale roofs.
  network: '#38bdf8',
  // Google cases its roads over imagery too, but with near-black instead of
  // grey — a photograph has no reliable background value to sit a light casing
  // against, and the dark one reads over pale roofs and dark tarmac alike.
  networkCasing: '#0b1220',
  casing: '#0b1220',
  route: '#facc15',
  building: '#94a3b8',
  // No fill mask over imagery — seeing the ground is the entire point of this
  // basemap, so here the campus only gets the clip, which removes Mapbox's
  // labels and 3D objects while leaving the photograph intact.
  mask: null,
  // Same reasoning for the ground cover: painting my campus's lawns and car parks over
  // a photograph of the actual lawns and car parks hides the better data. The
  // amenity symbols and place labels stay, because the imagery carries neither.
  land: null,
  buildingLine: null,
  label: '#ffffff',
  labelHalo: '#101828',
  areaLabel: '#ffffff',
  parkingLabel: '#dbeafe',
  // Lighter again than the dark theme's. A photograph has no flat ground value
  // to sit a mid-tone against — foliage, tarmac and pale roofs are all in one
  // frame — so the outline goes bright and lets the fill do the tinting.
  highlight: '#d8b4fe',
};

/**
 * The same campus, drawn in Apple's cartography.
 *
 * Sampled off a macOS Maps capture, and the sampling turned up a structural
 * difference between the two systems rather than a set of nicer colours.
 * Measuring the four ground colours the capture actually contains, in CIE Lab:
 *
 *     park green   #bee298   L 85.8  C 40.6  h 127
 *     sand         #efe7cb   L 91.6  C 14.7  h  97
 *     path grey    #dfdfda   L 88.7  C  2.6  h 110
 *     label halo   #fefdf6   L 99.2  C  3.6  h 104
 *
 * Every one of them sits in a 30-degree hue band, within 6 points of lightness
 * of the others, and they are told apart almost entirely by CHROMA — a 16x
 * range, from 2.6 to 40.6. Google's ground does the opposite: run the same
 * numbers over THEMES.light and the hue spread is 149 degrees (mint greens at
 * 157, water at 241, cream buildings at 92) with chroma held under 32.
 *
 * So this table is not "Apple's colours" — those are four values and this needs
 * thirty. It is that rule, applied: one hue family, one narrow lightness band,
 * meaning carried by saturation. The four measured values are used exactly as
 * measured and the rest are placed on the same axis, which is why every entry
 * below carries the Lab coordinates it was built from. Water is the one
 * deliberate exception, because no rule about a warm ground can produce a blue.
 *
 * The dark half has no capture behind it. Rather than guess at Apple's night
 * palette it applies the same measured rule at a lower lightness band, which is
 * a derivation from the thing that was measured instead of a second guess.
 */
export const APPLE = {
  light: {
    style: STANDARD,
    lightPreset: 'day',
    // Apple draws a park path as one flat band with a single darker edge, not
    // as Google's white core in a grey casing. Both values are straight off the
    // capture's cross-section: 44 rows of #dfdfda with #cccbc4 at the boundary.
    network: '#dfdfda',
    networkCasing: '#cbcbc5',   // L 81.5 C 3.0 h 105
    casing: '#045cbb',
    route: '#007aff',           // systemBlue
    building: '#e5e0cf',        // L 89.0 C 9.0 h 97
    buildingLine: '#d4cfbc',    // L 83.0 C 10.0 h 97
    mask: '#efece2',            // L 93.5 C 5.5 h 100
    // Measured, and genuinely pure black: 271 of the pixels in the "Seely Park"
    // label are #000000 exactly. Apple sets place names in black on a warm
    // off-white halo, where Google uses a blue-grey slate on pure white.
    label: '#000000',
    labelHalo: '#fefdf6',       // measured
    // L 41.0 C 42.0 h 127 — the park green, deepened. Placed by contrast
    // rather than by the band: at L 45 it measured 2.95:1 on the shrub tier
    // it is printed over, which is under the 3 a large label is held to.
    areaLabel: '#476a26',
    sportLine: '#f7f7f1',
    // L 46.0 C 5.0 h 100. Placed by contrast rather than by the lightness band:
    // at the band's own L 52 it measured 3.07:1 on the car park it names, where
    // the classic look manages 3.77. This is the lightness that matches it.
    parkingLabel: '#6f6d65',
    highlight: '#af52de',       // systemPurple
    land: {
      // The vegetation tier, all at h 127 and separated by chroma alone.
      lawn: '#bee298',          // L 85.8 C 40.6 — measured
      tree: '#b0d787',          // L 81.5 C 44.0
      shrub: '#a3cc7a',         // L 77.5 C 46.0
      sport: '#bcdc9a',         // L 84.0 C 36.0
      // The paved tier: same band of lightness, chroma down near zero.
      paving: '#e7e6dc',        // L 91.0 C 5.0 h 105
      parking: '#deddd4',       // L 88.0 C 4.5 h 105
      parking_stripe: '#efeee8', // L 94.0 C 3.0 h 105
      // Not white, unlike the Google table: under Apple the ribbon on top is
      // itself grey, so the ground beneath it matches rather than showing
      // through as a lighter core.
      walkway: '#dfdfda',       // measured
      driveway: '#dfdfda',
      offsite_road: '#dfdfda',
      crossing: '#d2d2cc',      // L 84.0 C 3.0 h 110
      track: '#e0a382',         // L 72.0 C 32.0 h 55 — a running track is red
      closed: '#d8d7d2',        // L 86.0 C 3.0 h 105
      pool: '#9fd2f6',          // L 82.0 C 24.0 h 250 — the exception
      building: '#e5e0cf',
    },
    basemapConfig: {
      colorLand: '#efece2',
      colorGreenspace: '#bee298',
      colorWater: '#9fd2f6',
      // White, where the campus network beside it is grey — Apple's own
      // distinction between a road and a path, and the thing that makes the
      // campus boundary read as a change of place rather than a seam. Same
      // split as APPLE_LIGHT_STYLE in google-tiles.js, for the same reason.
      colorRoads: '#ffffff',
      colorMotorways: '#f6d5a2',   // L 87 C 30 h 82
      colorTrunks: '#f9e6c6',      // L 92 C 18 h 85
      colorBuildings: '#e5e0cf',
      colorRoadLabels: '#6f6d65',
      colorPlaceLabels: '#000000',
      colorPointOfInterestLabels: '#6f6d65',
      roadsBrightness: 1,
    },
  },
  dark: {
    style: STANDARD,
    lightPreset: 'night',
    // The same inversion the Google dark theme documents, for the same reason:
    // below a certain ground lightness the network has to be lighter than what
    // it crosses or it stops being a network.
    network: '#4e4e4b',         // L 33.0 C 2.0 h 110
    networkCasing: '#1e1e1b',   // L 11.0 C 2.0 h 105
    casing: '#2557a8',
    route: '#0a84ff',           // systemBlue, dark
    building: '#3b3932',        // L 24.0 C 5.0 h 97
    buildingLine: '#49473d',    // L 30.0 C 6.0 h 97
    mask: '#2f2e2a',            // L 19.0 C 3.0 h 100
    label: '#ddddd9',           // L 88.0 C 2.0 h 105
    labelHalo: '#1e1e1b',
    areaLabel: '#95ae7a',       // L 68.0 C 30.0 h 127, and 3.43:1 on the shrub tier
    sportLine: '#5b6054',
    parkingLabel: '#a2a09b',    // L 66.0 C 3.0 h 100
    highlight: '#bf5af2',       // systemPurple, dark
    land: {
      lawn: '#36412a',          // L 26.0 C 16.0 h 127
      tree: '#3d4b2d',          // L 30.0 C 20.0 h 127
      shrub: '#425331',         // L 33.0 C 22.0 h 127
      sport: '#353e2a',         // L 25.0 C 14.0 h 127
      paving: '#353531',        // L 22.0 C 2.5 h 105
      parking: '#31302d',       // L 20.0 C 2.5 h 105
      parking_stripe: '#3e3e3b', // L 26.0 C 2.0 h 105
      walkway: '#474744',       // L 30.0 C 2.0 h 110
      driveway: '#454541',      // L 29.0 C 2.0 h 110
      offsite_road: '#40403d',  // L 27.0 C 2.0 h 110
      crossing: '#5a5a56',      // L 38.0 C 2.0 h 110
      track: '#4f392d',         // L 26.0 C 14.0 h 55
      closed: '#31302d',        // L 20.0 C 2.0 h 105
      pool: '#1c3d4f',          // L 24.0 C 16.0 h 250
      building: '#3b3932',
    },
    // Authored well above the target, because these go through Standard's
    // lighting and the night preset takes most of it back.
    //
    // How much it takes back was measured off the rendered canvas rather than
    // taken from the note on the Google table above, and the two disagree: that
    // note says three quarters, and sampling the land outside the campus in
    // both looks says about a FIFTH. Google's #2c2c2c comes back as #08090c and
    // this table's #3f3d38 as #0b0c10 — 0.18 and 0.175 of what was written.
    //
    // Which means the campus cannot be matched to its surroundings at night by
    // this route at all: reaching the #2f2e2a mask would need an authored value
    // past #ffffff. Both looks therefore show a lighter campus on a near-black
    // city, and that is the same thing the note on `mask` calls deliberate — a
    // difference, rather than a hole where the map failed to load. It is simply
    // larger in the dark than anyone chose.
    basemapConfig: {
      colorLand: '#3f3d38',
      colorGreenspace: '#485738',
      colorWater: '#255169',
      colorRoads: '#686864',       // lighter than the land, as at night it must be
      colorMotorways: '#6b5439',
      colorTrunks: '#5c4d38',
      colorBuildings: '#4f4c43',
      colorRoadLabels: '#a2a09b',
      colorPlaceLabels: '#ddddd9',
      colorPointOfInterestLabels: '#a2a09b',
      roadsBrightness: 1,
    },
  },
};

/**
 * The two value tables, and nothing else that distinguishes the looks.
 *
 * Imagery is deliberately absent: SATELLITE is shared by both, because a
 * photograph has no design language to be in. Its colours are solving a
 * legibility problem — what line reads over foliage, tarmac and a pale roof at
 * once — and that problem has the same answer whichever chrome is on top.
 */
export const LOOKS = { classic: THEMES, apple: APPLE };

/**
 * The style loaded when Google is drawing the ground: no sources, no layers,
 * nothing to see through. Google's raster already carries roads, water, labels
 * and place names, so leaving Standard underneath would double-draw all of it.
 *
 * `glyphs` is the one thing an empty style still owes us. Every campus label is
 * a symbol layer, and a style with no glyph endpoint renders them as nothing at
 * all — silently, since a missing font is not a style error.
 *
 * Frozen and defined once because `syncBasemapStyle` compares style identity;
 * an object literal rebuilt per call would never equal itself and would
 * setStyle on every toggle, forever.
 */
export const BLANK_STYLE = Object.freeze({
  version: 8,
  sources: {},
  layers: [],
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
});

/** Layer colours and basemap style for the current provider/basemap/theme/skin. */
export function palette(provider, basemap, theme, skin) {
  const base = basemap === 'satellite' ? SATELLITE : (LOOKS[skin] ?? LOOKS.classic)[theme];
  if (provider !== 'google') return base;

  // Same overlay colours — the campus is drawn identically over either ground —
  // but the Standard configuration keys are dropped rather than left to fail:
  // there is no basemap import on a blank style for them to apply to, and
  // setConfigProperty would throw thirteen times on every style load.
  return { ...base, style: BLANK_STYLE, lightPreset: null, basemapConfig: null };
}

/**
 * Identity of the applied style. A change here means a full reload; anything
 * else is recoloured in place.
 *
 * Not just the style URL, because under Google every combination shares the one
 * blank style: the map type and the theme are baked into the tile session, not
 * into the style, so switching to satellite or to dark would otherwise keep
 * serving the tiles it was already serving.
 *
 * The skin is in the key for BOTH providers, and it is the only thing here that
 * is. Every other difference between two looks is a paint property, and the
 * builders below reset those in place on a layer that already exists — but the
 * label font is a *layout* property, so a skin change that recoloured without
 * reloading would leave the whole campus set in the outgoing face. A full
 * reload on a deliberate, rare toggle is the cheaper of the two mistakes.
 */
export function styleKey(provider, basemap, theme, skin) {
  return provider === 'google'
    ? `google:${basemap}:${theme}:${skin}`
    : `${palette(provider, basemap, theme, skin).style}:${skin}`;
}

