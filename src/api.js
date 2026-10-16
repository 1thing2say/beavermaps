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
 * What a visitor is told when a route request never got an answer.
 *
 * TWO AUDIENCES, ONE CONSTANT. This used to be "is `npm run dev` still
 * running?" everywhere, which is the right question for the one person running
 * the dev server and a baffling one for everybody on the deployed site — who
 * cannot run anything, and who were also being told it for our own 429. The
 * developer's sentence survives only where `import.meta.env.DEV` is true, which
 * Vite folds to a constant, so the production bundle says the other one.
 *
 * `?.` on `env` because node runs these modules for the tests with no Vite in
 * front of them, and there `import.meta.env` does not exist at all.
 *
 * @param {boolean} dev  whether this is the dev server
 */
export function unreachableFor(dev) {
  return dev
    ? 'Routing server unreachable — is `npm run dev` still running?'
    : "Couldn't reach directions right now. Check your connection and try again.";
}
export const UNREACHABLE = unreachableFor(Boolean(import.meta.env?.DEV));

/**
 * What is said when the routing graph never arrived at boot.
 *
 * Different from UNREACHABLE because it is a different state. One request
 * failing is worth trying again in a moment; a session that never received the
 * network has nothing to route over until the page is loaded again, and "try
 * again" without saying HOW would send somebody back to a button that cannot
 * work. The developer still gets the dev-server question, for the reason above.
 */
export const ROUTING_OUTAGE = import.meta.env?.DEV
  ? unreachableFor(true)
  : 'Directions are unavailable right now — reload to try again.';

/**
 * How long a route request may take before it counts as unreachable.
 *
 * The server answers in tens of milliseconds, so this is not a budget for the
 * router. It is the point at which a phone on a connection that has silently
 * dropped stops showing "Calculating route…" under a spinner and says something
 * it can act on — without it the wait is the browser's own, which is minutes.
 */
const ROUTE_TIMEOUT_MS = 15_000;

/**
 * How long a boot-time request may take before it counts as failed, in ms.
 *
 * Generous, because the largest of them — /api/basemap — is about 1.6 MB, and
 * the ceiling covers reading the body as well as the response arriving. What
 * it rules out is the wait being the browser's own. On a connection that has
 * silently dropped (a handover between networks, a captive portal that took
 * the connection and never answered) that is minutes, and until it ends
 * "Loading the campus…" spins and the routing outage can never be said.
 *
 * Per attempt, and a timeout is NOT retried: three more ceilings on top of the
 * first would be well over a minute of spinner before the outage is said, and
 * a connection that gave nothing for twenty seconds is not the blip
 * RETRY_DELAYS_MS is for.
 */
export const BOOT_TIMEOUT_MS = 20_000;

/**
 * The waits between attempts at a boot-time request, in ms.
 *
 * Three retries over about six seconds: long enough to ride out a machine
 * restarting under a deploy or a phone handing over between networks, short
 * enough that a server that is really down is reported while somebody is still
 * looking at the screen.
 */
export const RETRY_DELAYS_MS = [500, 1500, 4000];

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `attempt` until it succeeds, retrying only what might succeed next time.
 *
 * NETWORK ERRORS AND 5xx ONLY, which is the whole of the judgement here. A
 * fetch that never reached the server, or a server that fell over answering,
 * may well work half a second later. A 404 is a 404 on every attempt — a
 * deployment that lost a file — and retrying it is six seconds of spinner
 * before saying what was already known. The errors this module throws carry
 * `transient` to say which kind they are; anything without it is rethrown at
 * once.
 *
 * @param {() => Promise<any>} attempt
 * @param {object}   [options]
 * @param {number[]} [options.delays]  the waits between attempts
 * @param {Function} [options.sleep]   stand-in for the wait, for tests
 */
export async function withRetry(attempt, { delays = RETRY_DELAYS_MS, sleep = sleepFor } = {}) {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!error?.transient || tried >= delays.length) throw error;
      await sleep(delays[tried]);
    }
  }
}

/** A status that is not ok, as an error that says whether to ask again. */
function statusError(what, status) {
  const error = new Error(`${what} request failed (${status})`);
  error.status = status;
  error.transient = status >= 500;
  return error;
}

/**
 * @param {Function} [request]        stand-in for `fetch`, for tests
 * @param {Function} [sleep]          stand-in for the wait between retries, for tests
 * @param {number}   [bootTimeoutMs]  the ceiling on each boot-time GET, for tests
 */
export function createApi({
  request = (...args) => globalThis.fetch(...args),
  sleep = sleepFor,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
} = {}) {
  /**
   * One GET, retried, each attempt with a ceiling on the wait.
   *
   * A rejection from `request` itself is a request that never reached the
   * server — offline, DNS, a connection reset mid-deploy — so it is marked
   * transient on the way past, unless it is the ceiling firing: the browser's
   * TimeoutError, which is final (see BOOT_TIMEOUT_MS). A status that is not ok
   * is classed by statusError.
   *
   * A fresh signal per attempt, since a timeout signal starts counting when it
   * is made. Feature-tested because AbortSignal.timeout is a 2022 API, and a
   * browser without it should still load — just without the ceiling.
   */
  function getJson(path, what) {
    return withRetry(async () => {
      const timeout = globalThis.AbortSignal?.timeout;
      let response;
      try {
        response = await request(
          path,
          typeof timeout === 'function' ? { signal: AbortSignal.timeout(bootTimeoutMs) } : undefined,
        );
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(`${what} request failed`);
        failure.transient = failure.name !== 'TimeoutError';
        throw failure;
      }
      if (!response.ok) throw statusError(what, response.status);
      return response.json();
    }, { sleep });
  }

  /**
   * Ask the server for a route. The graph and the maneuver derivation both live
   * there — this file never builds a PathFinder.
   *
   * Three shapes come back, because the server distinguishes three answers:
   *
   *   the route            it found one
   *   null                 both ends are on the graph and nothing joins them (404)
   *   { refused: '…' }     the request does not describe a walk (422), or this
   *                        visitor has asked for too many too fast (429)
   *
   * The 422 is the server enforcing REACH_M and refusing a zero-length walk.
   * REACH_M is also enforced in locateStart — and has to go on being,
   * because the browser can refuse before spending a round trip. What matters
   * is that the server refuses too, so the rule holds for a start point that
   * did not come from our own front end. Its sentence is the one from
   * src/directions.js, written once and said by whichever side noticed first.
   *
   * NOT RETRIED, unlike everything below it. Somebody is watching this one
   * wait, and the sentence a failure produces already says to try again —
   * repeating the request behind their back would only make it arrive later.
   */
  async function route(from, to) {
    const response = await request('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
      // Feature-tested because it is a 2022 API, and a browser without it
      // should still route — just without a ceiling on the wait.
      ...(typeof AbortSignal?.timeout === 'function'
        ? { signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) }
        : {}),
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
    // 429 is the rate limit, and it is an ANSWER as well: the server is up, it
    // will just not route for this visitor for a moment. It used to fall
    // through to the throw below and come out as "routing server unreachable",
    // which sent people looking for an outage that did not exist. A refusal
    // instead, in the server's words, which already say to wait; the fallback
    // says the same for a body that could not be read.
    if (response.status === 429) {
      const payload = await response.json().catch(() => null);
      return { refused: payload?.error ?? 'Too many directions requests — try again in a moment.' };
    }
    if (!response.ok) throw statusError('route', response.status);
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
