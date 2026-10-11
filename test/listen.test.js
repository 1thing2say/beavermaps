// server/index.js — what happens when the port cannot be bound.
//
// Express 5 passes a bind error to the listen callback instead of throwing it.
// A callback that ignored it logged "listening" and exited 0, which reads as
// success to a supervisor and to anyone reading the log. These tests start the
// real entry point as a child process, because the failure is in how the
// process ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));

/** Runs the server with `env` added, and resolves once it exits. */
function runServer(env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('a port that is already taken is reported and exits non-zero', async () => {
  // Same host the server binds, so the second bind collides on every platform.
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '0.0.0.0', resolve));
  const { port } = holder.address();

  try {
    const run = await runServer({ PORT: String(port) });
    assert.notEqual(run.code, 0, `exited ${run.code}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /EADDRINUSE/);
    assert.match(run.stderr, new RegExp(`could not listen on port ${port}`));
    assert.doesNotMatch(run.stdout, /listening on/);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});
