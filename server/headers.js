// The response headers that are about the browser's behaviour rather than about
// the payload: what it may load, what it may ask the visitor for, and whether
// it may ever come back over plain HTTP.
//
// Its own module for the same reason wire.js is: these are a handful of pure
// functions with a contract that is easy to get silently wrong — a policy that
// forgets one host turns the flyover off with nothing but a console line to say
// why — and test/headers.test.js can hold them to it without a server.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Everything the built app fetches from somebody else, by directive, and who
 * asks for it. Read off the source and off a built dist/, not off a
 * library's documentation, because the documentation describes the library
 * and this describes what this app actually does with it:
 *
 * - MAPBOX. `api.mapbox.com` serves the style, sprites, glyphs and (for v3)
 *   the vector tiles; `events.mapbox.com` is the SDK's own telemetry, which
 *   it posts whether or not anybody reads it; `*.tiles.mapbox.com` is where
 *   older tile URLs still resolve and is on Mapbox's own CSP list. The map
 *   draws from a blob: worker and decodes sprites into blob: and data: images.
 *
 * - GOOGLE. `tile.googleapis.com` is every Google request this app makes —
 *   createSession, the 2D tiles and the viewport credits in google-tiles.js,
 *   and the 3D tileset and its content in flyover-view.js.
 *
 * - LOADERS.GL, for the flyover. `worker: true` in flyover-view.js makes it
 *   start a worker whose script lives on `unpkg.com` — wrapped in a blob: URL
 *   with an `importScripts` inside, which is why both appear — and that worker
 *   then pulls Google's Draco decoder from `www.gstatic.com` (a script by
 *   importScripts and a .wasm by fetch). Compiling that .wasm is what
 *   `'wasm-unsafe-eval'` is for; it permits WebAssembly and nothing else, not
 *   eval. Self-hosting the workers and the decoder would take three hosts off
 *   this list, and is the thing to do before this policy is enforced.
 *
 * - INLINE STYLE is allowed. Mapbox, deck.gl and this app position and
 *   colour elements from script constantly; writes through `el.style` are not
 *   what style-src governs, but a `style` attribute arriving in markup or a
 *   library-injected <style> is, and a library update that moves from one to
 *   the other should not cost the map its markers. Style injection is a far
 *   weaker attack than script injection, which is what this policy is for.
 *   Inline SCRIPT is not allowed wholesale: index.html's inline scripts
 *   (today the theme and the skin, both set before first paint) are allowed
 *   by hash, computed from the built file — see inlineScriptHashes — so they
 *   can be edited freely and an injected one still is not.
 *
 * What is deliberately NOT here: `cdn.jsdelivr.net` appears in the bundle
 * too, for luma.gl's spector.js debugger, which only loads behind a debug
 * switch this app never turns on. (luma.gl's webgl-debug is on unpkg.com and
 * so is covered anyway, by accident rather than by intent.)
 */
export const SOURCES = {
  mapbox: ['https://api.mapbox.com', 'https://events.mapbox.com', 'https://*.tiles.mapbox.com'],
  google: ['https://tile.googleapis.com'],
  loaders: ['https://unpkg.com', 'https://www.gstatic.com'],
};

/**
 * The SHA-256 of every inline <script> in a document, as CSP source tokens.
 *
 * Hashed exactly as a browser hashes them — the bytes between the opening tag's
 * `>` and `</script>`, whitespace and all — because a hash of a trimmed or
 * re-indented copy matches nothing. A <script src> is skipped: its body is
 * empty and it is allowed by origin.
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attributes, body] = match;
    if (/\bsrc\s*=/i.test(attributes)) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** The policy itself, as one header value. */
export function contentSecurityPolicy({ scriptHashes = [] } = {}) {
  const { mapbox, google, loaders } = SOURCES;
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...scriptHashes, ...loaders],
    // Mapbox's and loaders.gl's workers are both blob: URLs; a blob: worker
    // inherits this document's policy, so everything the loaders.gl worker
    // imports and fetches is governed by script-src and connect-src above and
    // below, not by a policy of its own.
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    // data: and blob: for glTF buffers and textures inside a tile, which
    // loaders.gl reads through fetch like everything else.
    'connect-src': ["'self'", ...mapbox, ...google, ...loaders, 'data:', 'blob:'],
    // Telemetry is never an image, so events.mapbox.com is left off this one.
    'img-src': ["'self'", 'data:', 'blob:', ...mapbox.filter((src) => !src.includes('events.')), ...google],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // The policy-level twin of X-Frame-Options: DENY, for the browsers that
    // read this and ignore that.
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/**
 * What the page may ask the visitor's device for. Location, because "directions
 * from here" is the feature; and nothing else, said explicitly, so a script that
 * ends up on the page by any route cannot ask for the camera either.
 */
export const PERMISSIONS_POLICY = 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()';

/**
 * HTTPS only from now on, for a year — but for THIS host only.
 *
 * No `includeSubDomains` and no `preload` until the domain is final: either one
 * is a promise about names this app does not own yet, and HSTS is the kind of
 * promise a browser keeps for the full max-age whatever the server says later.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

/**
 * Every header here, as one middleware.
 *
 * CSP IS REPORT-ONLY, deliberately. The list above was derived by reading the
 * code, and a policy that is wrong about one host in enforcing mode is a map
 * with no flyover. Report-Only puts every violation in the visitor's console
 * and blocks nothing; once a deploy has run clean under it, renaming the header
 * to `Content-Security-Policy` is the whole change. There is no report-uri:
 * collecting reports is a privacy question (they carry the page URL) that is
 * not this middleware's to answer.
 *
 * THE SCRIPT HASHES COME FROM dist/index.html and are re-read when it changes,
 * on its mtime and size, for the same reason compressedStatic in wire.js
 * re-reads assets: `npm run build` against a running server should not leave the
 * policy describing the previous build. Without a dist/ there is no page to
 * protect and the policy simply carries no hashes.
 *
 * HSTS only when the request actually came in over HTTPS. `req.secure` reads
 * X-Forwarded-Proto through the one trusted proxy hop (see `trust proxy` in
 * app.js) — on Fly that is https for every request force_https lets through.
 * Over plain HTTP it would be wasted bytes: browsers ignore
 * Strict-Transport-Security on a response that did not come over a secure
 * connection (RFC 6797 §8.1). The case that matters is an HTTPS localhost
 * (`npm run dev` serves one): there the browser would honour it, and since HSTS
 * pins the whole host rather than one port, every server on localhost —
 * `npm run dev:http` included — would be forced to HTTPS for a year. Under
 * `npm run dev` that cannot happen: Vite serves the page, and its /api proxy
 * reaches this server over plain HTTP without adding X-Forwarded-Proto, so
 * `req.secure` is false and no header goes back through it.
 */
export function securityHeaders({ distDir } = {}) {
  const indexFile = distDir ? path.join(distDir, 'index.html') : null;
  let stamp = null;
  let policy = contentSecurityPolicy();

  function currentPolicy() {
    if (!indexFile) return policy;
    let stat;
    try {
      stat = statSync(indexFile);
    } catch {
      return policy;
    }
    const next = `${stat.mtimeMs}:${stat.size}`;
    if (next !== stamp) {
      stamp = next;
      policy = contentSecurityPolicy({ scriptHashes: inlineScriptHashes(readFileSync(indexFile, 'utf8')) });
    }
    return policy;
  }

  return function setSecurityHeaders(req, res, next) {
    // `nosniff` is the load-bearing one of the original three: without it a
    // browser is free to decide for itself that a response is HTML whatever
    // the Content-Type said, and every payload here is attacker-influenced in
    // the trivial sense that a place name comes out of a data file. The frame
    // and referrer lines are cheap and there is no case where this map wants
    // to be in somebody else's iframe or to name the page a visitor came from
    // to a third party.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', PERMISSIONS_POLICY);
    res.set('Content-Security-Policy-Report-Only', currentPolicy());
    if (req.secure) res.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    next();
  };
}
