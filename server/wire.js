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

/** One payload, in both the forms a client might ask for it in. */
export function wireForm(value) {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, gzip: gzipSync(raw, { level: 6 }), etag: etagFor(raw) };
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
