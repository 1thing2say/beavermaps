// Turning a payload into bytes on the wire, and choosing which bytes.
//
// Its own module because it is four pure functions with an HTTP contract that
// has more corners than it looks like it has — `gzip;q=0` means no, Vary is
// load-bearing for any cache in between, and an ETag has to name the resource
// rather than the encoding it happened to be sent in. server/index.js reads as
// a router with these out of it, and test/wire.test.js can hold them to the
// contract without standing a server up to do it.

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * `no-cache` means "you may cache this, but ask before reusing it" — not "do
 * not cache". Every answer below carries an ETag, so the ask costs one
 * conditional request and comes back 304 with an empty body whenever the data
 * has not changed.
 *
 * This replaces `max-age=300`, which was five minutes during which the browser
 * would not even ask. Regenerating an overlay and reloading the page then
 * showed the old geometry with a fresh server sitting right there answering
 * correctly, and the only ways out were a hard reload or waiting it out. The
 * data is served from memory and changes only when a build script runs, so
 * revalidating is close to free and being stale is not.
 */
const REVALIDATE = 'no-cache';

/**
 * Express's own ETag shape, since these responses no longer go through the
 * `res.json` that would have set one.
 *
 * Off the RAW bytes rather than the compressed ones, deliberately: it is a tag
 * for the resource, and the identity of the campus basemap does not change
 * according to whether the client that asked for it can accept gzip. Tagging
 * the compressed form would hand two different tags to the same file and cost a
 * cache miss every time a client's Accept-Encoding changed.
 */
export function etagFor(raw) {
  const hash = createHash('sha1').update(raw).digest('base64').slice(0, 27);
  return `W/"${raw.length.toString(16)}-${hash}"`;
}

/** Bytes, in both the forms a client might ask for them in. */
export function wireBytes(raw) {
  return { raw, gzip: gzipSync(raw, { level: 6 }), etag: etagFor(raw) };
}

/** The same, for something that still has to be turned into JSON first. */
export function wireForm(value) {
  return wireBytes(Buffer.from(JSON.stringify(value)));
}

/**
 * Whether the client will accept gzip — which is not the same question as
 * whether it mentioned it. `gzip;q=0` is how a client says "I know what that is
 * and I do not want it", and a substring test reads that as a yes.
 */
export function acceptsGzip(header = '') {
  return header.split(',').some((entry) => {
    const [coding, ...params] = entry.trim().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    return !params.some((p) => /^q=0(\.0*)?$/.test(p.trim()));
  });
}

/**
 * Answer with whichever form the client said it could read.
 *
 * `Vary: Accept-Encoding` is not decoration — without it a shared cache that
 * stored the gzipped answer would go on handing it to a client that never asked
 * for gzip, which reads as a corrupt file rather than as a slow one.
 */
export function sendWire(req, res, wire) {
  res.set('Cache-Control', REVALIDATE);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  res.set('ETag', wire.etag);

  // The conditional request REVALIDATE exists to make cheap. If-None-Match is a
  // list, so this is a membership test rather than an equality one.
  const asked = (req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim());
  if (asked.includes(wire.etag)) return res.status(304).end();

  const gzipped = acceptsGzip(req.headers['accept-encoding']);
  const body = gzipped ? wire.gzip : wire.raw;
  if (gzipped) res.set('Content-Encoding', 'gzip');
  // Stated rather than inferred, so every answer carries the one number a
  // progress bar can read.
  res.set('Content-Length', String(body.length));
  return res.end(body);
}

// ---------------------------------------------------------------------------
// The built front-end
// ---------------------------------------------------------------------------

/**
 * Which built files are worth compressing.
 *
 * Everything Vite emits into dist/ is text except the images, and an already
 * compressed PNG only gets bigger for the trouble. `.gz` is here because a
 * precompressed file would be double-encoded.
 */
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|map|txt|webmanifest)$/i;

/**
 * Below this, gzip is not worth its own framing — the header and trailer are
 * about 20 bytes and a small file barely shrinks. It is also the size at which
 * a saving stops being visible on any connection.
 */
const MIN_COMPRESS = 1024;

/**
 * Serve dist/ compressed, and tell caches how long each file is good for.
 *
 * A layer IN FRONT of express.static rather than a replacement for it. It
 * answers only the case it improves — a compressible file, to a client that
 * asked for gzip — and calls next() for everything else, so ranges, HEAD,
 * directory indexes, 304s and the traversal guards stay express.static's
 * problem rather than becoming mine.
 *
 * MEMOISED ON mtime AND SIZE, so `npm run build` is picked up without a restart
 * while a file that has not changed is compressed once no matter how many
 * phones ask for it. That is the same reasoning as the API payloads above and
 * the opposite conclusion from the dev server's, which compresses per request
 * because its bytes change every time a file is saved. The difference is
 * whether the thing being served holds still.
 *
 * CACHING IS THE OTHER HALF and is worth as much as the compression on a second
 * visit. Vite writes a content hash into every asset filename, so those bytes
 * can never change under that name and are safe to keep for a year — `immutable`
 * says so explicitly, which stops a browser revalidating them on a reload.
 * index.html is the one file with a stable name, and it is what names the
 * hashed assets, so it has to be re-asked for every time or a rebuild is
 * invisible.
 */
export function compressedStatic(dir) {
  const cache = new Map();

  return function serveCompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!COMPRESSIBLE.test(req.path)) return next();
    if (!acceptsGzip(req.headers['accept-encoding'])) return next();

    // The traversal guard: a resolved path that is not inside dir is not ours,
    // whatever it looks like. express.static does this too — this middleware
    // just must not be the hole in it.
    const file = path.resolve(dir, `.${req.path}`);
    if (file !== dir && !file.startsWith(dir + path.sep)) return next();

    let stat;
    try {
      stat = statSync(file);
    } catch {
      return next();                       // missing, or not a file we can read
    }
    if (!stat.isFile() || stat.size < MIN_COMPRESS) return next();

    const stamp = `${stat.mtimeMs}:${stat.size}`;
    let entry = cache.get(file);
    if (entry?.stamp !== stamp) {
      entry = { stamp, ...wireBytes(readFileSync(file)) };
      cache.set(file, entry);
    }

    // A hashed name cannot change its contents, so it never needs asking about
    // again. Anything else — index.html above all — does.
    const hashed = req.path.startsWith('/assets/');
    res.set('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : REVALIDATE);
    res.set('Vary', 'Accept-Encoding');
    res.set('ETag', entry.etag);
    res.type(path.extname(req.path));

    const asked = (req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim());
    if (asked.includes(entry.etag)) return res.status(304).end();

    res.set('Content-Encoding', 'gzip');
    res.set('Content-Length', String(entry.gzip.length));
    return res.end(req.method === 'HEAD' ? undefined : entry.gzip);
  };
}
