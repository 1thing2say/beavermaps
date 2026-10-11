// The page itself: the markup a screen reader and a search engine read, the
// files a browser asks the origin for on its own, and what the build does to
// both on the way to dist/.
//
// Almost none of this fails loudly. A landmark that goes missing, a meta tag
// that drifts back to a placeholder, a build step that eats a script along with
// the comments around it — the map still draws in every case, so the only way
// any of it is noticed is by somebody who needed it. These are the checks that
// notice instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { root } from './helpers.js';

const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'src', 'input.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const manifest = JSON.parse(readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));

/** The markup with its comments gone, so prose about a tag is not the tag. */
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

/** The opening tag of the element with this id. */
const tagWithId = (id) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, 's'))?.[0];

// ------------------------------------------------------------------- build

test('the built page loses its comments and nothing else', async () => {
  const { stripHtmlComments } = await import('../vite.config.js');
  const plugin = stripHtmlComments();
  assert.equal(plugin.apply, 'build', 'dev serves the page as written');
  assert.equal(plugin.enforce, 'post');

  const built = plugin.transformIndexHtml(html);
  assert.ok(!built.includes('<!--'), 'every comment is gone');
  assert.ok(built.length < html.length / 2, 'and they were most of the file');

  // Every id the app looks up survives, and so does every script, byte for
  // byte — the two theme bootstraps are inline and run before first paint.
  for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) {
    assert.ok(built.includes(`id="${id}"`), `#${id} survived`);
  }
  const scripts = (s) => [...s.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);
  assert.deepEqual(scripts(built), scripts(markup));
  assert.ok(built.includes("localStorage.getItem('mapper-theme')"));
  assert.ok(built.includes("localStorage.getItem('mapper-skin')"));
  assert.ok(built.includes('<template id="nav-sign-template">'));
});

test('a conditional comment is markup, and is kept', async () => {
  const { stripHtmlComments } = await import('../vite.config.js');
  const { transformIndexHtml } = stripHtmlComments();
  const page = '<head>\n<!-- prose -->\n<!--[if IE]><p>old</p><![endif]-->\n</head>';
  assert.equal(transformIndexHtml(page), '<head>\n<!--[if IE]><p>old</p><![endif]-->\n</head>');
});

test('mapbox-gl gets its own chunk, and its stylesheet stays where it was', async () => {
  const { default: config } = await import('../vite.config.js');
  const groups = config.build.rolldownOptions.output.codeSplitting.groups;
  const mapbox = groups.find((g) => g.name === 'mapbox-gl');
  assert.ok(mapbox, 'there is a mapbox-gl group');
  const id = (p) => path.join(root, 'node_modules', ...p.split('/'));
  assert.ok(mapbox.test.test(id('mapbox-gl/dist/mapbox-gl.js')));
  // The CSS has to stay in the app's stylesheet AFTER src/input.css, where it
  // wins ties the way it does in dev — input.css is written against that.
  assert.ok(!mapbox.test.test(id('mapbox-gl/dist/mapbox-gl.css')));
  // And nothing the flyover loads lazily is pulled into the entry with it.
  assert.ok(!mapbox.test.test(id('@deck.gl/core/dist/index.js')));
});

test('the flyover names what it imports, so the barrels can tree-shake', () => {
  const source = readFileSync(path.join(root, 'src', 'flyover-view.js'), 'utf8');
  const dynamic = [...source.matchAll(/import\('([^']+)'\)(\.then\(\(\{)?/g)];
  assert.ok(dynamic.length >= 4);
  for (const [, specifier, destructured] of dynamic) {
    assert.ok(destructured, `import('${specifier}') destructures what it uses`);
  }
});

// ------------------------------------------------------------- landmarks

test('the page has a main landmark, a heading and a search landmark', () => {
  assert.match(markup, /<main class="app-shell">/);
  assert.match(markup, /<\/main>/);
  assert.ok(!/<div class="app-shell">/.test(markup), 'the old div is gone');
  assert.match(markup, /<h1 class="sr-only">[^<]+<\/h1>/);
  assert.match(markup, /<div class="g-search-row" role="search"[^>]*>/);
  // The search landmark holds the field it is named for.
  const row = markup.slice(markup.indexOf('class="g-search-row"'));
  assert.ok(row.indexOf('id="place-search"') < row.indexOf('id="directions-btn"'));
});

test('there is a polite live region outside every panel', () => {
  const status = tagWithId('sr-status');
  assert.ok(status, '#sr-status exists');
  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/);
  assert.match(status, /class="sr-only"/);
  // Not inside the column, whose panels go display:none.
  assert.ok(markup.indexOf('id="sr-status"') < markup.indexOf('id="top-left"'));
});

test('the layers button discloses a group it comes before', () => {
  const button = tagWithId('layers-btn');
  const menu = tagWithId('layers-menu');
  assert.match(button, /aria-controls="layers-menu"/);
  assert.match(button, /aria-expanded="false"/);
  assert.ok(!/aria-haspopup/.test(button), 'not a popup menu');
  assert.ok(!/role="menu"/.test(menu), 'no menu without menuitems');
  assert.match(menu, /aria-label="Map layers"/);
  // Tab order is DOM order: the menu has to follow the button that opens it.
  assert.ok(markup.indexOf('id="layers-btn"') < markup.indexOf('id="layers-menu"'));
});

// -------------------------------------------------------- what is shared

test('a search result and a pasted link get a description, and no guessed URL', () => {
  const meta = (attr, name) => markup.match(
    new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]+)"`, 's'),
  )?.[1];
  const description = meta('name', 'description');
  assert.ok(description, 'a meta description');
  assert.equal(meta('property', 'og:description'), description);
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:title'), 'beavermaps');
  assert.equal(meta('name', 'twitter:card'), 'summary');
  // All three need an absolute URL and the host is not settled.
  assert.ok(!/rel="canonical"/.test(markup));
  assert.ok(!/property="og:url"/.test(markup));
  assert.ok(!/property="og:image"/.test(markup));
  // The same sentence the manifest carries, and as anonymous as the rest.
  assert.equal(manifest.description, description);
  assert.ok(!/my campus/i.test(description));
});

test('robots.txt is a real file that allows everything', () => {
  const robots = readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8');
  assert.equal(robots, 'User-agent: *\nAllow: /\n');
});

// --------------------------------------------------------------- manifest

/** Width, height and RGBA pixels of a PNG this repo wrote (8-bit RGBA, filter 0). */
function readPng(file) {
  const buf = readFileSync(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(buf.readUInt8(24), 8);
  assert.equal(buf.readUInt8(25), 6);
  const idat = [];
  for (let i = 8; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const pixels = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    // scripts/build-icons.mjs writes every row with filter 0.
    assert.equal(raw[y * (stride + 1)], 0, 'unfiltered rows');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { w, h, pixels };
}

test('the manifest has an id and a maskable icon', () => {
  assert.equal(manifest.id, '/');
  const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
  assert.equal(maskable.length, 1);
  assert.equal(maskable[0].sizes, '512x512');
  // The rounded tiles stay `any`: a mask over a pre-rounded corner cuts twice.
  for (const icon of manifest.icons) {
    if (icon !== maskable[0]) assert.equal(icon.purpose, undefined);
  }
  const file = path.join(root, 'public', maskable[0].src);
  assert.ok(existsSync(file), `${maskable[0].src} is committed`);
});

test('the maskable icon is full-bleed, with all its ink inside the safe zone', () => {
  const src = manifest.icons.find((icon) => icon.purpose === 'maskable').src;
  const { w, h, pixels } = readPng(path.join(root, 'public', src));
  assert.equal(w, 512);
  assert.equal(h, 512);
  const limit = 0.4 * w;
  let ink = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // No corner cut: the launcher brings the shape.
      assert.equal(pixels[i + 3], 255, `opaque at ${x},${y}`);
      const ground = pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255;
      if (ground) continue;
      ink++;
      // The pixel's farthest corner, not its centre.
      const dx = Math.max(Math.abs(x - w / 2), Math.abs(x + 1 - w / 2));
      const dy = Math.max(Math.abs(y - h / 2), Math.abs(y + 1 - h / 2));
      assert.ok(Math.hypot(dx, dy) <= limit, `ink at ${x},${y} is outside the safe zone`);
    }
  }
  assert.ok(ink > 1000, 'the mark is actually on it');
});

// --------------------------------------------------- the material, refused

/** The body of the first top-level block whose head matches. */
function block(head) {
  const at = css.indexOf(head);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return { at, body: css.slice(css.indexOf('{', at) + 1, i) };
  }
  return null;
}

/** `--name: value` pairs of the rule with exactly this selector inside a body. */
function rule(body, selector) {
  for (const [, head, inner] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (head.trim() !== selector) continue;
    return Object.fromEntries([...inner.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()]));
  }
  return null;
}

test('asking the system for less transparency gets every glass token opaque', () => {
  const fallback = block('@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)');
  assert.ok(fallback, 'the fallback block exists');
  const glass = block('@supports ((-webkit-backdrop-filter: blur(50px))');
  assert.ok(fallback.at > glass.at, 'after the glass, or the glass wins on order');

  const opaque = (value) => /^var\(--g-surface(-2)?\)$/.test(value) || /^#[0-9a-f]{6}$/i.test(value);
  for (const scope of [':root[data-skin="apple"]', ':root[data-skin="apple"][data-theme="dark"]']) {
    const tokens = rule(fallback.body, scope);
    assert.ok(tokens, `${scope} is covered`);
    for (const tier of ['', '-thick', '-thin']) {
      assert.equal(tokens[`--g-card-filter${tier}`], 'none', `${scope} --g-card-filter${tier}`);
      assert.ok(opaque(tokens[`--g-card-bg${tier}`]), `${scope} --g-card-bg${tier} is solid`);
    }
    // Every scope that makes the glass translucent is undone here.
    const translucent = rule(glass.body, scope);
    for (const name of Object.keys(translucent)) assert.ok(name in tokens, `${scope} ${name}`);
  }

  // The classic look never had glass to undo.
  const classic = rule(css, ':root');
  for (const tier of ['', '-thick', '-thin']) {
    assert.equal(classic[`--g-card-filter${tier}`], 'none');
  }
});

test('no backdrop-filter anywhere saturates what it blurs', () => {
  // maps.apple.com's material is blur alone; see the --g-card-filter notes.
  for (const [, value] of css.matchAll(/backdrop-filter\s*:\s*([^;]+);/g)) {
    assert.ok(!/saturate\(/.test(value), value);
  }
  for (const [, value] of css.matchAll(/--g-card-filter[\w-]*\s*:\s*([^;]+);/g)) {
    assert.ok(!/saturate\(/.test(value), value);
  }
});

test('the building-kind counts are drawn at full ink', () => {
  const count = rule(css, '.g-kind-count');
  assert.ok(count, '.g-kind-count exists');
  const body = css.match(/\.g-kind-count\s*\{([^}]*)\}/)[1];
  assert.ok(!/opacity/.test(body), 'no opacity taking it under 4.5:1');
});

test('the no-results row is styled as text, not as a row you can press', () => {
  assert.match(css, /\.g-results li\.g-result-empty\s*\{[^}]*cursor:\s*default/);
  assert.match(css, /\.g-results li\.g-result-empty:hover,\s*\.g-results li\.g-result-empty:active\s*\{[^}]*background:\s*transparent/);
});
