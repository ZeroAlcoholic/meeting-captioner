import { defineConfig, devices } from '@playwright/test';

/** Capture run, not a regression: one worker, no retries, real wall-clock timings. */
export default defineConfig({
  testDir: '.',
  testMatch: 'caption-eval.spec.ts',
  globalSetup: './pure-captions-server.ts',
  workers: 1,
  timeout: 30 * 60_000,
  retries: 0,
  forbidOnly: true,
  outputDir: '../../.cache/caption-eval-results',
  use: { ...devices['Desktop Chrome'], channel: 'chrome', trace: 'off', screenshot: 'off' },
});
