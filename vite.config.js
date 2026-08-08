import { hostname } from 'node:os';
import { defineConfig } from 'vite';
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
 */
const LAN_HOST = `${hostname()}.local`.toLowerCase();

export default defineConfig({
  plugins: [
    tailwindcss(),
    // Spread rather than a falsy entry: Vite accepts `false` in the array, but
    // an unconditional basicSsl() would flip HTTPS on for plain `npm run dev`
    // too, since the plugin sets server.https from configResolved.
    ...(useHttps ? [basicSsl({ domains: [LAN_HOST] })] : []),
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
