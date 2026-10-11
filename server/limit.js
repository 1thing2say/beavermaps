// How often one caller may ask for a route.
//
// /api/route is the only endpoint here that is not a constant. Everything else
// was read once at boot, gzipped once at boot, and is handed out of memory — so
// the cost of answering it a thousand times is the cost of writing bytes to a
// socket. A route is a linear scan of every edge to find where each end joins
// the network, then a Dijkstra over 6,977 vertices from its ways on — about
// 0.6 ms on average and 2 ms at the 99th percentile on a development Mac (the
// slowest of a thousand 2.3 to 3.5 ms), more on a shared-cpu-1x machine with
// 512 MB — and it is reachable by anyone with the URL.
//
// A FIXED WINDOW RATHER THAN A TOKEN BUCKET, and rather than a dependency. The
// thing being defended against is a loop, not a distributed attack; the window
// only has to make a loop cost something. A bucket would smooth the boundary
// burst — twice `max` across two adjacent windows — and that burst is still two
// hundred routes a minute from one address, which this machine answers without
// noticing. Correctness at the boundary is not worth another package on the
// production dependency list.
//
// In-process, so a second machine has its own allowance. That is the right
// shape for what this is: a guard rail on a hobby-sized deployment, not a quota.

/** How long a window lasts, and how many requests fit in one. */
export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 120;

/**
 * A fixed-window counter, keyed by whatever the caller counts by.
 *
 * `now` is injectable because the whole of this module's behaviour is a
 * function of the clock, and a test that has to sleep for a minute to check a
 * window rolls over is a test nobody runs.
 *
 * SWEPT ON WRITE rather than on a timer. The map holds one small row per
 * caller per window and a `setInterval` to clean it would keep the event loop
 * alive for the sake of a few hundred bytes.
 *
 * AT MOST ONCE PER WINDOW, not on every new caller. The sweep is a walk of the
 * whole map, and it used to run whenever a key arrived that had no live row —
 * which is every request from somebody new, so n new callers in a minute cost
 * n walks of up to n rows each. Once per window is enough to keep the bound
 * that matters: a row lives for one window, waits at most one more for the
 * next sweep, and so the map never holds more than the distinct callers of the
 * last two windows.
 *
 * NO CAP ON THE MAP, deliberately. Refusing a new key when the map is full
 * would hand the whole endpoint to whoever filled it — a denial of service
 * built out of the guard against one. Two windows of distinct callers is a
 * bound already, and at about a hundred bytes a row it is not one this
 * deployment can reach before something else gives out first.
 *
 * `take.size` reports the number of rows, for the test that holds the sweep to
 * the bound above; nothing in the server reads it.
 */
export function createRateLimit({
  windowMs = WINDOW_MS,
  max = MAX_PER_WINDOW,
  now = Date.now,
} = {}) {
  const windows = new Map();
  let nextSweep = -Infinity;

  function sweep(at) {
    if (at < nextSweep) return;
    nextSweep = at + windowMs;
    for (const [key, entry] of windows) {
      if (entry.until <= at) windows.delete(key);
    }
  }

  function take(key) {
    const at = now();
    let entry = windows.get(key);
    if (!entry || entry.until <= at) {
      sweep(at);
      entry = { count: 0, until: at + windowMs };
      windows.set(key, entry);
    }

    entry.count += 1;
    const allowed = entry.count <= max;
    return {
      allowed,
      limit: max,
      // Never negative: a caller well past the line does not need to be told
      // how far past, and a negative number in a header is a lie about a
      // quantity that cannot be one.
      remaining: Math.max(0, max - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.until - at) / 1000)),
    };
  }

  Object.defineProperty(take, 'size', { get: () => windows.size });
  return take;
}

/**
 * Who a request counts as, for the limit above.
 *
 * ON FLY, `Fly-Client-IP`. With one trusted hop (see `trust proxy` in app.js)
 * `req.ip` is the right-most entry of X-Forwarded-For, and behind fly-proxy
 * that entry is an address on Fly's side of the connection, the same for every
 * visitor — so every visitor shared one bucket: 120 routes a minute for the
 * whole site, and one script at two a second turned directions off for
 * everybody. fly-proxy sets
 * Fly-Client-IP itself to the address that connected to it, which is the
 * visitor's (or a CDN's, if one is ever put in front — at which point this is
 * the line to change).
 *
 * ONLY ON FLY, which is what FLY_APP_NAME says — Fly sets it in every machine's
 * environment. Anywhere else nothing strips that header on the way in, so it is
 * whatever the client wrote, and keying on it would make the limit a header
 * field anybody can rotate.
 *
 * OFF FLY, `req.ip` is NO DEFENCE EITHER, and that is accepted rather than
 * fixed. `trust proxy 1` makes Express treat whatever is on the other end of the
 * socket as the trusted hop, so when nothing is in front a client that connects
 * directly sets `req.ip` to the right-most entry of its own X-Forwarded-For and
 * can rotate that just as freely. Off Fly means `npm run dev` and the tests,
 * where nobody is being protected from anybody; the key there only has to keep
 * one ordinary client in one bucket, which it does. Running this behind some
 * other proxy in production means revisiting both this and `trust proxy` in
 * app.js — test/app.test.js pins the off-Fly behaviour so it is the documented
 * one.
 */
export function clientKey(req, env = process.env) {
  return (env.FLY_APP_NAME && req.get('fly-client-ip')) || req.ip || 'unknown';
}
