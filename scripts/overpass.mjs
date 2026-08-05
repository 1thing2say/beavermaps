/**
 * Minimal Overpass client, shared by the scripts that need OpenStreetMap data.
 *
 * Two things about the public instance are worth knowing, because both look
 * like bugs in your query rather than transport problems:
 *
 *   - It answers 406 to any request without a User-Agent, no matter what the
 *     body says. The header is required, not polite.
 *   - 504s are just the instance being busy and are worth retrying. A 4xx never
 *     is, so those fail immediately rather than burning four attempts.
 */
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'mapper-build/1.0 (campus wayfinding)';

export async function overpass(query, { attempts = 6 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'User-Agent': UA },
      body: new URLSearchParams({ data: query }),
    });
    if (response.ok) return response.json();
    if (response.status < 500) {
      throw new Error(`Overpass returned ${response.status}`);
    }
    if (attempt === attempts) {
      throw new Error(`Overpass returned ${response.status} after ${attempts} attempts`);
    }
    const wait = 10000 * attempt;
    console.log(`[overpass] ${response.status}, retrying in ${wait / 1000}s…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error('unreachable');
}
