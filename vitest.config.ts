import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The chain-backed tests are opt-in: set CPF_LIVE_ENS=1 (plus .env) to run them.
    // By default the whole suite is hermetic — no RPC, no wallet, no API keys.
    testTimeout: 20_000,
  },
})