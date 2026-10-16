// The four questions this app asks its own server.
//
// Small, and its own module for one reason: every one of them decides what a
// non-200 MEANS, and those decisions are the app's error behaviour. A 404 from
// /api/route is an answer — "both ends are on the graph and nothing joins them"
// — while a 404 from /api/buildings is a deployment that lost a file. Reading
// them as the same thing is how a missing overlay becomes a silent empty layer
// and a genuine routing failure becomes an exception nobody catches.
//
// Inside startApp() none of that could be exercised. Here `fetch` is an
// argument, so test/api.test.js can hand it each status in turn.

/**
 * How long a boot-time request may take before it counts as failed, in ms.
 *
 * Generous, because the largest of them — /api/basemap — is about 1.6 MB, and
 * the ceiling covers reading the body as well as the response arriving. What
 * it rules out is the wait being the browser's own. On a connection that has
 * silently dropped (a handover between networks, a captive portal that took
 * the connection and never answered) that is minutes, and until it ends
 * "Loading the campus…" spins and the routing outage can never be said.
 */
export const BOOT_TIMEOUT_MS = 20_000;

/**
 * @param {Function} [request]        stand-in for `fetch`, for tests
 * @param {number}   [bootTimeoutMs]  the ceiling on each boot-time GET, for tests
 */
export function createApi({
  request = (...args) => globalThis.fetch(...args),
  bootTimeoutMs = BOOT_TIMEOUT_MS,
} = {}) {
  /**
   * One GET with a ceiling on the wait. A fresh signal per call, since a
   * timeout signal starts counting when it is made. Feature-tested because
   * AbortSignal.timeout is a 2022 API, and a browser without it should still
   * load — just without the ceiling. The rejection when it fires is the
   * browser's TimeoutError, which every caller already treats as the request
   * having failed.
   */
  async function getJson(path, what) {
    const timeout = globalThis.AbortSignal?.timeout;
    const response = await request(
      path,
      typeof timeout === 'function' ? { signal: AbortSignal.timeout(bootTimeoutMs) } : undefined,
    );
    if (!response.ok) throw new Error(`${what} request failed (${response.status})`);
    return response.json();
  }

  /**
   * Ask the server for a route. The graph and the maneuver derivation both live
   * there — this file never builds a PathFinder.
   *
   * Three shapes come back, because the server distinguishes three answers:
   *
   *   the route            it found one
   *   null                 both ends are on the graph and nothing joins them (404)
   *   { refused: '…' }     the request does not describe a walk (422)
   *
   * The last one is the server enforcing REACH_M and refusing a zero-length
   * walk. REACH_M is also enforced in locateStart — and has to go on being,
   * because the browser can refuse before spending a round trip. What matters
   * is that the server refuses too, so the rule holds for a start point that
   * did not come from our own front end. Its sentence is the one from
   * src/directions.js, written once and said by whichever side noticed first.
   */
  async function route(from, to) {
    const response = await request('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (response.status === 404) return null;          // reachable, but no path
    // 422 is "well-formed, but not a walk": an end too far from the network to
    // snap to, or both ends in the same place. The server's own sentence is
    // used verbatim, because it is the one that knows which. The fallback is
    // deliberately vague — it only runs when the body could not be read at all,
    // and a specific guess there would be a specific guess.
    if (response.status === 422) {
      const payload = await response.json().catch(() => null);
      return { refused: payload?.error ?? 'Those two points do not make a walk on the campus paths.' };
    }
    if (!response.ok) throw new Error(`route request failed (${response.status})`);
    return response.json();
  }

  /** The linework that gets DRAWN: the campus's own paths, and only those. */
  function network() {
    return getJson('/api/network', 'network');
  }

  /**
   * Every vertex the router will accept — the campus's and the surrounding
   * streets'.
   *
   * A separate request from the network above because the two answer different
   * questions. /api/network is what gets drawn, and that is the campus's
   * linework alone: the streets around the campus are already painted by
   * whichever provider is under us, and drawing ours over theirs is the doubled
   * linework at the campus edge. This is what a start's reach is CHECKED
   * AGAINST, and it has to include those streets or a fix on the pavement
   * outside would be measured to the far side of a car park.
   */
  function vertices() {
    return getJson('/api/vertices', 'vertex');
  }

  /** One of the draw-only overlays: buildings, basemap, amenities, places. */
  function overlay(name) {
    return getJson(`/api/${name}`, name);
  }

  return { route, network, vertices, overlay };
}
