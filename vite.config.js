import { hostname } from 'node:os';
import { defineConfig } from 'vite';
import compression from 'compression';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Browsers gate geolocation behind a secure context, and `localhost` is the one
 * plain-HTTP origin exempt from that rule. So `npm run dev` never notices — but
 * the Network URL Vite prints is a bare LAN IP, and opening that on a phone
 * leaves the GeolocateControl in src/main.js silently dead: no prompt, no blue
 * dot, no error to read.
 *
 * `npm run dev:https` serves the same site over TLS so a phone counts as
 * secure. Opt-in rather than always-on, because a self-signed certificate buys
 * localhost nothing it did not already have and costs a warning on every
 * reload.
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
 */
const LAN_HOST = `${hostname().replace(/\.local$/i, '')}.local`.toLowerCase();

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
 * pure overhead; over `npm run dev:https` on the LAN it is the difference
 * between a map that appears and one you wait for — and the LAN is the whole
 * point of dev:https, since a phone needs a secure context for geolocation.
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
    name: 'mapper-dev-compression',
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

export default defineConfig({
  plugins: [
    devCompression(),
    tailwindcss(),
    // Spread rather than a falsy entry: Vite accepts `false` in the array, but
    // an unconditional basicSsl() would flip HTTPS on for plain `npm run dev`
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
      // Stays http even under dev:https — the browser's TLS terminates at Vite
      // and this hop never leaves the machine, so there is no mixed content.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
