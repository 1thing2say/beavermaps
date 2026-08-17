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
    // The ring around a marker. Charcoal on a dark map: the ring cuts the disc
    // out of the ground, and a white one on night ground is the brightest
    // thing on screen competing with the labels.
    pinRing: '#242424',
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
      // Thirteen points over the tarmac rather than six. Google draws no bay
      // markings at all, so there is no value of theirs to take here — this is
      // the neutral tier carried far enough that a 1.2 px rule reads on it.
      parking_stripe: '#424242',
      walkway: '#3c4043',
      driveway: '#35393c',
      offsite_road: '#2f3234',
      crossing: '#4a4d50',
      sport: '#223529',
      // Google draws stadium seating as a building, so the stands take the
      // building grey rather than the ground under them.
      bleachers: '#3a3e41',
      track: '#3a2e26',
      // Google has no separate value for a court either, but it does not need
      // one: this table is neutral-on-neutral by design, so the courts take the
      // paving grey a step under the pitch rather than a hue of their own.
      tennis: '#2c3a3c',
      tennis_apron: '#2b2b2b',   // paving: on this map the apron is just ground
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
    pinRing: '#ffffff',
    // Google's greenspace teal, at the lightness it needs rather than the one
    // they publish. Sampled off their map at #17a773, it measures 2.48:1 on the
    // pitches these names are printed over — every one of the five sits on
    // `sport` above `lawn` — where a 9-17px label needs 4.5. The HUE is theirs
    // and is held to within half a degree (160.4 -> 160.1); only L moves,
    // 61 -> 43, and chroma eases 51 -> 41 to stay in gamut there.
    areaLabel: '#00744d',
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
      parking_stripe: '#ffffff', // as far as the neutral tier goes: L 100 on L 93
      // Pavement is left white and the grey arrives as the network casing on
      // top, exactly as Google builds a road. Colouring the pavement grey as
      // well would double the casing and thicken every path.
      walkway: '#ffffff',
      driveway: '#ffffff',
      offsite_road: '#ffffff',
      crossing: '#e9e9e9',
      sport: '#c3f1d5',
      bleachers: '#dcd7c8',
      track: '#e3c9b6',
      tennis: '#dfeae4',   // the pitch tier drained of green, as a hard court is
      tennis_apron: '#f0f0ee',  // paving: on this map the apron is just ground
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
  // A photograph has no reliable value to ring against, so imagery keeps white.
  pinRing: '#ffffff',
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
    // The same warm off-white as the halo, not pure white. Apple rings a
    // marker in the colour they set label halos in — one paper colour for
    // everything that has to be cut out of the ground — where Google uses
    // a true white for both.
    pinRing: '#fefdf6',
    // The park green deepened, placed by contrast rather than by the lightness
    // band. L 38 C 42 h 127, holding the measured hue exactly. An earlier pass
    // put it at L 41 against a 3:1 target; the target was wrong — these labels
    // are 9-17px and are scaled to 0.95, so they are body text and owe 4.5.
    areaLabel: '#40631f',
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
      sport: '#b2e492',         // L 85.0 C 52.0 h 130 — the pitch, saturated
      bleachers: '#d7d1c1',     // L 84.0 C  9.0 h  97 — the stands, a building
      // The paved tier: same band of lightness, chroma down near zero.
      paving: '#e7e6dc',        // L 91.0 C 5.0 h 105
      // Eight points darker than the rest of the paved tier was placed at, and
      // the darkest ground on the daylight map, which is what tarmac is. The
      // band it left was written when the campus ground was a warm near-white
      // and a car park only had to be told from that; the ground is grass now,
      // and a lot at L 88 sat LIGHTER than the lawn it is cut into — the one
      // relationship the printed sheet is unambiguous about, where tarmac is
      // eleven points under the grass. This is 5.8 under ours.
      //
      // It is also what makes the rake legible: white paint on a car park needs
      // the car park to be somewhere below white. See parking_stripe.
      parking: '#c8c7bd',       // L 80.0 C 5.0 h 105
      // The bay dividers, and this one is placed against the tarmac rather than
      // in the paved band with the rest. my campus rules their car parks in white on
      // a mid-grey — L 100 on L 68, a 32-point step, and on their sheet the
      // rake is the loudest texture on the page. Ours sat at L 94 on L 88 and
      // was six points of nothing. This is as far up as sRGB goes at this hue,
      // giving 11 points against the lot below it; the rest of the distance is
      // made up by drawing them as lines with a floor rather than as sub-pixel
      // bars, which is what actually made them invisible. See src/bay-rake.js.
      parking_stripe: '#faf9f5', // L 98.0 C 2.5 h 105
      // Not white, unlike the Google table: under Apple the ribbon on top is
      // itself grey, so the ground beneath it matches rather than showing
      // through as a lighter core.
      walkway: '#dfdfda',       // measured
      driveway: '#dfdfda',
      offsite_road: '#dfdfda',
      crossing: '#d2d2cc',      // L 84.0 C 3.0 h 110
      // Measured over the same stadium in the daylight reference, and it holds
      // the night map's arrangement exactly: the track carries the court value
      // and the strip inside it carries the apron's. See APPLE.dark.land.track.
      track: '#ced9cd',         // L 85.6 C  7.5 h 142 — measured, = tennis
      // The courts by day, and the daylight reference does NOT carry the night
      // map's teal over: it desaturates them almost to grey and turns them
      // green, C 7.5 at h 142, so the courts read as a worn surface beside the
      // planting rather than as a colour. Measured, like the rest of this block.
      tennis: '#ced9cd',        // L 85.6 C  7.5 h 142 — measured
      // ...and by day the apron is not tinted at all. Measured between two
      // courts on the daylight reference and it comes back as ordinary paved
      // ground, which is the whole reason this is a separate key from `tennis`:
      // at night the complex is a teal block, by day it is twelve pale
      // rectangles lying on the campus.
      tennis_apron: '#edede6',  // L 93.6 C  3.6 h 110 — measured
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
  /*
   * Night, and — finally — measured rather than derived.
   *
   * This table went through four passes with nothing behind it but a screenshot
   * read by eye, and each pass got one more thing wrong. It was the day table
   * at a lower lightness (wrong: Apple drops the warm ground entirely at night
   * and goes cool). Then it was cool but far too dark at L 19 (wrong: their
   * night ground is a mid-slate). Then it was lifted, but sat at h 283, which
   * is blue-VIOLET and reads lavender beside the real thing. Then the buildings
   * were pushed to L 64 on a guess that the pale blocks were the brightest
   * thing on the sheet — right about the direction, wrong by twenty points.
   *
   * Eight of the values below are now sampled off the reference with Digital
   * Color Meter and converted out of the display's native P3 into sRGB, which
   * is what finally settled it. What they show, in the order the map stacks up:
   *
   *     road              L 21.6  C  7.7  h 273
   *     pathway           L 28.4  C 15.6  h 271
   *     inside terrain    L 31.7  C 12.6  h 264
   *     outside terrain   L 31.9  C 16.1  h 264
   *     parking           L 32.8  C 16.6  h 266
   *     dark grass        L 32.9  C 20.1  h 201
   *     lighter grass     L 36.5  C 25.9  h 188
   *     building          L 42.7  C 19.1  h 266
   *
   * Three things in that list this table had wrong, and none of them were
   * guessable from a thumbnail. The neutral hue is 264-273, not 283 — six to
   * nineteen degrees is the whole difference between slate and lavender. The
   * planting is at h 188-201, a TEAL, where every previous pass put it at
   * 160-170 and got a grass green Apple does not use after dark. And the whole
   * map lives inside twenty-one points of lightness, floor to ceiling: the
   * brightest ground on it is a building at L 42.7 and the darkest is a road at
   * L 21.6. A `network` at L 52 and blocks at L 64, which is what was here, are
   * both off the top of a scale Apple never leaves.
   *
   * So the day table's rule turns out to hold at night too — one narrow
   * lightness band, meaning carried by chroma, which here runs 7.7 to 25.9 and
   * tracks lightness rather than cutting across it. The eight measured values
   * are used exactly as measured; everything else is placed on the same axis,
   * and carries the LCH it was placed at.
   *
   * The buildings ARE still the brightest thing on the map. That reading was
   * right — it is only the size of the gap that was invented. Eleven points
   * over the ground, not thirty.
   */
  dark: {
    style: STANDARD,
    lightPreset: 'night',
    // Measured, and the opposite of what this used to say. The note here read
    // "Apple draws circulation LIGHT at night — the ways are the brightest
    // thing on the sheet after the labels", and the ribbon was authored at
    // L 52 to match. A path on the reference measures L 28.4, which is DARKER
    // than the terrain it crosses: a channel cut into the ground, not a band
    // laid over it. Nothing on Apple's night map is lit except the labels.
    network: '#34445b',         // L 28.4 C 15.6 h 271 — measured
    networkCasing: '#263243',   // L 20.5 C 12.0 h 269
    casing: '#2557a8',
    route: '#0a84ff',           // systemBlue, dark
    // The brightest ground on the map, and measured at last. The direction was
    // never in doubt — Apple's blocks stand off the field, and that is the most
    // recognisable thing about their night cartography — but the size of the
    // step was invented, twice. It is ELEVEN points over the terrain, not the
    // thirty this table was carrying and not the nine it had before that.
    building: '#4e6784',        // L 42.7 C 19.1 h 266 — measured
    // Darker than the fill it edges, where the day table's line is lighter:
    // a pale block on a dark ground needs its edge cut INTO it.
    buildingLine: '#3a526c',    // L 34.0 C 18.0 h 266
    mask: '#3c4c5e',            // L 31.7 C 12.6 h 264 — measured
    label: '#e6e8ec',           // L 91.9 C  2.2 h 272
    labelHalo: '#20242e',       // L 14.2 C  7.3 h 278 — keep --g-label-halo in step
    // Charcoal, not white. Apple rings their night markers in the ground's own
    // dark rather than in white, which is what stops a screen full of discs
    // reading as a constellation.
    pinRing: '#2b3040',
    // Apple's own recreation ink is #7de08c — L 81.6 C 56.6 h 145 — and this
    // takes its hue and its chroma exactly and lifts it eight points of
    // lightness. That is a deliberate departure, and the only one in this
    // block: at Apple's own L 81.6 the label measures 3.68:1 on the pitch it is
    // printed on, which their map is content with and this one is not. These
    // names are 9-17px and are body text, so they owe 4.5. At L 90 they make
    // 4.63:1 on the pitch and 5.67:1 on the lawn.
    //
    // The value it replaces held the right lightness and had given up on the
    // colour: C 18 at h 175 is a pale mint, where the reference is a green
    // three times as saturated.
    areaLabel: '#95f8a2',       // L 90.0 C 56.6 h 145
    // Field markings, and the reference draws none at all — no touchline, no
    // centre circle, nothing on the pitches but green. The nearest thing Apple
    // has is the apron a tennis court sits in, which is dE 4 from the court.
    //
    // So this is not white any more. At L 70 against a pitch at L 42 the
    // markings were the brightest thing in the athletics half of the campus and
    // the fields read as a set of drawings rather than as ground. Seven points
    // over the pitch keeps my campus's touchlines legible as touchlines and stops
    // them competing with the labels.
    sportLine: '#2f835b',       // L 49.0 C 38.0 h 158
    parkingLabel: '#a8aebb',    // L 71.0 C  7.4 h 274
    highlight: '#bf5af2',       // systemPurple, dark
    land: {
      // Planting, and the hue is measured rather than assumed. Every pass
      // before this one put Apple's night greens at h 160-170 — a grass green,
      // the day map's planting cooled down. They are at h 188-201, which is a
      // TEAL: the blue in the ground carried into the vegetation rather than
      // held out of it, which is why a campus that is 62% planting stopped
      // reading as a separate map from the city around it.
      //
      // The two measured tiers are also the wrong way round from the day
      // table's logic — the DARKER green is the bluer one (h 201 against 188),
      // so chroma and hue both climb with lightness here.
      tree: '#155658',          // L 32.9 C 20.1 h 201 — measured, dark grass
      lawn: '#00615b',          // L 36.5 C 25.9 h 188 — measured, light grass
      shrub: '#074d4e',         // L 29.0 C 20.0 h 199
      // The pitch — measured off maps.apple.com at last, and the reference says
      // the exact opposite of the note that used to be here.
      //
      // That note reasoned the pitch down to C 20 "because Apple never makes the
      // pitches the most saturated thing in frame". Apple does. It is the most
      // saturated surface on their night map by a wide margin: #007249 covers
      // 2.3% of the frame at z17 at C 41.2, where the greenspace around it sits
      // at C 30.5 and the tree canopy at C 20.1. The pitches are the one place
      // the night map is allowed to be a colour.
      //
      // Both earlier passes were placed by argument rather than by pixels, and
      // both landed within a point of L 41 while being 21 points of chroma and
      // 28 degrees of hue away from the thing they were describing.
      //
      // L 42.0 is also the ceiling the area label sets, and it clears it: the
      // ink measures 4.63:1 here and 5.67:1 on the lawn.
      sport: '#007249',         // L 42.0 C 41.2 h 158 — measured
      // The stands. my campus's sheet draws 24 of these and this table had no entry
      // for them at all, so they fell through to the printed sheet's own ink —
      // the one part of the campus neither look had an opinion about, and the
      // reason a stadium here was a green blob where Apple's is a structure.
      // They are a BUILDING, and Apple draws them as one: the bowl is the same
      // slate as the blocks around it, a shade under so it reads as its own
      // mass rather than merging with them.
      // Sits just under the blocks, so the bowl reads as its own mass without
      // leaving the building tier.
      bleachers: '#465e79',     // L 39.0 C 18.0 h 266
      // The paved tier, rebuilt around three measured points rather than one.
      // The old set was a smooth ramp at a flat C 8 with the ways at the TOP of
      // it; the reference has the ways at the bottom, chroma climbing with
      // lightness, and a road darker than anything else on the map.
      closed: '#36414f',        // L 27.0 C 10.0 h 267
      parking: '#3a4f67',       // L 32.8 C 16.6 h 266 — measured
      paving: '#37485c',        // L 30.0 C 14.0 h 266
      offsite_road: '#2e343f',  // L 21.6 C  7.7 h 273 — measured, the road
      driveway: '#303a48',      // L 24.0 C 10.0 h 269
      // Fifteen points over the measured car park it is painted on, where it
      // used to be four. Same reasoning as the daylight value: the printed
      // sheet holds its rake a third of the lightness scale clear of the
      // tarmac, and four points is a difference you can only find by looking
      // for it. Still inside the paved tier's hue and chroma, so the car park
      // reads as one surface with a rule on it rather than as two surfaces.
      parking_stripe: '#60748d', // L 48.0 C 16.0 h 266
      walkway: '#34445b',       // = network, the measured pathway
      crossing: '#44566c',      // L 36.0 C 15.0 h 266
      // A running track is NOT red on this map, and the note that used to say
      // so was written from the physical world rather than from the reference.
      // Measured at z18 over my campus's own stadium, a cross-section straight
      // through the bowl reads 26 px of #1c566a, 14 px of #155263, then 116 px
      // of field — which is to say the track is drawn in exactly the value the
      // twelve tennis courts are drawn in, and the strip between it and the
      // grass in exactly the apron's. Apple has one colour for a hard surface
      // laid out for a sport and spends it on both.
      //
      // Held as its own key rather than pointed at `tennis` so the classic look
      // can keep its terracotta, which is Google's convention and correct there.
      track: '#1c566a',         // L 33.9 C 20.4 h 236 — measured, = tennis
      // The twelve courts, and the reason build-basemap.mjs now sizes them out
      // of `sport`. A court is not a pitch and Apple does not draw it as one:
      // the playing surfaces go to h 158 at C 41, the courts sit at h 236 — the
      // far side of the ground's own blue, seventy-eight degrees away — at a
      // chroma half theirs. Painted `sport` they were twelve vivid green
      // rectangles where the reference has one quiet teal block.
      tennis: '#1c566a',        // L 33.9 C 20.4 h 236 — measured
      // What the twelve sit on. At night the reference tints the whole complex
      // and holds the courts two and a half dE off their apron — a cross-section
      // is 23 px of #1c566a, a gap of this, 23 px of #1c566a, all the way
      // across. Barely a difference, and it is the difference between reading
      // twelve courts and reading one teal rectangle.
      tennis_apron: '#155263',  // L 32.0 C 19.9 h 231 — measured
      // Water, measured. The last note here had the right instinct — that water
      // has to hold a chroma the neutrals cannot reach — and then stopped less
      // than halfway. Apple's water is #1c347a: C 46.1, which is nine points
      // clear of even the pitch, at h 292, twenty-seven degrees round from the
      // ground's blue. It is the darkest saturated thing on the map, and being
      // dark is what stops that much chroma shouting.
      //
      // C 28 at h 265 was the ground's own hue with the chroma turned up, which
      // is why the pool read as a slightly bluer building.
      pool: '#1c347a',          // L 24.0 C 46.1 h 292 — measured
      building: '#4e6784',
    },
    // Authored up, because Standard's night preset lands these below what is
    // written and the test models that at three quarters.
    basemapConfig: {
      colorLand: '#50657d',
      colorGreenspace: '#008179',
      // #1c347a once the night preset has taken its quarter off. Authored up
      // like everything else in this block; see the note above.
      colorWater: '#2545a3',
      // #526074 once the night preset has taken its quarter off — LIGHTER than
      // the land, which is the third thing this line has said and the first one
      // measured at the zoom it matters at.
      //
      // Apple flips the network between z16 and z17: light diagram above, dark
      // asphalt below. Both earlier notes here were right about one side of
      // that flip and wrong to state it as the whole rule. This provider draws
      // the CITY, and the city is only ever read at overview zooms, so it takes
      // the overview value. See the long note in src/google-tiles.js.
      colorRoads: '#6d809b',
      colorMotorways: '#8a7454',   // highways stay warm at night, as Apple's do
      colorTrunks: '#77664a',
      colorBuildings: '#6889b0',
      // Measured off a street name on the reference: L 82.1 C 16.1 h 272, not
      // the L 71 C 7.4 this carried. Apple's road labels are BRIGHTER than
      // their place labels and carry the ground's blue rather than being neutral
      // — the street grid is the thing you read a night map by.
      colorRoadLabels: '#bdcdea',
      colorPlaceLabels: '#e6e8ec',
      colorPointOfInterestLabels: '#a8aebb',
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

/**
 * The same palette, moved to where the sun actually is.
 *
 * TWO MAPS WERE DISAGREEING ABOUT THE TIME OF DAY. Everything this app draws
 * over the campus is painted with `fill-emissive-strength: 1`, which is what
 * makes the colours above render as authored — see the note at the top of this
 * file, and the measurement that says Standard's night lighting is not a
 * multiply that can be pre-compensated for. The consequence is that the campus
 * is the one thing on screen that lighting cannot touch: at dusk the city went
 * navy around a college still sitting in the middle of a summer afternoon.
 *
 * So the campus is moved by hand, here, by the amount the sky moved. This is not
 * a simulation of Standard's lighting and does not try to be — matching it
 * exactly would mean reimplementing it, and it changes when Mapbox retunes it.
 * It is the far cruder claim that a campus under a dark sky should be darker,
 * applied consistently to every emissive colour so their relationships survive.
 *
 * AND THE CITY IS MET HALF WAY, from the other side. Standard's own colours DO
 * go through its lighting, so under `night` an authored light grey lands almost
 * black — which is correct, and is a great deal more contrast than a campus map
 * wants at the moment somebody is trying to read it. The authored values are
 * lifted toward white under the dark presets so the rendered result comes back
 * up. The two adjustments converge: the campus comes down, the city comes up,
 * and they meet.
 *
 * `lift` is toward white and `dim` is toward black, both as a fraction of the
 * remaining distance, so no channel can leave its range and nothing needs
 * clamping. The numbers are per preset and are the shallow end of what looks
 * right rather than the deep end: a campus map at night still has to be a map.
 */
/**
 * TOWARD A COLOUR, NOT TOWARD BLACK, and the first version got this wrong in a
 * way that is obvious the moment you look at it.
 *
 * Mixing the campus toward black is achromatic: it takes lightness away and adds
 * nothing. But a low sun is not a dimmer — it is a warmer, redder light, and
 * Standard tints the city accordingly. Set to Dawn, the city went amber and the
 * campus went GREY, so the college read as a slab of dead concrete dropped into
 * a warm morning. Same failure at dusk, mirrored at night: the city cools toward
 * blue and an achromatic campus stays neutral beside it.
 *
 * So each preset names the colour its light is, and the campus is mixed toward
 * that — which darkens and tints in one move, because a dark warm brown is
 * exactly what "less light, and what there is of it is orange" means.
 *
 * `lit` is the other half, for the city: Standard takes its own colours DOWN
 * under these presets, so the authored values are mixed toward a light version
 * of the same hue rather than toward pure white. Lifting a dawn city toward
 * white would bleach out the warmth the campus has just been given.
 *
 * Each `lit` has to be LIGHTER than what it is lifting or it is not a lift. The
 * light theme's city land is already #f3f3f1, so there is very little headroom
 * above it — a night target that was merely cooler came out fractionally darker
 * and the test caught it. These are near-white with a hue rather than mid-tones
 * with one.
 */
const TIME_OF_DAY = {
  day: { ink: null, mix: 0, lit: null, lift: 0 },
  // Morning sun: warm, and the weakest of the three because dawn light is thin
  // rather than heavy.
  dawn: { ink: '#5c4630', mix: 0.16, lit: '#fff8ee', lift: 0.12 },
  // Evening sun: the same hue further round and further down. Dusk is redder
  // and lower than dawn, which is why it is warmer AND darker.
  dusk: { ink: '#4d3524', mix: 0.24, lit: '#fff5e6', lift: 0.18 },
  // No sun. Cool rather than warm, and much further down.
  night: { ink: '#111a2e', mix: 0.40, lit: '#f8fafd', lift: 0.30 },
};

const channels = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * `t` of the way from one colour toward another. Non-colours pass through.
 *
 * One function for both directions, because darkening toward a warm brown and
 * lifting toward a warm white are the same operation with different targets —
 * and writing them as two invited the mistake of making one of them achromatic.
 */
export const toward = (colour, target, t) => {
  const from = channels(colour);
  const to = channels(target);
  if (!from || !to || !t) return colour;
  return hex(from.map((v, i) => v + (to[i] - v) * t));
};

/**
 * A palette re-lit for a preset.
 *
 * Every string that names a colour is moved and everything else is left alone,
 * so a palette gaining a key gains the behaviour without this having to be
 * edited. `label`, `labelHalo` and `pinRing` are deliberately excluded: type has
 * to stay legible against ground that is moving under it, and a halo that dims
 * with its own label cancels itself out.
 */
const KEEP = new Set(['label', 'labelHalo', 'pinRing', 'style', 'lightPreset']);

export function underPreset(colors, preset) {
  const move = TIME_OF_DAY[preset];
  if (!move || (!move.mix && !move.lift)) return colors;

  const out = { ...colors };
  for (const [key, value] of Object.entries(colors)) {
    if (KEEP.has(key)) continue;
    if (typeof value === 'string') out[key] = toward(value, move.ink, move.mix);
    // `land` is a map of ground class to colour, and every one of them is
    // ground — so the whole object moves together or the sheet comes apart.
    else if (value && typeof value === 'object' && key === 'land') {
      out.land = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toward(v, move.ink, move.mix)]),
      );
    }
  }
  // The city, the other way. Only the colours: `roadsBrightness` is a number
  // Standard multiplies by and lifting it toward white means nothing.
  if (colors.basemapConfig) {
    out.basemapConfig = Object.fromEntries(
      Object.entries(colors.basemapConfig).map(([k, v]) => [
        k, typeof v === 'string' ? toward(v, move.lit, move.lift) : v,
      ]),
    );
  }
  return out;
}
