import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { defineConfig } from 'vite';
import compression from 'compression';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Browsers gate geolocation behind a secure context, and `localhost` is the one
 * plain-HTTP origin exempt from that rule. So plain HTTP never notices — but
 * the Network URL Vite prints is a bare LAN IP, and opening that on a phone
 * leaves the GeolocateControl in src/main.js silently dead: no prompt, no blue
 * dot, no error to read.
 *
 * `npm run dev` therefore sets HTTPS=1 and serves the site over TLS, so a phone
 * counts as secure. The price is a self-signed certificate, which buys
 * localhost nothing it did not already have and costs a warning on every
 * reload there; `npm run dev:http` is the way back to plain HTTP when only
 * localhost matters.
 */
const useHttps = process.env.HTTPS === '1';

/**
 * Reach the HTTPS dev server by this name, not by the LAN IP.
 *
 * basic-ssl hardcodes its IP entries (127.0.0.1, fe80::1) and maps everything
 * passed through `domains` to a DNS-type SAN, so no option it exposes can make
 * a certificate valid for https://192.168.64.10 — an IP URL needs an IP SAN.
 * A name can be a DNS SAN, and avahi already publishes this one over mDNS
 * (verified resolving to the LAN address), which iOS and macOS speak natively.
 *
 * Lower-cased because Vite compares Host headers to allowedHosts as exact
 * strings, and browsers send the header lower-cased.
 *
 * The suffix is stripped before it is re-added because os.hostname() does not
 * promise a short name: on a Mac whose Sharing name has been set it answers
 * "MacBook-Pro.local" already, and appending blindly asks avahi for
 * macbook-pro.local.local — a name nothing resolves, so the certificate is
 * issued for it, allowedHosts lists it, and the real https://<host>.local URL
 * is refused with "Blocked request" by the very config meant to allow it.
 *
 * On macOS os.hostname() is not the mDNS name at all: it is whatever DNS or
 * DHCP last called the machine ("Mac.lan" on a home router), while Bonjour
 * advertises LocalHostName ("MacBook-Pro" → macbook-pro.local). So on a Mac,
 * ask scutil for the name Bonjour actually publishes, and fall back to
 * hostname() only where that is unavailable.
 */
function mdnsName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
      if (name) return name;
    } catch { /* LocalHostName unset — fall through */ }
  }
  return hostname().replace(/\.local$/i, '');
}
const LAN_HOST = `${mdnsName()}.local`.toLowerCase();

/**
 * Gzip what the dev server sends, which matters here far more than it sounds.
 *
 * Vite dev serves every module unbundled and with its sourcemap inlined as
 * base64, and the map is the bulk of it: src/main.js goes out as 1,653 KB, of
 * which 1,347 KB is the map. Base64 is about the most compressible payload
 * there is, so that one file drops to 321 KB — the whole page went 4,826 KB to
 * roughly a fifth of that. Nothing was compressed before this: measured on the
 * wire, every dev module came back with encodedBodySize equal to
 * decodedBodySize.
 *
 * It only shows up on a phone. Over localhost the bytes are free and this is
 * pure overhead; over `npm run dev` on the LAN it is the difference
 * between a map that appears and one you wait for — and the LAN is the whole
 * point of HTTPS in dev, since a phone needs a secure context for geolocation.
 *
 * PER REQUEST RATHER THAN CACHED, deliberately, which is the opposite of the
 * choice server/wire.js makes for the API payloads. Those are constants read
 * once at boot; these are transformed on demand and change under HMR every time
 * a file is saved, so a cache keyed on anything would be a staleness bug in
 * exchange for CPU that a single developer's laptop is not short of.
 *
 * `text/event-stream` is excluded because that is how Vite pushes HMR updates
 * to the client. Buffering a stream that exists to deliver events the moment
 * they happen breaks it — the updates arrive when the buffer flushes, or not at
 * all.
 */
function devCompression() {
  return {
    name: 'beavermaps-dev-compression',
    apply: 'serve',
    configureServer(server) {
      const gzip = compression({
        filter: (req, res) => {
          const type = res.getHeader('Content-Type') ?? '';
          if (String(type).includes('text/event-stream')) return false;
          return compression.filter(req, res);
        },
      });
      // Before Vite's own middlewares rather than after, so the wrapper is
      // around the response by the time anything writes to it.
      server.middlewares.use(gzip);
    },
  };
}

/**
 * Strip index.html's comments from the page that ships, and only from that one.
 *
 * index.html documents itself the way the rest of this codebase does, in long
 * notes about WHY a meta tag or a wrapper div is there, and those notes are
 * most of the file: measured at 64.6 KB built, 17.1 KB gzipped, against 4.5 KB
 * gzipped once they are gone. Every visitor downloaded the essay on every cold
 * load, ahead of the bundle that actually draws the map, and the page is served
 * `no-cache` (see server/wire.js) so it is revalidated rather than remembered.
 *
 * `apply: 'build'` because the comments are FOR the source: `npm run dev`
 * serves index.html as written so view-source still explains itself, and only
 * the copy in dist/ is cut down.
 *
 * `enforce: 'post'` so this runs after Vite has rewritten the page — the script
 * and stylesheet tags it injects are already in the string and nothing it adds
 * later can bring a comment back.
 *
 * Conditional comments (`<!--[if IE]>`) are kept, because they are the one kind
 * a browser reads as markup rather than as prose. There are none in this page
 * today; the exception is there so a future one is not silently deleted. Blank
 * lines left behind are folded to one so the output is not a column of gaps.
 *
 * Nothing in this page puts `<!--` inside a <script> or a string, which is the
 * one case a regex over raw HTML would get wrong — and the build test in
 * test/html-shell.test.js runs this over the real index.html and checks that
 * the scripts, the theme bootstraps and every id the app looks up survive.
 */
export function stripHtmlComments() {
  return {
    name: 'beavermaps-strip-html-comments',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: (html) => html
      .replace(/<!--(?!\s*\[if)[\s\S]*?-->/g, '')
      .replace(/\n[ \t]*\n+/g, '\n'),
  };
}

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        /**
         * mapbox-gl in a chunk of its own, apart from the app.
         *
         * Left to itself the bundler put the library and this app's code in one
         * index-*.js, about 552 KB gzipped, of which this app is roughly 76 KB.
         * The file name is a hash of the whole chunk, so every deploy that
         * touched one line of src/ renamed it and every returning visitor
         * downloaded half a megabyte of map renderer they already had. Split
         * out, the library's chunk keeps its hash until the dependency itself
         * is upgraded, and a deploy costs a returning visitor the app's share.
         *
         * Only mapbox-gl, deliberately. deck.gl and loaders.gl are already their
         * own chunks because src/flyover-view.js loads them with a dynamic
         * import(), and grouping those here would pull them back into the
         * entry's static graph — the opposite of what that import is for.
         *
         * AND ONLY ITS JAVASCRIPT. The obvious test, /node_modules\/mapbox-gl/,
         * also catches mapbox-gl.css, which main.js imports — and a CSS module
         * in a group becomes that group's own stylesheet, linked from the page
         * AHEAD of the app's. In one bundle it came after src/input.css, so the
         * library's rules won every tie of specificity; split out, the order
         * flipped and the app's won instead. Same selectors, a different page,
         * and dev (where the import is injected after the <link>) would have
         * disagreed with production about it. Matching only .js/.mjs/.cjs leaves
         * the stylesheet where it was: the built CSS is byte-for-byte what it
         * was before this group existed.
         */
        codeSplitting: {
          groups: [
            { name: 'mapbox-gl', test: /node_modules[\\/]mapbox-gl[\\/].*\.[cm]?js$/ },
          ],
        },
      },
    },
  },
  plugins: [
    devCompression(),
    stripHtmlComments(),
    tailwindcss(),
    // Spread rather than a falsy entry: Vite accepts `false` in the array, but
    // an unconditional basicSsl() would flip HTTPS on for `npm run dev:http`
    // too, since the plugin sets server.https from configResolved.
    //
    // certDir is keyed on the name because the plugin's cache is only
    // invalidated by expiry — it reads node_modules/.vite/basic-ssl/_cert.pem
    // and hands it back without ever comparing the domains it was asked for.
    // So the certificate outlives the name it was issued for: rename the Mac,
    // fix this config, and the phone still gets last month's SAN and a warning
    // that cannot be clicked past on iOS. A per-host directory makes a changed
    // name a cache miss, which is what the plugin should have done itself.
    ...(useHttps ? [basicSsl({
      domains: [LAN_HOST],
      certDir: `node_modules/.vite/basic-ssl-${LAN_HOST}`,
    })] : []),
  ],
  server: {
    // Bind 0.0.0.0 so a tunnel (or another device on the LAN) can reach us.
    host: true,
    // Vite rejects requests whose Host header it does not recognise, which
    // otherwise makes every tunnel URL return "Blocked request". Raw IPs and
    // localhost are allowed unconditionally by Vite itself; an mDNS .local name
    // is not, so it has to be listed or the HTTPS URL above is refused.
    allowedHosts: [
      LAN_HOST,
      '.trycloudflare.com',
      '.ngrok-free.app',
      '.ngrok.io',
    ],
    proxy: {
      // Talk to the local routing server in dev without CORS. In production
      // the same Node process serves both dist/ and /api, so paths match.
      // Stays http even under `npm run dev` — the browser's TLS terminates at Vite
      // and this hop never leaves the machine, so there is no mixed content.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
