// package.json and package-lock.json, read as data.
//
// Nothing that runs the app notices when these drift. A package imported but
// never declared resolves for as long as something else happens to hoist it to
// the top of node_modules, and stops the day that something changes its range.
// A lockfile with two copies of a library installs, builds and works while
// shipping both. So the checks have to be on the files themselves.

import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './helpers.js';

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** '@turf/helpers/dist/x' → '@turf/helpers'; 'express/lib' → 'express'. */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every .js and .mjs file under a directory, recursively. */
function sourcesIn(dir) {
  return readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * The packages a file imports: static `import … from '…'`, `export … from '…'`,
 * a bare `import '…'`, and `import('…')` with a literal argument — the flyover's
 * deck.gl modules are only ever loaded that last way. The static forms are
 * anchored to the start of a line so that a sentence in a comment or a JSON
 * string ("…from 'x'") is not read as an import.
 */
function packagesImportedBy(file) {
  const source = readFileSync(file, 'utf8');
  const specs = [
    ...source.matchAll(/^\s*(?:import|export)\s+(?:[\w\s{},*$]*?\bfrom\s*)?['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"]([@\w.][^'"]*)['"]\s*\)/g),
  ].map(([, spec]) => spec);
  return specs
    .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:')
      && !builtinModules.includes(s))
    .map(packageOf);
}

test('every package the code imports is declared in package.json, not borrowed from a hoisted transitive copy', () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const files = [
    ...['src', 'server', 'scripts', 'test'].flatMap(sourcesIn),
    path.join(root, 'vite.config.js'),
    path.join(root, 'eslint.config.js'),
  ];
  const missing = [];
  for (const file of files) {
    for (const name of packagesImportedBy(file)) {
      if (!declared.has(name)) missing.push(`${path.relative(root, file)} imports ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the import scan sees the dynamic imports it exists to check', () => {
  // A guard on the guard: if the regexes stopped matching `import('…')`, the
  // test above would pass on an empty list.
  const flyover = packagesImportedBy(path.join(root, 'src', 'flyover-view.js'));
  assert.ok(flyover.includes('@deck.gl/layers'), `flyover-view.js imports ${flyover.join(', ')}`);
  const roofs = packagesImportedBy(path.join(root, 'scripts', 'build-roofs.mjs'));
  assert.ok(roofs.includes('@math.gl/core') && roofs.includes('@math.gl/geospatial'),
    `build-roofs.mjs imports ${roofs.join(', ')}`);
});
