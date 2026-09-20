// How often one caller may ask for a route.
//
// /api/route is the only endpoint here that is not a constant. Everything else
// was read once at boot, gzipped once at boot, and is handed out of memory — so
// the cost of answering it a thousand times is the cost of writing bytes to a
// socket. A route is a Dijkstra over 7,145 segments preceded by a linear scan
// of 6,523 vertices, on a shared-cpu-1x machine with 512 MB, and it is reachable
// by anyone with the URL.
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
 * alive for the sake of a few hundred bytes. Every call already touches the
 * map, so every call can drop what has expired — bounded by the number of
 * distinct callers inside one window, which is the number this is limiting.
 */
export function createRateLimit({
  windowMs = WINDOW_MS,
  max = MAX_PER_WINDOW,
  now = Date.now,
} = {}) {
  const windows = new Map();

  function sweep(at) {
    for (const [key, entry] of windows) {
      if (entry.until <= at) windows.delete(key);
    }
  }

  return function take(key) {
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
  };
}
