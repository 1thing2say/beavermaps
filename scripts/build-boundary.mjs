/**
 * Fetch the campus outline and write src/campus-boundary.json.
 *
 * This is the one piece of geometry here that does NOT come from my campus. The app
 * needs a polygon to mask Mapbox's own data inside, and the polygon Mapbox
 * itself draws the campus from is OpenStreetMap's `amenity=college` way. Using
 * that exact way means our mask lands on their edge rather than a millimetre
 * inside or outside it, which is the difference between a clean cut and a
 * visible halo of leftover basemap.
 *
 * A convex hull of our own network was the obvious alternative and is wrong:
 * the campus is L-shaped around the north-east corner, so a hull swallows
 * College Oak Dr and the neighbouring streets, and those must keep their
 * Mapbox data. The OSM way contains 99.3% of our network vertices as drawn.
 *
 * Attribution: ODbL, already covered by the OpenStreetMap credit Mapbox
 * renders in the corner.
 *
 * Run: node scripts/build-boundary.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { overpass } from './overpass.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../src/campus-boundary.json');

// Bounding box is generous; the query is filtered by tag, not by extent.
const QUERY = `[out:json][timeout:60];
way["amenity"="college"](38.6420,-121.3560,38.6570,-121.3390);
out geom;`;

const { elements } = await overpass(QUERY);
const campus = elements.find((w) => w.tags?.name?.includes('my campus'));
if (!campus) throw new Error('no way tagged as my campus came back');

// Overpass returns the ring already closed. GeoJSON requires that too, so only
// close it if it somehow is not — duplicating the point would be invalid.
const ring = campus.geometry.map((p) => [
  Number(p.lon.toFixed(7)),
  Number(p.lat.toFixed(7)),
]);
const first = ring[0];
const last = ring[ring.length - 1];
if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);

const feature = {
  type: 'Feature',
  properties: { name: campus.tags.name, source: `OSM way/${campus.id}` },
  geometry: { type: 'Polygon', coordinates: [ring] },
};

writeFileSync(OUT, `${JSON.stringify(feature, null, 1)}\n`);

const lon = ring.map((c) => c[0]);
const lat = ring.map((c) => c[1]);
console.log(
  `[boundary] OSM way/${campus.id}, ${ring.length} points\n` +
  `           bbox ${Math.min(...lon).toFixed(6)}, ${Math.min(...lat).toFixed(6)}` +
  ` .. ${Math.max(...lon).toFixed(6)}, ${Math.max(...lat).toFixed(6)}`
);
