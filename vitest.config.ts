import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the PWA plugin does real work at
// config time (manifest generation, workbox setup) that tests neither need nor
// benefit from.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Scheduling anchors due dates to the start of the local study day, so the
    // timezone has to be pinned or day-scale assertions drift with the machine.
    env: { TZ: 'UTC' },
  },
})
