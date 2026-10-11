// Stopping, on purpose.
//
// Fly stops a machine by sending it SIGTERM and, some seconds later, SIGKILL —
// on every deploy, and every time an idle machine is scaled to zero. Node's
// default for SIGTERM is to die on the spot, which drops whatever was half
// written: a route a phone has been waiting on comes back as a reset connection
// and the client's "couldn't reach directions" with it. Every request here is
// answered out of memory in milliseconds, so letting the ones in flight finish
// costs nothing worth measuring and is the difference between a deploy nobody
// notices and one somebody does.
//
// Its own module so the decision can be tested without a real signal or a
// real exit — see test/shutdown.test.js.

/**
 * How long in-flight requests get before the process goes anyway.
 *
 * Eight seconds, because it has to finish inside the gap Fly leaves between
 * SIGTERM and SIGKILL, and fly.toml sets that gap with `kill_timeout = "10s"`.
 * Anything at or past ten and SIGKILL arrives first: the slow request is cut
 * off all the same, and the process dies without the "exiting anyway" line
 * that says why. Eight leaves a second and more of slack for the log line and
 * the exit. Without that line in fly.toml the gap is Fly's default of five
 * seconds and this would have to go back under four — test/shutdown.test.js
 * reads fly.toml and holds it to whichever is there.
 *
 * Nothing here takes a fraction of a second; what can take eight is a client
 * holding a slow upload open, and that is not a client worth holding a deploy
 * for any longer.
 */
export const GRACE_MS = 8000;

/**
 * Stop taking connections on SIGTERM or SIGINT, exit 0 once the ones already
 * open have finished, and exit 1 if that takes longer than `graceMs`.
 *
 * `server.close()` stops listening and, on Node 19 and later, also closes the
 * idle keep-alive sockets, so a browser holding one open does not count as
 * work in flight. The fallback timer is unref'd so it is never itself the
 * thing keeping the process alive.
 *
 * A SECOND SIGNAL IS IGNORED rather than starting a second close: `close()`
 * twice is an ERR_SERVER_NOT_RUNNING thrown out of a signal handler. Ctrl-C
 * pressed twice in `npm run dev` therefore waits for the same grace period as
 * once, which is at worst eight seconds and normally none.
 *
 * Everything that touches the process is injectable, which is the whole of
 * what makes this testable: the test hands it a fake server, a fake `on` and an
 * `exit` that records instead of exiting.
 */
export function closeOnSignal(server, {
  signals = ['SIGTERM', 'SIGINT'],
  graceMs = GRACE_MS,
  on = (signal, handler) => process.on(signal, handler),
  exit = (code) => process.exit(code),
  log = console.log,
} = {}) {
  let closing = false;

  function shutDown(signal) {
    if (closing) {
      log(`[beavermaps] ${signal} again — already shutting down`);
      return;
    }
    closing = true;
    log(`[beavermaps] ${signal} — finishing open requests, then exiting`);

    const giveUp = setTimeout(() => {
      log(`[beavermaps] requests still open after ${graceMs}ms — exiting anyway`);
      exit(1);
    }, graceMs);
    giveUp.unref?.();

    server.close((err) => {
      clearTimeout(giveUp);
      if (err) console.error(err);
      exit(err ? 1 : 0);
    });
  }

  for (const signal of signals) on(signal, () => shutDown(signal));
  return shutDown;
}
