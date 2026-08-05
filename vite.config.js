import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
  server: {
    // Bind 0.0.0.0 so a tunnel (or another device on the LAN) can reach us.
    host: true,
    // Vite rejects requests whose Host header it does not recognise, which
    // otherwise makes every tunnel URL return "Blocked request".
    allowedHosts: [
      '.trycloudflare.com',
      '.ngrok-free.app',
      '.ngrok.io',
    ],
    proxy: {
      // Talk to the local routing server in dev without CORS. In production
      // the same Node process serves both dist/ and /api, so paths match.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
