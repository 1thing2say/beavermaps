// server/headers.js — what the page may load, and what it may ask for.
//
// The policy is Report-Only, so a host missing from it costs a console line
// rather than the flyover. These tests are what stands between that and the
// day somebody switches it to enforcing: every host the source reaches for has
// to be on it, and the inline scripts have to be hashed the way a browser
// hashes them or the hashes match nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  inlineScriptHashes, contentSecurityPolicy, SOURCES, PERMISSIONS_POLICY, STRICT_TRANSPORT_SECURITY,
} from '../server/headers.js';
import { root } from './helpers.js';

const sha = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** The policy as { directive: [sources] }. */
function parse(policy) {
  return Object.fromEntries(policy.split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values];
  }));
}

test('an inline script is hashed byte for byte, whitespace included', () => {
  const body = '\n    (function () { document.documentElement.dataset.theme = "dark"; }());\n  ';
  assert.deepEqual(inlineScriptHashes(`<head><script>${body}</script></head>`), [sha(body)]);
  // A trimmed copy hashes differently, which is exactly why it is not trimmed.
  assert.notEqual(sha(body), sha(body.trim()));
});

test('a script with a src is allowed by origin, not by hash', () => {
  const html = '<script type="module" crossorigin src="/assets/index-abc.js"></script>'
    + '<script>one()</script><SCRIPT data-x="1">two()</SCRIPT>';
  assert.deepEqual(inlineScriptHashes(html), [sha('one()'), sha('two()')]);
});

test('the hashes for index.html match the scripts in it', () => {
  // The source file, not dist/: the build copies these blocks through byte for
  // byte, and the source is what a clean checkout has.
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1, 'index.html has inline scripts and this found none');
  assert.deepEqual(inlineScriptHashes(html), inline.map(sha));
});

test('every https host the front-end names is allowed to be fetched', () => {
  // Read off the source rather than listed by hand, which is the point: a new
  // provider URL in src/ without a line in SOURCES fails here, not in a
  // visitor's console.
  const connect = parse(contentSecurityPolicy())['connect-src'];
  const allowed = (host) => connect.some((src) => {
    if (!src.startsWith('https://')) return false;
    const pattern = src.slice('https://'.length);
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
  const srcDir = path.join(root, 'src');
  const hosts = new Set();
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(path.join(srcDir, name), 'utf8');
    for (const [, host] of code.matchAll(/['"`]https:\/\/([a-z0-9.-]+)/gi)) hosts.add(host);
    // basemap-problem.js names Mapbox's API host bare, to compare against.
    for (const [, host] of code.matchAll(/['"`]((?:api|events)\.mapbox\.com)['"`]/g)) hosts.add(host);
  }
  assert.ok(hosts.size > 0, 'found no hosts at all — the scan is broken, not the policy');
  for (const host of hosts) assert.ok(allowed(host), `${host} is fetched by src/ and not in connect-src`);
});

test('the flyover\'s loaders.gl worker and its Draco decoder are allowed', () => {
  const policy = parse(contentSecurityPolicy());
  for (const host of SOURCES.loaders) {
    assert.ok(policy['script-src'].includes(host), `${host} missing from script-src`);
    assert.ok(policy['connect-src'].includes(host), `${host} missing from connect-src`);
  }
  assert.ok(policy['worker-src'].includes('blob:'));
  assert.ok(policy['script-src'].includes("'wasm-unsafe-eval'"));
  assert.ok(!policy['script-src'].includes("'unsafe-eval'"));
  assert.ok(!policy['script-src'].includes("'unsafe-inline'"));
  assert.ok(policy['img-src'].includes('data:') && policy['img-src'].includes('blob:'));
  assert.ok(policy['style-src'].includes("'unsafe-inline'"));
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
});

test('the permissions and transport headers say what they mean', () => {
  assert.match(PERMISSIONS_POLICY, /geolocation=\(self\)/);
  for (const feature of ['camera', 'microphone', 'payment', 'usb']) {
    assert.match(PERMISSIONS_POLICY, new RegExp(`${feature}=\\(\\)`));
  }
  // No includeSubDomains until the domain is final: HSTS is a promise browsers
  // keep for the whole max-age.
  assert.equal(STRICT_TRANSPORT_SECURITY, 'max-age=31536000');
});
