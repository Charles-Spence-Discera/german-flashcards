import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages project sites serve from https://<user>.github.io/<repo>/, never the
// domain root. Every asset URL, the manifest `start_url`/`scope`, and the service
// worker registration scope are derived from this one constant. Change it here and
// nowhere else if the repo is ever renamed.
const BASE = '/german-flashcards/'

export default defineConfig({
  base: BASE,
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        id: BASE,
        name: 'German Flashcards',
        short_name: 'Vokabeln',
        description: 'Spaced-repetition review for German vocabulary.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#10131a',
        theme_color: '#10131a',
        lang: 'de',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: `${BASE}index.html`,
        runtimeCaching: [
          {
            // The vocab file must pick up newly added cards whenever the phone has a
            // connection, but still resolve from cache on the train. Network first
            // with a short timeout gives fresh data online and offline tolerance.
            urlPattern: ({ url }) => url.pathname.endsWith('/data/vocab.json'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'vocab-data',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
})
