// server/shutdown.js — stopping on SIGTERM without dropping what is in flight.
//
// Fly sends SIGTERM on every deploy and every scale-to-zero. The unit tests
// drive the decision with a fake server and an `exit` that records; the last
// one sends a real SIGTERM to a real `node server/index.js`, because the
// wiring in index.js is the part a fake cannot check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closeOnSignal, GRACE_MS } from '../server/shutdown.js';
import { root } from './helpers.js';

/** A server whose close() finishes when the test says so. */
function fakeServer() {
  return {
    closes: 0,
    done: null,
    close(callback) { this.closes += 1; this.done = callback; },
  };
}

function harness(options = {}) {
  const server = fakeServer();
  const handlers = {};
  const exits = [];
  closeOnSignal(server, {
    on: (signal, handler) => { handlers[signal] = handler; },
    exit: (code) => exits.push(code),
    log: () => {},
    ...options,
  });
  return { server, handlers, exits };
}

test('listens for both SIGTERM and SIGINT', () => {
  const { handlers } = harness();
  assert.deepEqual(Object.keys(handlers).sort(), ['SIGINT', 'SIGTERM']);
});

test('a signal closes the server and exits 0 once it has closed', () => {
  const { server, handlers, exits } = harness();
  handlers.SIGTERM();
  assert.equal(server.closes, 1);
  assert.deepEqual(exits, [], 'exited before the requests in flight had finished');
  server.done();
  assert.deepEqual(exits, [0]);
});

test('a repeated signal does not close twice', () => {
  // close() on a server that is already closing throws ERR_SERVER_NOT_RUNNING,
  // from inside a signal handler.
  const { server, handlers, exits } = harness();
  handlers.SIGTERM();
  handlers.SIGINT();
  handlers.SIGTERM();
  assert.equal(server.closes, 1);
  server.done();
  assert.deepEqual(exits, [0]);
});

test('requests that outlast the grace period are cut off with exit 1', async () => {
  const { server, handlers, exits } = harness({ graceMs: 20 });
  handlers.SIGTERM();
  await new Promise((done) => setTimeout(done, 60));
  assert.deepEqual(exits, [1]);
  assert.equal(server.closes, 1);
});

test('a close error is an exit 1, not a clean one', () => {
  const { server, handlers, exits } = harness();
  handlers.SIGTERM();
  const original = console.error;
  console.error = () => {};
  try { server.done(new Error('boom')); } finally { console.error = original; }
  assert.deepEqual(exits, [1]);
});

test('the grace period fits inside the kill_timeout fly.toml actually leaves', () => {
  // Read from fly.toml rather than assumed, so the two cannot drift apart: with
  // no kill_timeout there, Fly's default of 5 s is the window, and GRACE_MS has
  // to end inside it with a second to spare for the log line and the exit, or
  // SIGKILL arrives first and the fallback never gets to say anything. If
  // fly.toml later sets a longer one, this still holds and GRACE_MS is free to
  // grow into it.
  const toml = readFileSync(path.join(root, 'fly.toml'), 'utf8');
  const set = toml.match(/^\s*kill_timeout\s*=\s*"?(\d+)(ms|s)?"?/m);
  const windowMs = set ? Number(set[1]) * (set[2] === 'ms' ? 1 : 1000) : 5000;
  assert.ok(GRACE_MS <= windowMs - 1000,
    `GRACE_MS ${GRACE_MS} leaves no second before Fly's SIGKILL at ${windowMs}ms`);
  assert.ok(GRACE_MS >= 1000, 'too short to let an ordinary request finish');
});

test('the real server exits 0 on SIGTERM', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: { ...process.env, PORT: '0', FLY_APP_NAME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`exited ${code} before listening:\n${output}`)));
  });

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  await health.json();

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.equal(signal, null, `killed by ${signal} rather than exiting:\n${output}`);
  assert.equal(code, 0, output);
  assert.match(output, /SIGTERM — finishing open requests/);
});
