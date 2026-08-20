// The two looks: what has to stay true of each, and of the boundary between them.
//
// A skin is the widest change this app can make — it moves every colour on the
// map, every colour in the chrome, the typeface and the corner of every card at
// once — and almost none of it fails loudly. A token the Apple block forgets to
// override does not throw; it silently inherits Google's value and one card in
// the corner stays the wrong grey forever. A ground colour that drifts from the
// one Google's raster is styled with does not throw either; it draws a seam
// around the campus, which is the exact bug this codebase has already fixed
// twice under other names.
//
// So the checks here are the ones that catch a look going quietly wrong:
// legibility of every ink on every surface it can land on, the campus ground
// agreeing with the ground around it in all four combinations, and the promises
// the palette comments make about their own construction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LOOKS, SATELLITE, FONTS, palette, styleKey } from '../src/palette.js';
import { GROUND_STYLE } from '../src/google-tiles.js';
import { SKINS } from '../src/skin.js';
import { root, contrast, deltaE, lch, flatten, toHex } from './helpers.js';

const THEMES = ['light', 'dark'];

/**
 * The entries of `land` that are paint on a surface rather than the surface.
 *
 * One so far: a bay divider is 0.99 m of white line on tarmac, and src/main.js
 * draws it as a line — `campus-rake`, over the car park rather than instead of
 * it. It lives in `land` only because sheetPaint looks colours up by the sheet's
 * `kind`, which does not distinguish the two.
 *
 * It matters because the rules below are about GROUND. The same distinction is
 * already made further down for the court markings, in the same words: a
 * stroke-width line under a letter is what a halo is for, and holding a label
 * to 4.5 against every hairline it might cross drags the ink towards white
 * until it stops reading as anything.
 */
const MARKINGS = new Set(['parking_stripe']);

const landOf = (p) => Object.fromEntries(
  Object.entries(p.land).filter(([kind]) => !MARKINGS.has(kind)),
);

/** Every surface a name can be printed on, for a given look and theme. */
const groundsOf = (p) => ({ ...landOf(p), mask: p.mask, building: p.building });

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

test('a look defines every colour the other one does', () => {
  // Not cosmetic: `land` is keyed by the `kind` on each polygon of my campus's sheet,
  // and a kind with no entry keeps the printed colour it came with. Miss one
  // and a look has a car park still drawn in the print house's grey.
  const reference = LOOKS.classic;
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const want = reference[theme];
      const got = LOOKS[skin][theme];
      assert.deepEqual(
        Object.keys(got).sort(), Object.keys(want).sort(),
        `${skin}/${theme} does not answer the same questions as classic/${theme}`,
      );
      assert.deepEqual(
        Object.keys(got.land).sort(), Object.keys(want.land).sort(),
        `${skin}/${theme} covers a different set of ground kinds`,
      );
      assert.deepEqual(
        Object.keys(got.basemapConfig).sort(), Object.keys(want.basemapConfig).sort(),
        `${skin}/${theme} configures Standard differently`,
      );
    }
  }
});

test('the two looks actually disagree', () => {
  // The failure this catches is a copy-paste skin: a table that was duplicated
  // and then only half edited, which passes every other test in this file
  // because a copy of a valid palette is a valid palette.
  for (const theme of THEMES) {
    const a = LOOKS.apple[theme];
    const c = LOOKS.classic[theme];
    const shared = Object.keys(a).filter(
      (k) => typeof a[k] === 'string' && k !== 'style' && k !== 'lightPreset' && a[k] === c[k],
    );
    assert.deepEqual(shared, [], `apple/${theme} still has classic's ${shared.join(', ')}`);

    const sameGround = Object.keys(a.land).filter((k) => a.land[k] === c.land[k]);
    assert.deepEqual(sameGround, [], `apple/${theme} ground ${sameGround.join(', ')} is unchanged`);
  }
});

test('every name is legible on every surface it can be printed on', () => {
  // A label is drawn with a halo, so the halo is the contrast that is always
  // there and gets the full 4.5. The ground underneath only shows between the
  // strokes, so it is held to 4.5 as well — which both looks already clear, and
  // which is worth pinning precisely because nothing forces it.
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const p = LOOKS[skin][theme];
      assert.ok(
        contrast(p.label, p.labelHalo) >= 4.5,
        `${skin}/${theme} label on its own halo is ${contrast(p.label, p.labelHalo).toFixed(2)}:1`,
      );
      // Buildings used to be exempt here, and the exemption was a mistake
      // built on a mistake: Apple's night blocks had been guessed at L 63,
      // which no white name can survive, so this test was loosened to accept
      // the halo alone on that one surface. Measuring the reference put them
      // at L 42.7 — eleven points over the terrain, not thirty — and the ink
      // clears 4.5 on them with room to spare. The rule is whole again, and
      // the narrowest margin on the night map is now that building at 4.76:1.
      for (const [kind, ground] of Object.entries(groundsOf(p))) {
        const ratio = contrast(p.label, ground);
        assert.ok(ratio >= 4.5, `${skin}/${theme} label on ${kind} is ${ratio.toFixed(2)}:1`);
      }
      // Area names and car park names are checked against what they are
      // actually printed over, which was worth establishing rather than
      // assuming: all five area labels — BASEBALL FIELD, SOCCER STADIUM,
      // SOFTBALL FIELD, STADIUM, TENNIS COURTS — sit on `sport` drawn over
      // `lawn`, and on nothing else. An earlier version of this test held them
      // against all four planting tiers including `shrub`, which they never
      // touch, and then had to exempt a theme for failing on a surface it does
      // not use.
      //
      // 4.5, not 3. These are 9-17px and `labelSize` scales an area label to
      // 0.95, so they are SMALLER than the rest — the "large text" allowance
      // this once claimed was not available to them.
      //
      // The court markings drawn over the pitch are deliberately not in this
      // list. They are stroke-width lines, which is what the halo asserted
      // above is for; requiring 4.5 against them pushes the dark themes' label
      // to a near-white mint that stops reading as a greenspace name at all.
      for (const green of ['lawn', 'sport']) {
        const ratio = contrast(p.areaLabel, p.land[green]);
        assert.ok(
          ratio >= 4.5,
          `${skin}/${theme} area label on ${green} is ${ratio.toFixed(2)}:1`,
        );
      }
      // Car park names sit on tarmac, and are held to 3 rather than 4.5: unlike
      // the area labels they are drawn at the full label size and are the one
      // ink here that both looks inherited rather than chose.
      const parking = contrast(p.parkingLabel, p.land.parking);
      assert.ok(parking >= 3, `${skin}/${theme} car park label is ${parking.toFixed(2)}:1`);
    }
  }
});

test('the network is separable from the ground it crosses', () => {
  // Apple draws a path as a soft grey band on a warm ground and Google draws a
  // white ribbon in a grey casing, so the absolute numbers differ by a lot. What
  // must hold in both is that the ribbon is told from its own edge and from the
  // land — a network that matches either one has stopped being a network.
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const p = LOOKS[skin][theme];
      assert.ok(
        deltaE(p.network, p.networkCasing) > 4,
        `${skin}/${theme} ribbon and casing are dE ${deltaE(p.network, p.networkCasing).toFixed(1)}`,
      );
      assert.ok(
        deltaE(p.network, p.mask) > 4,
        `${skin}/${theme} ribbon and land are dE ${deltaE(p.network, p.mask).toFixed(1)}`,
      );
    }
  }
});

test("Apple's ground is one hue family, told apart by saturation", () => {
  // The rule the whole APPLE table was built from, and the thing that would be
  // lost first if someone added a kind by picking a colour that looked right.
  // Three kinds are exempt, and they are one exemption rather than three: a
  // surface laid for a purpose is the colour of what it is made of, and no rule
  // about a warm neutral ground can produce blue water, a red running track, or
  // the green-grey of a hard court. Everything else here is LAND, and land is
  // what the rule is about.
  //
  // `tennis` earns it on the measurement rather than by assertion. It is C 7.5,
  // squarely in the paved tier by saturation, but at h 142 against a paved tier
  // that runs 94-110 — and dE 4.1 from the same lightness and chroma at h 110,
  // so it is a real difference and not hue wobbling about near the neutral axis.
  // Apple draws a court as a worn green surface, not as pavement.
  const land = landOf(LOOKS.apple.light);
  const SURFACED = new Set(['pool', 'track', 'tennis']);
  const onAxis = Object.entries(land).filter(([kind]) => !SURFACED.has(kind));

  const hues = onAxis.map(([, hex]) => lch(hex).h);
  const spread = Math.max(...hues) - Math.min(...hues);
  assert.ok(spread <= 45, `Apple's ground spans ${spread.toFixed(0)} degrees of hue`);

  // ...and the contrast with the system it replaced, which is the actual claim:
  // the two are structurally different, not differently tinted.
  const classicHues = Object.values(LOOKS.classic.light.land).map((hex) => lch(hex).h);
  const classicSpread = Math.max(...classicHues) - Math.min(...classicHues);
  assert.ok(
    classicSpread > spread * 3,
    `classic spans ${classicSpread.toFixed(0)} degrees to Apple's ${spread.toFixed(0)}`,
  );

  const chroma = onAxis.map(([, hex]) => lch(hex).C);
  assert.ok(
    Math.max(...chroma) / Math.min(...chroma) > 8,
    `Apple's chroma only spans ${(Math.max(...chroma) / Math.min(...chroma)).toFixed(1)}x`,
  );

  const light = onAxis.map(([, hex]) => lch(hex).L);
  assert.ok(
    Math.max(...light) - Math.min(...light) < 20,
    `Apple's ground spans ${(Math.max(...light) - Math.min(...light)).toFixed(0)} of lightness`,
  );
});

test('the values measured off the capture are used unchanged', () => {
  // Four colours in this palette are not judgement calls — they were sampled
  // from a macOS Maps frame, and the rest were placed relative to them. If one
  // is "tidied" the others no longer sit on anything.
  const p = LOOKS.apple.light;
  assert.equal(p.land.lawn, '#bee298', 'the measured park green');
  assert.equal(p.network, '#dfdfda', 'the measured path grey');
  assert.equal(p.labelHalo, '#fefdf6', 'the measured halo, which is not white');
  assert.equal(p.label, '#000000', 'Apple sets place names in black');
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** A colour out of one of Google's style arrays. */
function styled(rules, featureType, elementType) {
  const hit = rules.findLast(
    (r) => (r.featureType ?? null) === featureType && r.elementType === elementType,
  );
  return hit?.stylers?.find((s) => s.color)?.color ?? null;
}

// Standard's night preset lands a basemapConfig colour at about three quarters
// of what is written, so the dark tables are authored up. Undo that before
// comparing one to a colour that does not go through the lighting.
const asRendered = (hex, theme) =>
  (theme === 'light' ? hex : `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.75).toString(16).padStart(2, '0')).join('')}`);

test('the ground under the campus matches the ground around it', () => {
  // The seam. Our campus sheet is painted over a hole cut in whatever the
  // provider draws, so its land, water and planting have to agree with what
  // that provider is showing a metre outside the boundary — on BOTH providers,
  // which is now eight combinations rather than the four it used to be.
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const p = LOOKS[skin][theme];

      // Mapbox draws the surroundings through Standard's own configuration.
      //
      // Ground only. Buildings are deliberately NOT on this list: a campus
      // block is a warm cream and a city block the neutral grey beside it, and
      // that difference is what makes my campus read as one institution rather than a
      // district. They measure dE 6.8 apart in the classic light theme, and
      // that is the feature.
      const config = p.basemapConfig;
      const pairs = [
        ['colorLand', p.mask],
        ['colorGreenspace', p.land.lawn],
        ['colorWater', p.land.pool],
      ];
      for (const [key, ours] of pairs) {
        const theirs = asRendered(config[key], theme);
        assert.ok(
          deltaE(theirs, ours) < 2,
          `${skin}/${theme}: Standard's ${key} renders ${theirs}, campus has ${ours} `
          + `(dE ${deltaE(theirs, ours).toFixed(1)})`,
        );
      }

      // ...and Google draws them into a raster, which cannot be clipped, so the
      // agreement has to be baked into the session's style array instead.
      const rules = GROUND_STYLE[skin][theme];
      if (!rules.length) continue;   // classic light IS Google's own daylight map
      for (const [featureType, elementType, ours, what] of [
        [null, 'geometry', p.mask, 'land'],
        ['water', 'geometry', p.land.pool, 'water'],
        ['poi.park', 'geometry', p.land.lawn, 'planting'],
      ]) {
        const theirs = styled(rules, featureType, elementType);
        assert.ok(theirs, `${skin}/${theme}: Google's raster leaves ${what} unstyled`);
        assert.ok(
          deltaE(theirs, ours) < 2,
          `${skin}/${theme}: raster ${what} is ${theirs}, campus has ${ours}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The plumbing
// ---------------------------------------------------------------------------

test('changing the look forces the style to be rebuilt', () => {
  // Every difference between two looks is a paint property except one: the
  // label font is a *layout* property, and the builders only reset paint on a
  // layer that already exists. So the skin has to reach the style key, or a
  // switch would recolour the campus and leave it set in the outgoing face.
  for (const provider of ['mapbox', 'google']) {
    for (const basemap of ['map', 'satellite']) {
      for (const theme of THEMES) {
        assert.notEqual(
          styleKey(provider, basemap, theme, 'apple'),
          styleKey(provider, basemap, theme, 'classic'),
          `${provider}/${basemap}/${theme} reuses one style key across both looks`,
        );
      }
    }
  }
  assert.notEqual(FONTS.apple.medium[0], FONTS.classic.medium[0], 'both looks ask for one face');
});

test('imagery belongs to neither look, and an unknown look is classic', () => {
  // A photograph has no design language, so both looks share it — asserted
  // rather than assumed, because the obvious "improvement" is to give Apple its
  // own satellite table, and its line colours are solving legibility over
  // foliage and pale roofs, which has the same answer either way.
  for (const skin of SKINS) {
    assert.equal(palette('mapbox', 'satellite', 'light', skin), SATELLITE);
  }
  // And a stored value from a future version, or a typo, lands somewhere real.
  assert.equal(palette('mapbox', 'map', 'light', 'nonsense'), LOOKS.classic.light);
});

// ---------------------------------------------------------------------------
// The chrome
// ---------------------------------------------------------------------------

// Comments out first, and not for tidiness: this stylesheet documents itself in
// its own syntax — `a [data-skin="apple"] .g-card { ... }` appears inside the
// note explaining why that rule does NOT exist — and a brace in a comment ends
// the block a naive matcher thinks it is in. Which is exactly what happened:
// the :root block came back 39 characters long and every token in it read as
// undefined.
const css = readFileSync(path.join(root, 'src', 'input.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `--name: value` inside the blocks whose selector matches. */
function tokens(selector) {
  const found = {};
  const blocks = css.matchAll(/^([^\n{}]+)\{([^{}]*)\}/gm);
  for (const [, head, body] of blocks) {
    if (head.trim() !== selector) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found[name] = value.trim();
    }
  }
  return found;
}

/** The blocks that apply to one look and theme, later ones winning. */
const SELECTOR = {
  classic: { light: [':root'], dark: [':root', ':root[data-theme="dark"]'] },
  apple: {
    light: [':root', ':root[data-skin="apple"]'],
    dark: [':root', ':root[data-theme="dark"]', ':root[data-skin="apple"]',
      ':root[data-skin="apple"][data-theme="dark"]'],
  },
};

const resolved = (skin, theme) =>
  Object.assign({}, ...SELECTOR[skin][theme].map(tokens));

/**
 * A token's value as a colour and an alpha, following one `var()` hop.
 *
 * The alpha matters as much as the hex here: three of the values this reads —
 * the card's own background, Apple's secondary ink, the hover fill — are
 * translucent, and reading only their hex would check a colour that is never
 * actually drawn.
 */
function colour(value, all) {
  const v = String(value).trim();
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) return colour(all[ref[1]], all);
  const parts = v.match(/^rgba?\(([^)]+)\)$/);
  if (parts) {
    const [r, g, b, a = 1] = parts[1].split(',').map(Number);
    return { hex: toHex([r, g, b]), alpha: a };
  }
  return { hex: v, alpha: 1 };
}

test('every token the stylesheet reads is a token it defines', () => {
  // A `var(--g-tint)` that nobody defines is not an error: it resolves to
  // nothing and the property is dropped, so a button simply loses its fill.
  const defined = new Set(Object.keys({ ...tokens(':root'), ...tokens(':root[data-theme="dark"]') }));
  const used = new Set([...css.matchAll(/var\((--g-[\w-]+)/g)].map((m) => m[1]));
  for (const name of used) {
    assert.ok(defined.has(name), `${name} is read but never defined at :root`);
  }
});

/**
 * What a look is, stated as the set of tokens it has to have an opinion about.
 *
 * This list is a specification rather than a derivation, and it has to be: the
 * stylesheet cannot say which of its tokens are *about* the look and which are
 * shared furniture. --g-rail-w, --g-gap and --g-col-w are geometry both looks
 * agree on; everything below is not.
 *
 * It earns its place by catching the one failure the "is it defined" check
 * above cannot see. Rename --g-radius to --g-radiusX inside the Apple block and
 * nothing breaks: the name is still defined at :root, every var() still
 * resolves, and Apple quietly goes back to 8px corners. That was a real hole
 * here until this test closed it.
 */
const LOOK_TOKENS = [
  '--g-font', '--g-radius', '--g-radius-sm', '--g-radius-search',
  '--g-surface', '--g-surface-2', '--g-card-bg', '--g-card-filter',
  '--g-text', '--g-text-dim', '--g-line', '--g-blue', '--g-highlight',
  '--g-hover', '--g-active', '--g-shadow', '--g-shadow-sm', '--g-tint', '--g-head-rule',
  '--g-label-halo',
];

test('the Apple look states a value for every token that defines a look', () => {
  // States, rather than differs from. Two of these legitimately agree —
  // Google's card surface is white and so is Apple's systemBackground — and a
  // look that had to disagree about everything would be picking values to pass
  // a test. What must be true is that the Apple block has said something about
  // each one, so a forgotten override is a failure rather than a silent
  // inheritance.
  const declared = tokens(':root[data-skin="apple"]');
  const classic = resolved('classic', 'light');
  for (const name of LOOK_TOKENS) {
    assert.ok(classic[name], `${name} is not defined for the classic look at all`);
    assert.ok(declared[name], `the Apple look never states a ${name}`);
  }
});

test('every ink in the chrome survives the surface it is drawn on', () => {
  // The Apple card is a material, so its background is not a colour — it is
  // whatever is under it, saturated and then covered at 68%. `saturate()`
  // preserves luminance exactly (the matrix is L + s(c - L), whose luminance is
  // L for any s), so the flattened result's luminance is bounded by the
  // backdrop's, and the extremes are pure black and pure white. That makes the
  // worst case computable rather than a matter of trying a few screenshots.
  //
  // Two floors, because the two cases are not equally real: over this app's own
  // ground the full 4.5 applies, while a pathological backdrop — a black roof
  // in the imagery — only has to stay above 3.
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const t = resolved(skin, theme);
      const ink = colour(t['--g-text'], t);
      const dim = colour(t['--g-text-dim'], t);
      const accent = colour(t['--g-blue'], t);
      const surface = colour(t['--g-card-bg'], t);
      const grounds = Object.values(groundsOf(LOOKS[skin][theme]));
      // The realistic backdrops are this theme's own ground; the pathological
      // ones are the two colours a photograph can actually reach.
      const cases = [
        ...grounds.map((bg) => [bg, 4.5]),
        ['#000000', 3], ['#ffffff', 3],
      ];

      for (const [backdrop, floor] of cases) {
        // An opaque card is its own colour; a material is that colour laid over
        // whatever it covers, which is why the backdrop is a loop variable.
        const card = flatten(surface.hex, backdrop, surface.alpha);
        const inks = [
          ['body text', flatten(ink.hex, card, ink.alpha), floor],
          ['secondary text', flatten(dim.hex, card, dim.alpha), floor],
        ];
        // The accent is held to WCAG's 3:1 for a non-text graphic, but only
        // against backdrops the app can actually produce. Over a pathological
        // one it does not clear it — systemBlue on a card sitting over pure
        // black measures 1.79:1 — and that is a property of a translucent
        // material rather than of this palette: the card's own value has walked
        // to meet the ink. Text is what has to survive that case, and does.
        if (floor >= 4.5) inks.push(['accent', accent.hex, 3]);

        for (const [what, ink, need] of inks) {
          const ratio = contrast(ink, card);
          assert.ok(
            ratio >= need,
            `${skin}/${theme}: ${what} on a card over ${backdrop} is ${ratio.toFixed(2)}:1, `
            + `needs ${need}`,
          );
        }
      }
    }
  }
});

test('the chrome and the map agree about the two colours they share', () => {
  // The legend's rows and the shapes they outline are one answer, and the pin
  // caption's halo is the same halo the symbol labels are drawn with — but each
  // pair is set on opposite sides of the renderer, one in CSS and one in JS,
  // so nothing but this notices when they drift.
  const skins = {
    classic: { light: ':root', dark: ':root[data-theme="dark"]' },
    apple: {
      light: ':root[data-skin="apple"]',
      dark: ':root[data-skin="apple"][data-theme="dark"]',
    },
  };
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      const chrome = { ...tokens(skins[skin].light), ...tokens(skins[skin][theme]) };
      assert.equal(
        chrome['--g-highlight'], LOOKS[skin][theme].highlight,
        `${skin}/${theme}: the legend row and the outline it paints are different purples`,
      );
      // Classic writes the halo as a reference to the card surface, which is
      // what it has always been; only Apple states a colour of its own.
      if (skin === 'apple') {
        assert.equal(
          chrome['--g-label-halo'], LOOKS[skin][theme].labelHalo,
          `${skin}/${theme}: the DOM caption and the symbol labels have different halos`,
        );
      }
    }
  }
});
