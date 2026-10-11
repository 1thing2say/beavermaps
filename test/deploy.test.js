// The deploy path: package.json, the Dockerfile and `npm run deploy`.
//
// None of this is exercised by running the app, which is exactly why it needs
// tests. Each of these failed quietly the first time round: a runtime
// dependency left in devDependencies builds a clean image that dies on boot; a
// tokenless image build exits 0, passes /healthz and serves "This map cannot
// start"; and a deploy from a dirty tree puts live a tree no commit and no CI
// run has ever seen, which nobody can reproduce or roll back to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { root } from './helpers.js';

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// What the server needs at runtime

/** '@turf/helpers/dist/x' → '@turf/helpers'; 'express/lib' → 'express'. */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Every package reachable from an entry file through relative imports. JSON is
 * read with readFileSync rather than imported, and nothing here is dynamic, so
 * the static import and export-from statements are the whole graph.
 */
function packagesReachableFrom(entry) {
  const seen = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    // `import x from '…'`, `import { a,\n b } from '…'`, `export * from '…'`
    // and a bare `import '…'` — and not `export const X = '…'`, whose string
    // is a value, not a module.
    const specifiers = /^\s*(?:import|export)\s+(?:[\w\s{},*$]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;
    for (const [, spec] of source.matchAll(specifiers)) {
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.endsWith('.json')) visit(target);
      } else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
        packages.add(packageOf(spec));
      }
    }
  };
  visit(entry);
  return { files: seen, packages };
}

test('dependencies are exactly what the server imports, so the runtime image has what it needs and nothing else', () => {
  const { files, packages } = packagesReachableFrom(path.join(root, 'server', 'index.js'));
  // The walk has to actually reach into src/, or it proves nothing about the
  // modules the server borrows from the client.
  assert.ok([...files].some((f) => f.endsWith(path.join('src', 'maneuvers.js'))), 'walk reached src/maneuvers.js');

  const declared = Object.keys(pkg.dependencies ?? {}).sort();
  const needed = [...packages].sort();
  // Missing → the image built with `npm ci --omit=dev` crashes on boot with
  // ERR_MODULE_NOT_FOUND. Extra → deck.gl and friends were ~280MB of runtime
  // image that only ever reached visitors through dist/.
  assert.deepEqual(declared, needed);
});

test('package.json is not publishable and says which node it needs', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.main, undefined, 'there is no index.js for "main" to point at');
  assert.ok(pkg.engines?.node, 'engines.node is set');
});

// ---------------------------------------------------------------------------
// The Dockerfile's token guard

const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');

/** The guard's RUN instruction as one shell command, continuations joined. */
function guardCommand() {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => l.startsWith('RUN case "$VITE_MAPBOX_TOKEN"'));
  assert.ok(start >= 0, 'the Dockerfile has the token guard');
  const parts = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    parts.push(line.replace(/\\$/, ''));
    if (!line.endsWith('\\')) break;
  }
  return parts.join('\n').replace(/^RUN /, '');
}

function runGuard(env) {
  return spawnSync('sh', ['-c', guardCommand()], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('the image build refuses without a pk.* Mapbox token', () => {
  for (const token of [undefined, '', 'your_mapbox_token_here', 'sk.secret-scoped-token']) {
    const env = token === undefined ? {} : { VITE_MAPBOX_TOKEN: token };
    const result = runGuard({ ...env, VITE_GOOGLE_MAPS_KEY: 'test' });
    assert.notEqual(result.status, 0, `token ${JSON.stringify(token)} should fail the build`);
    assert.match(result.stderr, /ERROR: .*VITE_MAPBOX_TOKEN/);
  }
});

test('the image build only warns without the Google key, because Mapbox alone is a working map', () => {
  const without = runGuard({ VITE_MAPBOX_TOKEN: 'pk.test' });
  assert.equal(without.status, 0);
  assert.match(without.stderr, /WARNING: no VITE_GOOGLE_MAPS_KEY/);

  const withKey = runGuard({ VITE_MAPBOX_TOKEN: 'pk.test', VITE_GOOGLE_MAPS_KEY: 'test' });
  assert.equal(withKey.status, 0);
  assert.equal(withKey.stderr, '');
});

test('the guard runs before the build it guards, and keys are never baked into fly.toml', () => {
  assert.ok(dockerfile.indexOf('RUN case "$VITE_MAPBOX_TOKEN"') < dockerfile.indexOf('RUN npm run build'));
  const fly = readFileSync(path.join(root, 'fly.toml'), 'utf8');
  assert.doesNotMatch(fly, /^\s*\[build\.args\]/m);
  assert.doesNotMatch(fly, /^\s*VITE_/m);
});

// ---------------------------------------------------------------------------
// npm run deploy
//
// Run for real, as npm would — `sh -c <script>` — inside a scratch git repo,
// with `npm` and `fly` on PATH replaced by fakes that only record how they were
// called. Nothing here reaches Fly, and the keys are placeholders.

const deployScript = pkg.scripts.deploy;

function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'beavermaps-deploy-'));
  const bin = path.join(dir, '.fakebin');
  mkdirSync(bin);
  const log = path.join(dir, '.calls');
  const fake = (name) => {
    const file = path.join(bin, name);
    // One line per call, arguments separated by a unit separator so a value
    // with a space in it is visibly one argument.
    writeFileSync(file, `#!/bin/sh\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\037%s' "$a"; done; echo; } >> "${log}"\n` +
      (name === 'npm' ? 'exit "${FAKE_NPM_STATUS:-0}"\n' : 'exit 0\n'));
    chmodSync(file, 0o755);
  };
  fake('npm');
  fake('fly');

  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'server'));
  writeFileSync(path.join(dir, 'src', 'main.js'), 'export {};\n');
  writeFileSync(path.join(dir, 'server', 'index.js'), 'export {};\n');
  writeFileSync(path.join(dir, '.gitignore'), '.env\n.fakebin/\n.calls\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const deploy = (extraArgs = '', env = {}) => {
    // A clean environment: whatever VITE_* the test runner happens to have
    // must not leak in and stand in for a missing .env.
    const result = spawnSync('sh', ['-c', deployScript + extraArgs], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
      encoding: 'utf8',
    });
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\x1f'))
      : [];
    return { ...result, calls };
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, git, deploy, cleanup };
}

const PLACEHOLDER_ENV = 'VITE_MAPBOX_TOKEN=pk.placeholder-not-a-token\nVITE_GOOGLE_MAPS_KEY="placeholder key"\n';

test('deploy refuses a dirty tree before it runs anything', (t) => {
  const repo = scratchRepo();
  t.after(repo.cleanup);
  writeFileSync(path.join(repo.dir, '.env'), PLACEHOLDER_ENV);

  // Unstaged edit.
  writeFileSync(path.join(repo.dir, 'src', 'main.js'), 'export const x = 1;\n');
  let r = repo.deploy();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing/);
  assert.deepEqual(r.calls, []);

  // Staged edit.
  repo.git('add', 'src/main.js');
  r = repo.deploy();
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
  repo.git('commit', '-q', '-m', 'edit');

  // An untracked module in src/ — the case `git commit -a` silently leaves
  // behind while three committed files import it.
  writeFileSync(path.join(repo.dir, 'src', 'layer-order.js'), 'export {};\n');
  r = repo.deploy();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing/);
  assert.deepEqual(r.calls, []);
});

test('deploy refuses without a .env, or with a token the image build would reject', (t) => {
  const repo = scratchRepo();
  t.after(repo.cleanup);

  let r = repo.deploy();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no \.env/);
  assert.deepEqual(r.calls, []);

  writeFileSync(path.join(repo.dir, '.env'), 'VITE_MAPBOX_TOKEN=your_mapbox_token_here\n');
  r = repo.deploy();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pk\.\*/);
  assert.ok(!r.calls.some(([cmd]) => cmd === 'fly'), 'fly was not called');
});

test('deploy does not reach fly when the checks fail', (t) => {
  const repo = scratchRepo();
  t.after(repo.cleanup);
  writeFileSync(path.join(repo.dir, '.env'), PLACEHOLDER_ENV);

  const r = repo.deploy('', { FAKE_NPM_STATUS: '1' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, [['npm', 'run', 'check']]);
});

test('a clean, green deploy passes both keys from .env as build args', (t) => {
  const repo = scratchRepo();
  t.after(repo.cleanup);
  writeFileSync(path.join(repo.dir, '.env'), PLACEHOLDER_ENV);
  // Untracked files outside src/ and server/ are not what the guard is for.
  writeFileSync(path.join(repo.dir, 'notes.txt'), 'scratch\n');

  // npm appends `npm run deploy -- <args>` to the end of the script, so extra
  // flags land on fly deploy.
  const r = repo.deploy(' --remote-only');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    ['npm', 'run', 'check'],
    ['fly', 'deploy',
      '--build-arg', 'VITE_MAPBOX_TOKEN=pk.placeholder-not-a-token',
      '--build-arg', 'VITE_GOOGLE_MAPS_KEY=placeholder key',
      '--remote-only'],
  ]);
});
