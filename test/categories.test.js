// src/categories.js — which directory rows a chip on the strip answers with.
//
// The name patterns are written in plain ASCII and the directory is not: it
// spells "Oak Café and Bakery" with a precomposed é. A pattern that misses an
// accent still renders a chip that presses and lists something, so the gap
// is invisible unless a test names the row it should have found.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import { CATEGORY_BY_ID, collect } from '../src/categories.js';

test('Food & drink includes the bakery spelt with an accent', () => {
  const names = collect(CATEGORY_BY_ID.get('food'), {
    amenities: load('amenities'),
    places: load('places'),
  }).map((hit) => hit.name);
  assert.ok(names.includes('Oak Café and Bakery'), `food found only ${[...new Set(names)].join(', ')}`);
  assert.ok(names.some((n) => /^Cafeteria/.test(n)));
  assert.ok(names.includes('Evangelisti Culinary Arts Center'));
});

test('a category pattern matches the name however its accents are encoded', () => {
  const food = CATEGORY_BY_ID.get('food');
  // Precomposed and decomposed é, and the plain spelling someone would type.
  assert.ok(food.match('Oak Café and Bakery'));
  assert.ok(food.match('Oak Café and Bakery'));
  assert.ok(food.match('Oak Cafe and Bakery'));
  assert.ok(!food.match('Oak Grove'));
});
